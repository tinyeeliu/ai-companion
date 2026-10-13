# Local speech

Companion speaks on the machine that is running it. An app calls the HTTP API instead of shipping a speech model of its own.

Kokoro is the neural voice ([Kokoro-82M](https://huggingface.co/hexgrad/Kokoro-82M)). The operating system's own voices (`say` on Mac, System.Speech on Windows) are available as well, and those do not need a download.

The request body follows OpenAI's Create speech call. The path does not: it is `/api/v1/audio/speech`, not `/v1/audio/speech`. Pointing an OpenAI SDK at this host without changing the path will miss the route.

## Where it listens

| How you run Companion | Base URL |
| --- | --- |
| `companion/scripts/run.sh` | `http://127.0.0.1:38000` |
| Packaged Mac app | `http://127.0.0.1:38888` |

A caller on this machine (`127.0.0.1`) needs no token. A caller from another machine must send `Authorization: Bearer <token>`. The token is in `config.json`. From this machine, `GET /api/v1/im/health` echoes it.

## Turn Kokoro on

Kokoro does nothing until its files are on disk and speech is enabled. The Setup page does both. The same steps are available over HTTP.

On Apple Silicon there are two checkpoints. The Setup selector chooses which one `"default"` uses:

| `model` | Checkpoint | `"default"` voice | Test sentence |
| --- | --- | --- | --- |
| `en` | `mlx-community/Kokoro-82M-bf16` | `af_heart` | Hello from AI Companion. |
| `zh` | `FluidInference/kokoro-82m-v1.1-zh-mlx` | `zf_001` | 你好，这是一段本地语音测试。 |

Windows has one Kokoro pack (`kokoro-multi-lang-v1_0` through sherpa-onnx) and no selector. `"default"` there is `af_heart`.

```bash
# See whether speech is downloaded and enabled.
curl -sS http://127.0.0.1:38000/api/v1/setup.json

# Apple Silicon only. "en" or "zh". Starts the download when that pack is missing.
curl -sS -X PUT http://127.0.0.1:38000/api/v1/setup/tts.json \
  -H 'content-type: application/json' \
  -d '{"model":"zh"}'

# Fetch the selected pack. Safe to call again; a finished download is left alone.
curl -sS -X POST http://127.0.0.1:38000/api/v1/setup/tts/download.json

# Turn speech on. Refused with 400 until the selected pack is on disk.
curl -sS -X PUT http://127.0.0.1:38000/api/v1/setup/tts.json \
  -H 'content-type: application/json' \
  -d '{"enabled":true}'
```

`GET /api/v1/setup.json` returns one feature, `id: "tts"`:

| Field | Meaning |
| --- | --- |
| `downloaded` | The selected pack is on disk |
| `enabled` | Speech is on. False while the pack is still missing |
| `downloading`, `received`, `total` | A download is in progress, and how far it has got |
| `error` | The last download or load failure, or `null` |
| `model` | `"en"` or `"zh"` on Apple Silicon. `null` on Windows |
| `models` | Both packs, each with its own `downloaded` flag. Empty on Windows |

The first Kokoro sentence after a cold start loads the weights, so it is slower than the ones after it. The HTTP call stays open until the audio is ready.

## List voices

```bash
curl -sS http://127.0.0.1:38000/api/v1/voices.json
```

```json
{
  "voices": [
    {
      "id": "af_heart",
      "name": "Heart",
      "language_codes": ["en-US"],
      "gender": "FEMALE",
      "vendor": "kokoro"
    },
    {
      "id": "os/Tingting",
      "name": "Tingting",
      "language_codes": ["zh-CN"],
      "gender": "NEUTRAL",
      "vendor": "os"
    }
  ]
}
```

`vendor` is `kokoro` or `os`. Kokoro rows are the voice files already downloaded, not a catalog of voices you could download later. `gender` is `MALE`, `FEMALE`, or `NEUTRAL`. Mac's `say` does not report gender, so those rows are `NEUTRAL`.

Pass `id` back as `voice` on the speech route.

## Speak

```http
POST /api/v1/audio/speech
Content-Type: application/json
```

| Field | Required | What it does |
| --- | --- | --- |
| `model` | yes | Must be `kokoro-82m` |
| `input` | yes | The sentence. 1–4096 characters |
| `voice` | yes | `"default"`, a Kokoro id, an OpenAI alias, or `os/<name>` |
| `response_format` | no | `wav` (default) or `pcm`. `mp3`, `opus`, `aac`, and `flac` are `400` |
| `speed` | no | `0.25`–`4.0`, default `1` |
| `instructions` | no | Accepted and ignored. Kokoro has no style prompt |
| `stream_format` | no | Omit it or send `audio` to get bytes. `speaker` plays on this machine and returns an empty `204`. `sse` is `400` |

Any other field is `400`.

`pcm` is signed 16-bit little-endian, 24 kHz, mono, with no wav header. `wav` is that same audio with a header. `Content-Type` is `audio/wav` or `audio/pcm`.

### English, saved as a wav

`af_heart` is the English pack's voice. Naming it loads the English checkpoint even when Setup has Chinese selected. Setup's selection is not changed.

```bash
curl -sS -D - -o speech.wav http://127.0.0.1:38000/api/v1/audio/speech \
  -H 'content-type: application/json' \
  -d '{
    "model": "kokoro-82m",
    "input": "Hello from AI Companion.",
    "voice": "af_heart"
  }'
```

These OpenAI names map onto English Kokoro voices: `alloy` → `af_alloy`, `echo` → `am_echo`, `fable` → `bm_fable`, `onyx` → `am_onyx`, `nova` → `af_nova`. British ids (`bf_…`, `bm_…`) use a British pronunciation on the English pack.

### Chinese

`zf_001` is the voice the Setup page uses for its Chinese test. The Chinese pack must already be downloaded. Speech must be enabled.

```bash
curl -sS -o speech.wav http://127.0.0.1:38000/api/v1/audio/speech \
  -H 'content-type: application/json' \
  -d '{
    "model": "kokoro-82m",
    "input": "你好，这是一段本地语音测试。",
    "voice": "zf_001"
  }'
```

`"default"` is whichever pack Setup has selected: `af_heart` for English, `zf_001` for Chinese. A named Kokoro id is spoken by the pack that contains that file. A voice whose pack is not downloaded is `503`. A name this machine does not have is `400`.

### Play on this machine's speaker

`stream_format: "speaker"` plays the sentence here and returns **204** with an empty body. Nothing is saved. The call stays open until playback finishes, and two speaker calls do not overlap. `response_format` is ignored because no bytes are returned.

```bash
curl -sS -D - -o /dev/null http://127.0.0.1:38000/api/v1/audio/speech \
  -H 'content-type: application/json' \
  -d '{
    "model": "kokoro-82m",
    "input": "Hello from AI Companion.",
    "voice": "af_heart",
    "stream_format": "speaker"
  }'
```

### Operating-system voices

An `os/` id is the platform voice name from the list above. It does not use Kokoro, so speech can be off and the model can be absent. It is accepted **only** with `stream_format: "speaker"`. Asking an `os/` voice for a wav or pcm file is `400`.

The names depend on the computer. On a Mac with the usual Chinese voices installed:

```bash
# Mandarin. Tingting is zh_CN.
curl -sS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:38000/api/v1/audio/speech \
  -H 'content-type: application/json' \
  -d '{
    "model": "kokoro-82m",
    "input": "你好，这是一段本地语音测试。",
    "voice": "os/Tingting",
    "stream_format": "speaker"
  }'

# Cantonese. Sinji is zh_HK.
curl -sS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:38000/api/v1/audio/speech \
  -H 'content-type: application/json' \
  -d '{
    "model": "kokoro-82m",
    "input": "你好，呢段係廣東話測試。",
    "voice": "os/Sinji",
    "stream_format": "speaker"
  }'
```

A name that is not installed is `400`. Read `GET /api/v1/voices.json` and use an `id` whose `vendor` is `os`.

### A caller that is not on this machine

```bash
curl -sS -o speech.wav http://192.168.1.20:38000/api/v1/audio/speech \
  -H 'content-type: application/json' \
  -H "authorization: Bearer $COMPANION_TOKEN" \
  -d '{
    "model": "kokoro-82m",
    "input": "Hello from AI Companion.",
    "voice": "af_heart"
  }'
```

## Errors

Failures are JSON: `{ "error": "...", "message": "..." }`.

| Status | `error` | When |
| --- | --- | --- |
| 400 | `INVALID_PARAM` | Bad body, unknown voice, `os/` voice without `speaker`, or a format this app cannot encode |
| 401 | `UNAUTHORIZED` | A non-loopback caller omitted the bearer token |
| 503 | `TTS_NOT_READY` | The Kokoro pack for that voice is not downloaded |
| 503 | `TTS_DISABLED` | Speech is turned off. Does not apply to `os/` voices |
| 503 | `QUEUE_FULL` | Eight Kokoro requests are already waiting |
| 504 | `TTS_TIMEOUT` | Synthesis did not finish within two minutes |
| 500 | `TTS_FAILED` | The speech engine or the speaker playback failed |

Kokoro runs one sentence at a time, on its own queue, so an image job does not hold up a sentence. `os/` voices do not use that queue. Speaker playback itself is serialized, so two `speaker` calls do not play at once.
