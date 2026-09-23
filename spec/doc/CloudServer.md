# Cloud Server contract

AI Companion is a local IM sidecar. The laptop has no public port, so a cloud
product cannot HTTP-call it. Companion is the **WebSocket client**: it dials a
URL you configure per connection and keeps that socket open.

This file is the wire contract. It has no product-specific types. A third-party
server implements the endpoint described here; Companion does not hard-code a
path or hostname.

The **envelope is channel-agnostic**. `channel` is an opaque string (`whatsapp`,
`line`, later others). Vendor payloads live only in `data`. Adding a channel does
not change the envelope.

## What you must expose

One WebSocket URL. Companion stores it next to an optional HTTP webhook:

```
PUT /api/v1/im/connection/:id/cloud
{ "url": "wss://example.com/v1/companion", "token": "…" }
```

`url: null` clears the link and closes the socket. Path is yours.
`ws:` is allowed only for local development.

- **Required:** `GET` that URL with `Upgrade: websocket`. Authenticate on the handshake.
- **Not required:** an HTTP API that issues tokens (give Companion `url` + `token` however you like).
- **Not required:** an HTTP inbound webhook from Companion. Inbound rides this socket.
- **Impossible:** HTTP from your cloud to the laptop. Use `invoke` frames.

## Handshake

1. Companion connects with `Authorization: Bearer <token>`.
2. Do not put the token in the query string (it leaks in access logs).
3. Missing or invalid token: reject the upgrade with HTTP 401 — no socket is created. A token you later decide to reject (revoked, link disabled, replaced by a newer socket) is a close with code `4401`.
4. v1 uses JSON **text** frames. No WebSocket subprotocol.
5. Companion sends `hello` within 10 seconds. If it does not, close with code `4408`.
6. Reply `hello` `{ "ok": true }`. The socket is live. The reply may also carry an optional `upload` block (see below).
7. Either side sends `ping` at least every 30 seconds; the other replies `pong`. Proxies often idle-timeout between 30 and 120 seconds.
8. On close, Companion reconnects with exponential backoff (1s, 2s, 4s, … cap 60s) until the connection is disabled or `url` is cleared — **except** after `4401`, which means "do not retry" (see below).

### Close codes, and which ones retry

| Code | Meaning | Companion behaviour |
| --- | --- | --- |
| `4401` | Terminal rejection: this socket must not come back. Unknown token, disabled/revoked link, replaced by a newer socket, or any other server-side "no". | Stops. Surfaces the failure. **Never retries.** |
| `4408` | `hello` was not sent within 10 seconds. | Backoff retry. |
| anything else / transport drop | Network blip, deploy, proxy timeout. | Backoff retry. |

`4401` is the only terminal code: send no reason string, and reuse it for every rejection so a Companion can implement the whole rule as `if (code === 4401) stop()`. Companion ignores a reason, so do not encode detail there.

### Identity lives in your token, not on the frame

The token identifies the tenant. Resolve who is connecting from the token on the server, and keep product identifiers (account id, tenant id, workspace id, phone number of record) out of the envelope entirely. Companion is open source and channel-agnostic: it must never be handed a field it cannot interpret generically.

The one thing Companion does report about a user is the optional `userId` on `event` — a channel address it already holds (a JID, a mid). That is the adapter's own data, not a product id you asked it to track.

Because the token carries identity, the server owns **all** routing: which product account, which agent, which reply destination. A server that needs to address a specific session keeps that mapping on its side of the wire and returns the answer over the same socket — Companion never learns an internal id.

One Companion connection = one WebSocket. Do not multiplex channels on a single process-wide socket.

```
Companion                Cloud
   |-- HTTP Upgrade Bearer -->|
   |<-- 101 -------------------|
   |-- hello ----------------->|
   |<-- hello ok --------------|
   |-- event ----------------->|
   |<-- invoke ----------------|
   |-- result ---------------->|
   |-- ping ------------------>|
   |<-- pong ------------------|
```

## Frame schema

Every message is a JSON object:

