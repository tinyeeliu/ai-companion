"""Resident mlx-audio process. One Kokoro checkpoint stays loaded.

Commands are one JSON object per stdin line. Replies are one JSON object per
stdout line. Library prints are sent to stderr so they cannot break the protocol.
"""

import contextlib
import json
import os
import sys
import traceback

OUT = sys.stdout
MODELS = {
    "en": "mlx-community/Kokoro-82M-bf16",
    "zh": "FluidInference/kokoro-82m-v1.1-zh-mlx",
}

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


def download(model_id):
    repo = MODELS[model_id]
    from huggingface_hub import snapshot_download
    from tqdm.auto import tqdm

    class Report(tqdm):
        def update(self, n=1):
            result = super().update(n)
            total = int(self.total or 0)
            write({"progress": True, "received": int(self.n or 0), "total": total})
            return result

    with quiet():
        snapshot_download(repo, tqdm_class=Report)
    marker = os.path.join(os.environ["COMPANION_TTS_ROOT"], "mlx", "ready", model_id)
    os.makedirs(os.path.dirname(marker), exist_ok=True)
    with open(marker, "w", encoding="utf-8") as handle:
        handle.write(repo + "\n")


def load(model_id):
    global model
    repo = MODELS[model_id]
    with quiet():
        from mlx_audio.tts.utils import load_model
        import mlx.core as mx

        if model is not None:
            model = None
            mx.clear_cache()
        model = load_model(repo)


def unload():
    global model
    model = None
    with quiet():
        import gc
        import mlx.core as mx

        gc.collect()
        mx.clear_cache()


def speak(text, voice, speed, lang, output):
    if model is None:
        raise RuntimeError("model is not loaded")
    import numpy as np
    import soundfile as sf

    chunks = []
    rate = 24000
    with quiet():
        for result in model.generate(text=text, voice=voice, speed=float(speed), lang_code=lang):
            audio = np.asarray(result.audio, dtype=np.float32).reshape(-1)
            chunks.append(audio)
            rate = int(getattr(result, "sample_rate", rate))
    if not chunks:
        raise RuntimeError("mlx-audio wrote no audio")
    samples = np.concatenate(chunks)
    sf.write(output, samples, rate, subtype="PCM_16")


def handle(cmd):
    name = cmd.get("cmd")
    if name == "download":
        download(cmd["model"])
    elif name == "load":
        load(cmd["model"])
    elif name == "unload":
        unload()
    elif name == "speak":
        speak(cmd["text"], cmd["voice"], cmd.get("speed", 1), cmd["lang"], cmd["output"])
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
        except Exception as error:
            traceback.print_exc(file=sys.stderr)
            write({"ok": False, "error": str(error)})


if __name__ == "__main__":
    main()
