"""Resident mlx-decision process. One laya-multilingual checkpoint stays loaded.

Commands are one JSON object per stdin line. Replies are one JSON object per
stdout line. Library prints are sent to stderr so they cannot break the protocol.
This process imports mlx_decision, not the PyTorch `laya` package.
"""

import contextlib
import json
import os
import sys
import traceback

OUT = sys.stdout
REPO = "convaiinnovations/laya-multilingual"
PATTERNS = [
    "model.safetensors",
    "encoder/*",
    "tokenizer/*",
    "README.md",
    "LICENSE*",
    "rl_agent_config.json",
    "*.json",
]

model = None


def write(obj):
    OUT.write(json.dumps(obj) + "\n")
    OUT.flush()


@contextlib.contextmanager
def quiet():
    saved = sys.stdout
    sys.stdout = sys.stderr
    try:
        yield
    finally:
        sys.stdout = saved


class InvalidRequest(Exception):
    """A System One body the model refused. The route answers 400."""


def download():
    from huggingface_hub import snapshot_download
    from tqdm.auto import tqdm

    class Report(tqdm):
        def update(self, n=1):
            result = super().update(n)
            total = int(self.total or 0)
            write({"progress": True, "received": int(self.n or 0), "total": total})
            return result

    with quiet():
        snapshot_download(REPO, allow_patterns=PATTERNS, tqdm_class=Report)
    marker = os.path.join(os.environ["COMPANION_DECISION_ROOT"], "ready")
    os.makedirs(os.path.dirname(marker), exist_ok=True)
    with open(marker, "w", encoding="utf-8") as handle:
        handle.write(REPO + "\n")


def load():
    global model
    import mlx_decision

    with quiet():
        model = mlx_decision.load(REPO)


def unload():
    global model
    model = None


def decide(cmd):
    if model is None:
        raise RuntimeError("decision model is not loaded")
    from mlx_decision.errors import DecisionError

    try:
        with quiet():
            result = model.decide(cmd.get("state"), cmd["questions"])
    except DecisionError as error:
        raise InvalidRequest(str(error)) from None
    return result.to_wire()


def handle(cmd):
    name = cmd.get("cmd")
    if name == "download":
        download()
    elif name == "load":
        load()
    elif name == "unload":
        unload()
    elif name == "decide":
        write({"ok": True, "body": decide(cmd)})
        return
    else:
        raise RuntimeError(f"unknown command {name}")
    write({"ok": True})


def main():
    for line in sys.stdin:
        text = line.strip()
        if text == "":
            continue
        try:
            handle(json.loads(text))
        except InvalidRequest as error:
            write({"ok": False, "error": str(error), "invalid": True})
        except Exception as error:
            traceback.print_exc(file=sys.stderr)
            write({"ok": False, "error": str(error)})


if __name__ == "__main__":
    main()
