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


def install_npy_voices():
    """mlx-audio 0.5.8 loads voices/*.safetensors. The Chinese checkpoint ships .npy."""
    from pathlib import Path

    import mlx.core as mx
    import numpy as np
    from huggingface_hub import snapshot_download
    from mlx_audio.tts.models.kokoro.pipeline import KokoroPipeline
    from mlx_audio.tts.models.kokoro.voice import load_voice_tensor

    def voice_file(repo_id, voice, ext):
        pattern = f"voices/{voice}.{ext}"
        try:
            folder = Path(snapshot_download(repo_id, allow_patterns=[pattern], local_files_only=True))
        except Exception:
            folder = Path(snapshot_download(repo_id, allow_patterns=[pattern]))
        path = folder / "voices" / f"{voice}.{ext}"
        return path if path.is_file() else None

    def load_single_voice(self, voice):
        if voice in self.voices:
            return self.voices[voice]
        safetensors = voice_file(self.repo_id, voice, "safetensors")
        npy = None if safetensors is not None else voice_file(self.repo_id, voice, "npy")
        if safetensors is not None:
            pack = load_voice_tensor(str(safetensors))
        elif npy is not None:
            pack = mx.array(np.load(npy))
        else:
            raise FileNotFoundError(f"Voice {voice} not found")
        self.voices[voice] = pack
        return pack

    KokoroPipeline.load_single_voice = load_single_voice


def install_mlx_checkpoint_loader():
    """The Chinese checkpoint is already in MLX layout. mlx-audio's sanitizer
    transposes PyTorch checkpoints and would transpose this one a second time.
    """
    from mlx_audio.tts.models.kokoro.kokoro import Model

    if getattr(Model.sanitize, "_companion", False):
        return
    original = Model.sanitize

    def sanitize(self, weights):
        if any("Wx_forward" in key for key in weights):
            return dict(weights)
        return original(self, weights)

    sanitize._companion = True
    Model.sanitize = sanitize


def install_zh_g2p():
    """v1.1-zh was trained on misaki's 1.1 frontend. The default frontend writes
    IPA the checkpoint cannot read, so the voice comes out wrong.
    """
    from mlx_audio.tts.models.kokoro.kokoro import Model

    if getattr(Model._get_pipeline, "_companion", False):
        return
    original = Model._get_pipeline

    def _get_pipeline(self, lang_code):
        pipeline = original(self, lang_code)
        if lang_code == "z" and not getattr(pipeline, "_companion_zh", False):
            from misaki import en, zh

            english = en.G2P(trf=False, british=False, unk="")
            pipeline.g2p = zh.ZHG2P(version="1.1", en_callable=lambda text: english(text)[0])
            pipeline._companion_zh = True
        return pipeline

    _get_pipeline._companion = True
    Model._get_pipeline = _get_pipeline


def load(model_id):
    global model
    repo = MODELS[model_id]
    with quiet():
        from mlx_audio.tts.utils import load_model
        import mlx.core as mx

        install_npy_voices()
        install_mlx_checkpoint_loader()
        install_zh_g2p()
        if model is not None:
            model = None
            mx.clear_cache()
        model = load_model(repo)
        model.repo_id = repo


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

    chunks = []
    rate = 24000
    try:
        with quiet():
            for result in model.generate(text=text, voice=voice, speed=float(speed), lang_code=lang):
                audio = np.asarray(result.audio, dtype=np.float32).reshape(-1)
                chunks.append(audio)
                rate = int(getattr(result, "sample_rate", rate))
    except (KeyError, FileNotFoundError) as error:
        raise RuntimeError(f"Voice {voice} not found") from error
    if not chunks:
        raise RuntimeError("mlx-audio wrote no audio")
    samples = np.concatenate(chunks)
    pcm = (np.clip(samples, -1.0, 1.0) * 32767.0).astype(np.int16)
    import wave

    with wave.open(output, "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(rate)
        handle.writeframes(pcm.tobytes())


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
