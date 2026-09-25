# AI Companion Architecture

Local personal WhatsApp and LINE gateway. Phone sessions stay on this machine.
The packaged Bun sidecar binds `127.0.0.1:38888` and serves REST under `/api/v1/im/*`;
`scripts/run.sh` binds `127.0.0.1:38000` and reuses the installed app's data dir when it
exists, so one linked session serves both builds. Only one backend may run at a time.
There is no admin username/password account.

This app does not import `sm3/` or `frontend/` packages. Cloud integration is a
generic reverse WebSocket described in [CloudServer.md](CloudServer.md).

## Process

```
Tauri (package/)  →  bun sidecar (backend/)  →  Baileys WhatsApp socket
                                           →  LINEJS LINE session
                  →  webview http://127.0.0.1:38888  (frontend/)
```

- Bind: `127.0.0.1` only.
- Token: first boot writes `data/config.json`. Header `Authorization: Bearer <token>` on every `/api/v1/im/*` route except `GET /api/v1/im/health`.
- Access: localhost only. Other computers cannot call the API unless the bind address,
  firewall, and authentication model are deliberately changed.
- Data: `COMPANION_DATA_DIR` or `companion/data` (packaged / default). Installed app uses Application Support. `scripts/run.sh` uses `COMPANION_DATA_DIR` when set, else the Application Support dir when it exists, else `companion/data-dev`.
- Frontend files: `COMPANION_FRONTEND_DIR`, else `companion/frontend/dist` when built, else `companion/frontend`. Dev Vite is `:5178` and proxies `/api` to `:38000`.

## Files

| Path | Role |
|---|---|
| `backend/src/index.ts` | Listen, restore enabled sessions |
| `backend/src/app.ts` | Hono routes and bearer middleware |
| `backend/src/manager.ts` | Connection lifecycle, metrics, reconnect |
| `backend/src/channel.ts` | Shared session contract (`whatsapp` \| `line`) |
| `backend/src/whatsapp.ts` | Only Baileys import |
| `backend/src/line.ts` | Only `@evex/linejs` import |
| `backend/src/store.ts` | `data/whatsapp` and `data/line` files |
| `backend/src/messages.ts` | SQLite `ChatMessage` history (7 days) and the delivery queue |
| `backend/src/media/sha.ts` | SHA-256 dialects, canonicalized to one identity |
| `backend/src/media/store.ts` | SQLite `MediaObject` / `MediaUrl` meta + the blob folder |
| `backend/src/media/cache.ts` | One connection's view of the cache; Baileys' `mediaCache` |
| `backend/src/media/outbound.ts` | Which cached media source an outbound send should use |
| `backend/src/log.ts` | Structured JSON logging with binary-value redaction |
| `backend/src/cloud/protocol.ts` | Channel-agnostic WSS frames |
| `backend/src/cloud/link.ts` | Per-connection outbound WSS client |
| `backend/src/cloud/queue.ts` | Per-direction serial delivery worker (both directions) |
| `backend/src/webhook.ts` | Outbound POST, 10s timeout, 3 tries |

| `backend/src/disconnect.ts` | Close-code map (401/440/405/515/500) |

## Disk

```
data/config.json
data/whatsapp/index.json
data/whatsapp/{id}/meta.json
data/whatsapp/{id}/auth/          # Baileys useMultiFileAuthState
data/line/index.json
data/line/{id}/meta.json
data/line/{id}/auth/storage.json  # LINEJS FileStorage (E2EE keys)
data/line/{id}/auth/token         # LINE auth token; never logged
data/messages.sqlite              # ChatMessage: history log + durable delivery queue
data/media.sqlite                 # MediaObject / MediaUrl: the media cache meta
data/media/{sha256}.{ext}         # cached plaintext, content-addressed
```

Inbound and outbound chat is stored in SQLite table `"ChatMessage"` for 7 days. Prune runs at boot and every 24 hours. Dashboard Received/Sent counters stay as lifetime totals in `meta.json`: Received increments on every vendor inbound message, Sent increments on every outbound queue write — a dashboard `POST /connection/:id/message` and a cloud `sendMessage`/`sendCompactMessage` invoke alike.