```json
{
  "v": 1,
  "type": "hello" | "event" | "invoke" | "result" | "error" | "ping" | "pong",
  "id": "corrId",
  "connectionId": "home",
  "channel": "whatsapp",
  "userId": "+6591234567",
  "name": "messages.upsert",
  "data": {},
  "error": { "code": "NOT_CONNECTED", "message": "…" }
}
```
Stable fields (do not add vendor keys here):

- `v` — protocol version. Unknown `v`: reply `error` `UNSUPPORTED_VERSION`.
- `id` — required on `invoke` and on the `result` / `error` that answers it. Companion copies it back.
- `connectionId` — Companion’s local session id. Required on `hello`, `event`, `invoke`, `result`.
- `channel` — opaque IM name. Required on `hello`, `event`, `invoke`.
- `userId` — optional, and generic: the channel user this frame concerns, when the adapter knows it (a WhatsApp JID or phone, a LINE user id). Companion fills it in per channel; you never parse a vendor payload to find the sender. Omit it when the event concerns nobody in particular or several users at once. It is a channel address, not a tenant or account id.
- `name` — opaque event or method name. Meaning is per channel (appendices below).
- `data` — opaque JSON. For `invoke`, `{ "args": [ ... ] }`. Never a product envelope.

`hello` (Companion → you): top-level `connectionId` and `channel`; `data` may include `{ "account": "…" }` and, when the channel can name more, a `profile` block:

```json
{
  "account": "6591234567",
  "profile": {
    "account": "6591234567",
    "userId": "6591234567:12@s.whatsapp.net",
    "phone": "6591234567",
    "username": "handle",
    "displayName": "Pete"
  }
}
```

Every `profile` field is optional and the whole block may be absent (an unlinked
session, or an older Companion). These are **channel** account facts, not product
or tenant ids: `account` / `userId` are the channel address (WhatsApp phone or
device JID, LINE mid), `phone` is digits-only and appears only where the channel
has a phone (WhatsApp — LINE never fills it), `displayName` is the push name /
displayName the channel shows. Send `hello` again after a reconnect so the server
can refresh its record; nothing else on the frame identifies a user.

`hello` (you → Companion): `data` `{ "ok": true }`.

`event`: Companion forwards a vendor callback. `data` is the raw library payload. When the event concerns one channel user, `userId` carries their channel id; a batched event from several senders omits it.

`invoke`: you ask Companion to call an allowlisted vendor method. Companion does not interpret `args` beyond reviving binary fields.

**Replies.** `invoke` is bound to the socket that carries the related inbound `event`: the reply for a user's message is an `invoke` to the connection that forwarded it. A server is free to hold many connections (one per tenant, per linked account, per channel), and it chooses the target from its own state — Companion does not tag events with a routing key you must echo.

**Delivery is queued, not fire-and-forget.** A Companion with no live socket does
not lose an `event` and does not drop an `invoke`. Messages are persisted locally
and replayed:

- `event` frames carrying messages are serialized per connection and sent in
  arrival order. Anything produced while the socket is down is delivered after
  the reconnect, oldest first. Do not assume an `event` arrives in real time, and
  keep using a vendor message id to dedupe.
- An `invoke` that sends a message is **persisted and acked immediately**, even
  when the phone is offline. The `result` carries a Companion-generated id
  (`key.id` for WhatsApp, `messageId` for LINE), not the vendor's. It is a
  delivery receipt for the queue, not proof the message reached the peer.
- Non-message invokes (`readMessages`, `sendPresenceUpdate`, `relayMessage`) still
  run inline and still answer `NOT_CONNECTED` when the laptop is offline.
- A message that cannot be delivered is retried on a transport error, and given
  up on a real one, after 3 attempts, or once it is an hour old. Companion does
  not tell you when a send is given up: treat the queued ack as acceptance, and
  reconcile through your own state if you need certainty.

`result`: raw return value of that method.

`error`: `{ "code", "message" }` with `NOT_CONNECTED`, `METHOD_NOT_ALLOWED`, `INVOKE_FAILED`, `UNSUPPORTED_VERSION`, `UNAUTHORIZED`.

`ping` / `pong`: omit `data`. Either side may initiate.

