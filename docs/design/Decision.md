# Local decision

Companion answers TypeSafe System One calls on the machine that is running it. An app calls the HTTP API instead of shipping a decision model of its own.

The model is [laya-multilingual](https://huggingface.co/convaiinnovations/laya-multilingual), run by [mlx-decision](https://github.com/armbues/mlx-decision) 0.8.1 on Apple Silicon. It uses the Metal GPU. The PyTorch `laya` package is not installed, and there is no CPU fallback. A Mac that is not Apple Silicon, and Windows, have no model to download.

The request body follows System One. The path is `/api/v1/systemone.json`.

## Where it listens

| How you run Companion | Base URL |
| --- | --- |
| `companion/scripts/run.sh` | `http://127.0.0.1:38000` |
| Packaged Mac app | `http://127.0.0.1:38888` |

A caller on this machine (`127.0.0.1`) needs no token. A caller from another machine must send `Authorization: Bearer <token>`. The token is in `config.json`. From this machine, `GET /api/v1/im/health` echoes it.

## Turn it on

Nothing is fetched at boot. The Setup page downloads the model, then Enable loads it. The same steps are available over HTTP.

```bash
# See whether decision is downloaded and enabled. Speech is in the same list.
curl -sS http://127.0.0.1:38000/api/v1/setup.json

# Apple Silicon only. Fetch uv, a Python 3.12 environment, mlx-decision, and the weights.
# Safe to call again; a finished download is left alone.
curl -sS -X POST http://127.0.0.1:38000/api/v1/setup/decision/download.json

# Load the weights into the resident process. The files stay on disk after Disable.
curl -sS -X PUT http://127.0.0.1:38000/api/v1/setup/decision.json \
  -H 'content-type: application/json' \
  -d '{"enabled":true}'
```

`decisionEnabled` is stored in `config.json` and kept when the token or the speech settings are saved. The files live under `data/decision/`, separate from `data/tts/`.

## Ask a question

```bash
curl -sS -X POST http://127.0.0.1:38000/api/v1/systemone.json \
  -H 'content-type: application/json' \
  -d '{
    "state": "The customer wrote: 我的订单到了但是盒子是破的。",
    "questions": {
      "team": {
        "type": "choice",
        "instructions": "Which team should handle this?",
        "criteria": {
          "returns": "Damaged or missing goods",
          "billing": "Payments and invoices",
          "other": "Anything else"
        }
      }
    }
  }'
```

`model` may be omitted or set to `laya-multilingual`. Any other name is `400`. `state` is a string or any JSON value. `questions` is a non-empty map. Each question is `choice` (criteria is a map of option id to description), `noul` (yes/no), or `score` (criteria is a list of at least two levels).

A success body looks like this. The numbers come from the model.

```json
{
  "model": "laya-multilingual",
  "answers": {
    "team": {
      "type": "choice",
      "choice": "returns",
      "confidence": 0.9,
      "probabilities": { "returns": 0.9, "billing": 0.05, "other": 0.05 }
    }
  },
  "usage": { "input_tokens": 40, "output_tokens": 0 }
}
```

The connection is held until the answer is ready. The first call after Enable loads the weights, so it is the slow one. Later calls are short. One decision runs at a time, on its own queue, so a speech request does not wait for it and a decision does not wait for speech.

## Errors

| Status | `error` | When |
| --- | --- | --- |
| 400 | `INVALID_PARAM` | The body is not a System One request this model accepts, or `model` is not `laya-multilingual` |
| 401 | `UNAUTHORIZED` | The caller is not on this machine and sent no valid bearer token |
| 503 | `DECISION_NOT_READY` | The weights are not downloaded |
| 503 | `DECISION_DISABLED` | Downloaded, and the Setup switch is off |
| 503 | `QUEUE_FULL` | Eight decisions are already waiting |
| 504 | `DECISION_TIMEOUT` | The call did not finish in two minutes |
| 500 | `DECISION_FAILED` | The model process failed |

The body is `{ "error": "DECISION_NOT_READY", "message": "Decision model is not downloaded" }`.