`data/media.sqlite` and `data/media/` are the media cache, deliberately separate from
`messages.sqlite`: the cache is regenerable, so clearing it is
`rm -rf data/media data/media.sqlite` and can never touch a queued message. See
[Media cache](CloudServer.md#media-cache) for the wire contract.

## Media cache

The session runs on this laptop, so the same bytes cross it twice: inbound WhatsApp media is
decrypted from the CDN, and outbound cloud media is fetched from object storage and
re-encrypted up to WhatsApp. A repeat costs nothing instead.

- Plaintext is stored content-addressed under `data/media/{sha256}.{ext}`, so one file has one
  file on disk. Meta — length, mime, the encoded proto, and every url that points at the
  content — lives in `media.sqlite` tables `"MediaObject"` and `"MediaUrl"`.
- Rows are scoped per connection, so a url learned on one linked account is never handed to
  another. The blob folder is shared, because a file named by its own digest is the same file
  whoever fetched it.
- WhatsApp’s `fileSha256` is the inbound key, so a repeat is recognised **before** anything is
  fetched and served from cache (a fresh url, a re-upload, or inline bytes).
- The received media proto is kept too, not only the bytes. It still points at WhatsApp’s blob
  and still carries its `mediaKey`, so a reply naming that digest references the copy WhatsApp
  already holds: no download, no upload. Outbound, the cloud’s `sha256` hint or the url
  identifies the content, and Baileys’ own `mediaCache` is handed the stored proto.
- A stored proto carries the expiry WhatsApp declared for its blob — the `oe` parameter of the
  CDN url, falling back to `mediaKeyTimestamp` plus the observed lifetime. Past it the proto is
  a miss and the send re-uploads from the local plaintext, which still costs no download; a
  proto that declared no expiry keeps a conservative 24 hours.
- Content flows both ways through the single digest key: media the bot sent and the user
  echoes back is the same cache entry.
- A digest that disagrees with its bytes is discarded — the bytes win and the mismatch is
  logged — because a wrong digest would let one file’s bytes answer for another’s.
- Objects retire after a year of disuse — long enough to outlive the blob they point at — and
  the cache is capped at 2,000 objects / 512 MB, evicted least-recently-used first. Prune runs
  at boot and hourly.

## Message queue

`"ChatMessage"` is both the history log and the delivery queue. A message is
written before any network call and a worker advances it afterwards, so nothing
is lost while the cloud link or the phone session is down.

- `direction` picks the queue: `in` is forwarded to the cloud WSS as an `event`
  frame, `out` is delivered to the phone/LINE session.
- One worker per connection **and direction**, so a stalled outbound drain never
  blocks inbound. Each worker sends strictly in insert order.
- `status`: `pending` (queued), `sent`, `failed` (terminal), `na` (history only —
  no cloud link configured, or a row written before an upgrade).
- `message_id` is the id handed to the caller: the vendor id when we have one,
  else a generated uuid v7. `provider_id` is filled in when delivery returns one.
- `error_count` / `last_error` record delivery failures.

Failure rules, identical in both directions:

| Outcome | Result |
| --- | --- |
| Destination offline (link down, phone not connected) | Waits. No attempt is counted. |
| Transport error (write failed, socket closed, timeout) | `error_count + 1`, stays `pending`, retried. |
| Real error (cloud `4401`; a structured vendor rejection) | `failed`. Never resent. |
| 3 attempts, or older than 1 hour (`created_at`) | `failed`. Never sent. |

Workers are woken by the events that make delivery possible — the cloud link's
`hello`, or the phone session connecting — with a 15s tick as a safety net that
also retires expired rows.

`POST /connection/:id/message` and a cloud `invoke sendMessage` /
`sendCompactMessage` therefore succeed even when the phone is offline: they queue
the send and answer immediately. A queued `invoke` is acked with a
Companion-generated id (WhatsApp callers read `key.id`), so the real vendor id is
not known to the cloud. `readMessages`, `sendPresenceUpdate`, and `relayMessage`
are not messages and still run inline.

## REST

| Method | Path |
|---|---|
| GET | `/api/v1/im/health` |
| GET | `/api/v1/im/connection.json` |
| POST | `/api/v1/im/connection.json` |
| GET | `/api/v1/im/connection/:id.json` |
| DELETE | `/api/v1/im/connection/:id.json` |
| POST | `/api/v1/im/connection/:id/enable.json` |
| POST | `/api/v1/im/connection/:id/disable.json` |
| GET | `/api/v1/im/connection/:id/qr.json` |
| POST | `/api/v1/im/connection/:id/message.json` |
| GET | `/api/v1/im/connection/:id/messages.json` |
| GET | `/api/v1/im/connection/:id/messages/:messageId.json` |
| POST | `/api/v1/im/replay.json` |
| PUT | `/api/v1/im/connection/:id.json` |
| PUT | `/api/v1/im/connection/:id/webhook.json` |
| PUT | `/api/v1/im/connection/:id/cloud.json` |

Every JSON route carries the repo's `.json` suffix on its last path segment;
`GET /api/v1/im/health` is the one exception, because the SPA and packaged probe
read it before they have a token.

Routing follows SM3 (`kanban.routes.ts`): a static leaf segment keeps `.json`
inline and its plain `:id` param stays clean (`/connection/:id/qr.json`), while a
route whose **last** segment is the id uses the `:id{.+\\.json}` capture and the
handler strips the suffix with `stripFormatSuffix`. Those greedy captures are
registered **after** every static leaf, or `:id` would swallow `home/qr` first.

`POST /connection.json` body: `{ "channel": "whatsapp" | "line", "id"?, "name"? }`. `channel` defaults to `whatsapp`.

`PUT /connection/:id.json` body: `{ "name": "…" }` (1–64 characters). The id does not change.

`PUT /connection/:id/webhook.json` body: `{ "url": "https://…", "token": "…" }` or `{ "url": null }` to clear.
`token` is required whenever `url` is set; every webhook POST carries it as `Authorization: Bearer <token>`.

`PUT /connection/:id/cloud.json` body: `{ "url": "wss://…" | "ws://…", "token": "…" }` or `{ "url": null }` to clear.
Each connection stores `cloudUrl` / `cloudToken` on the same index as `webhookUrl` and dials its own WebSocket. See [CloudServer.md](CloudServer.md).

`GET /qr.json` returns `{ "qr": "…" | null, "pin": "…" | null }`. `pin` is set only while linking LINE.

`GET /messages.json?direction=all|in|out&type=text&status=failed&page=1&limit=10` lists the last 7 days, newest first. Every filter is optional and they combine: `direction` defaults to `all` (both directions merged), `type` is an exact message type, and `status` is one of `na` / `pending` / `sent` / `failed`. `total` counts the filtered set. An unknown `direction` or `status` is a 400. `GET /messages/:messageId.json` returns metadata plus `rawIn` / `rawOut` JSON. Both carry `messageId`, `status`, and `errorCount`.

`POST /message.json` body: `{ "to": "…", "text": "…" }`. The send is queued and answered immediately as `{ "id": "<messageId>", "to": "…", "status": "pending" }` — it does not wait for the phone, so it no longer answers 409 when the session is offline.

WhatsApp `to` is digits with country code. LINE `to` is a mid (for example `u…`) and is not stripped.

`POST /replay.json` is a debug helper for the cloud pipe and is deliberately not connection-scoped: both ids travel in the body as `{ "connectionId": "…", "messageId": 1 }`. It re-frames a received row's stored payload exactly as the worker forwarded it the first time (`messages.upsert` for WhatsApp, `message` for LINE) and writes it straight onto the open cloud link. It is **not** a retry: nothing is re-queued and the row's `status`, `error_count` and `last_error` are untouched, so the cloud simply receives the same event again. Only `direction: "in"` rows can be replayed, and it answers `{ "ok": true, "messageId": "…", "name": "messages.upsert", "userId": "…" }`. Errors: `400 INVALID_PARAM` (missing `connectionId`, or a `messageId` that is not a positive integer), `404 NOT_FOUND` (unknown connection or message), `409 INVALID_STATE` (the row is outbound, or it has no stored payload), `409 NOT_CONNECTED` (the cloud link is not open).

Connection views expose `phone` as the account id (WhatsApp number or LINE mid) and `user` as the display name when the channel provides one.

Errors: `{ "error": "NOT_FOUND", "message": "…" }` with 400 / 401 / 404 / 409 / 500.

Inbound webhook body:

```json
{ "connectionId": "home", "channel": "whatsapp", "id": "…", "from": "6591…", "to": "6591…", "text": "…", "timestamp": 0, "type": "text" }
```

## WhatsApp

- QR pairing via `connection.update.qr`.
- `515` restartRequired reopens saved creds (cap 3).
- `401` logout / `440` replaced: disable, do not loop.
- Delete: `logout()` with a 5s cap, then remove the folder.
- Boot: restore every `enabled` row.
- Incoming messages with a provider id are stored in `"ChatMessage"` history using
  `type` values such as `text`, `image`, `video`, `audio`, `document`, `sticker`,
  or `unknown`. Raw Baileys JSON is retained; binary values are summarized in logs.
- Skip `fromMe` and `status@broadcast`.
- `messages.upsert` events, sends, send failures, unsupported messages, and processing
  errors are logged with `[companion][websocket]` prefixes.

## LINE

LINEJS (`@evex/linejs`) is an unofficial personal-account client. Not the Official Account Messaging API.

- First link: `loginWithQR` with device `ANDROIDSECONDARY`. LINEJS gives a URL; the UI renders the QR. Then show the PIN for the LINE app.
- Restore: `loginWithAuthToken` plus the same `FileStorage` file (E2EE keys). Do not repeat QR login when a token exists.
- Listen: `client.listen({ talk: true, square: false })`. Incoming messages with a
  provider id are stored using their LINE content type; unknown types are retained as
  `unknown`. Skip own sends.
- Send: `client.sendCompactMessage(to, text)`.
- Unlink: abort listen and delete `data/line/{id}/`.

## Logging

- HTTP request and response JSON is logged with `[companion][http]` prefixes.
- Outbound webhook JSON and webhook responses are logged.
- The dashboard polling endpoints `GET /api/v1/im/health` and
  `GET /api/v1/im/connection.json` are intentionally not logged.
- `Uint8Array` values are logged as byte counts rather than base64 payloads.
- Errors use `console.error` with the original error object so the stack trace is
  printed.

## Bruno

Cases live in the shared workspace `spec/bruno/SM/collections/companion/` — the `im` folder inside the `companion` collection.

- `api/` catalog with sample 200 bodies.
- `test/` contract cases (`bru run im/test -r --env-file ../../environments/dev-companion.yml`). No live scan.

## Mac

Tauri 2 in `package/`: tray hide-on-close, start at login, spawn sidecar if `:38888` is down.