Time out unanswered `invoke`s (15 seconds is a reasonable default).

## Binary JSON

`Uint8Array` / `Buffer` anywhere in `data` become `{ "$bin": "<base64>" }`. Revive before passing `data` into a vendor parser. Nested objects that use `$bin` as a real key are not supported.

## Server checklist

- Accept the upgrade, authenticate the bearer, keep the socket open.
- Understand `hello` / `event` / `invoke` / `result` / `error` / `ping` / `pong` without assuming a channel.
- Dispatch on `channel` + `name`; treat `data` as that channel’s vendor JSON.
- Resolve tenant identity from the bearer token; never expect a product id on the frame. Reject with close code `4401` (nothing else) when a socket must not come back, and reject an unknown token with HTTP 401 before upgrading.
- Fill in the optional `userId` when an event concerns exactly one channel user; omit it otherwise. Never put a tenant or account id there.
- Map vendor JSON to your product model **in your server**, not in Companion.
- Idle ping; survive load-balancer idle timeouts.
- Do not require Companion to expose a port, webhook, or HTTP callback.

Companion’s local REST (`POST …/message` with `{ to, text }`, `PUT …/webhook`) is a human dashboard. It is not this cloud pipe.

## Channel catalogs

These catalogs document what Companion currently forwards and invokes. A new channel is a new appendix plus a local Companion adapter. The envelope does not change.

### `whatsapp`

Events (`name`): `messages.upsert`, `connection.update`. `data` is the raw Baileys payload.

Invoke (`name`): `sendMessage`, `relayMessage`, `readMessages`, `sendPresenceUpdate`, `prepareMedia`. `data.args` are the arguments those Baileys socket methods take. Media in `sendMessage` may use `{ image: { url } }` (and peers); Companion’s Baileys session uploads to WhatsApp.

#### `prepareMedia`

```json
{ "type": "invoke", "name": "prepareMedia", "data": { "args": ["image", "https://…/temp/abc.jpeg", "image/jpeg"] } }
```

`args` are `[kind, url, mimetype?, fileName?]` where `kind` is `image`, `video`, or
`document`. It downloads the url, uploads the media to WhatsApp, and returns the resulting
proto (`{ imageMessage: { url, directPath, mediaKey, … } }` and peers) as the `result`
data.

It exists because Baileys’ `prepareWAMessageMedia` — the only API that uploads media to
WhatsApp — needs the socket’s upload function, so it can only run in the process holding
the socket. A server that wants to send an **interactive** message with a header image (or
a media carousel card) has to build that header here and embed the returned proto, because
WhatsApp refuses media it has not uploaded itself.

Send the `mimetype` when you know it: Baileys otherwise falls back to a per-type default
(`image/jpeg` for `image`, and so on), so a PNG would be declared JPEG. `fileName` is only
used for `document`.

#### Decrypted media on `messages.upsert`

Vendor media is end-to-end encrypted, so a server that receives only the proto cannot read
it. On a `messages.upsert` event each message **may** carry a sibling `media` block next to
`key` and `message`, holding the decrypted plaintext the Companion already had to fetch:

```json
{
  "key": { "id": "3EB0…", "remoteJid": "6581111111@s.whatsapp.net", "fromMe": false },
  "message": { "imageMessage": { "mediaKey": { "$bin": "…" }, "directPath": "/v/…" } },
  "media": {
    "bytes": { "$bin": "<base64>" },
    "mimetype": "image/jpeg",
    "sha256": "iZzPCOcz1ebwyFwAvan8nt6Q1rD4aBCf2c7O61PWLgQ=",
    "length": 289089
  }
}
```

- The block is a **sibling of `key` / `message`**, not a field of the vendor proto, so
  `messages[]` entries stay valid Baileys messages apart from this one added key.
- It is emitted only for media the Companion decrypted (`image`, `video`, `audio`,
  `document`). Absent means "not decrypted": a server must not invent the bytes.
- `bytes` uses the protocol’s `$bin` convention (see [Binary JSON](#binary-json)).
- `mimetype` is the plaintext mime (the inner proto’s `imageMessage.mimetype` and peers).
- `sha256` is the hash of the **plaintext**, encoded **base64url without padding**.
  WhatsApp’s own `fileSha256` is standard base64 *with* padding, so a Companion reusing
  that field must normalize it; otherwise the same file has two identities and
  content-addressed dedupe silently fails.
- `length` is the plaintext byte count (the same quantity as the proto `fileLength`) — not
  the ciphertext’s and not the base64’s.
- A `url` field carries the same plaintext when the Companion uploaded it to storage itself
  (see "Uploading to storage instead of sending bytes"): the block then has `url` and no
  `bytes`. Receivers should treat `sha256` / `length` as advisory while `bytes` is present
  (recompute from the bytes), and as authoritative once `url` replaces `bytes`.
- Media is skipped, never deferred, when it is too large or could not be decrypted: the
  block is simply omitted.

A `media` block can push a frame well past a text payload, so implementations should cap
the plaintext total per frame as well as per file.

#### Uploading to storage instead of sending bytes

A server that wants media off the socket can hand the Companion a **presign endpoint** on
the `hello` reply, and **upload the bytes itself**:

```json
{ "v": 1, "type": "hello", "data": { "ok": true, "upload": { "url": "https://api.example.com/v1/media/presign" } } }
```

Then, per media message, the Companion:

1. `POST`s `{ mimetype, length, sha256 }` to that endpoint with the same
   `Authorization: Bearer` token the socket authenticated with;
2. receives `{ uploadUrl, downloadUrl }` and `PUT`s the plaintext to `uploadUrl`,
   sending the **same `Content-Type`** it declared (it is part of the signature);
3. sends the `messages.upsert` event with `media: { url, mimetype, sha256, length }`
   instead of `media.bytes`.

Notes for a server implementing this:

- The endpoint is part of the `hello` reply rather than something the Companion
  configures, so the client needs no extra setting. Omit the block and the Companion
  simply keeps sending bytes inline.
- The endpoint lives on the server's **API** origin, which is not necessarily the host the
  socket dialled (a deployment that terminates long-lived sockets on a separate streaming
  host must advertise the API host here).
- Buying a presigned URL is the point: the client never holds storage credentials.
- Treat a failed presign or PUT as "no block": the Companion retries that message with
  `bytes` inline, so a client is never worse off than before.
- A url is only as trustworthy as the server's own object naming. Validate host, path, and
  that the object name embeds the `sha256` before fetching anything.

### `line`

Events (`name`): `message`. `data` is the raw LINEJS listen object.

Invoke (`name`): `sendCompactMessage`. `data.args` are `(to, text)`.

### Next channel

Implement the channel in Companion, add its event/invoke names here, and teach your server how to parse `data`.

## Stub (Bun)

```js
const TOKEN = process.env.COMPANION_TOKEN ?? 'secret';

Bun.serve({
  port: 8787,
  fetch(req, server) {
    if (new URL(req.url).pathname !== '/v1/companion') {
      return new Response('not found', { status: 404 });
    }
    const auth = req.headers.get('authorization') ?? '';
    if (auth !== `Bearer ${TOKEN}`) return new Response('unauthorized', { status: 401 });
    if (server.upgrade(req)) return;
    return new Response('upgrade failed', { status: 400 });
  },
  websocket: {
    open(ws) {
      ws.data = { hello: false };
      setTimeout(() => {
        if (!ws.data.hello) ws.close(4408, 'hello timeout');
      }, 10_000);
    },
    message(ws, raw) {
      const frame = JSON.parse(String(raw));
      if (frame.type === 'hello') {
        ws.data.hello = true;
        ws.data.channel = frame.channel;
        ws.data.connectionId = frame.connectionId;
        ws.send(JSON.stringify({ v: 1, type: 'hello', data: { ok: true } }));
        return;
      }
      if (frame.type === 'ping') {
        ws.send(JSON.stringify({ v: 1, type: 'pong' }));
        return;
      }
      if (frame.type === 'event') {
        console.log('event', frame.channel, frame.name);
      }
    },
  },
});
```

This stub does not import Baileys or LINEJS. Your product maps `event` `data` after the fact.
