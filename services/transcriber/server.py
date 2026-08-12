from fastapi import FastAPI, File, UploadFile, HTTPException
from fastapi.responses import JSONResponse
import torch
import numpy as np
import io
import os
import logging
import sys
import types
import json
import tempfile
import shutil
import ffmpeg
from transformers import AutoProcessor
from safetensors.torch import load_file

logger = logging.getLogger("gigaam")
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")

app = FastAPI(title="GigaAM Transcriber")

MODEL_NAME = os.getenv("GIGAAM_MODEL", "waveletdeboshir/gigaam-ctc")
_model = None
_processor = None
_device = None


def get_device() -> str:
    global _device
    if _device is None:
        _device = "cuda" if torch.cuda.is_available() else "cpu"
        logger.info("Устройство: %s", _device)
    return _device


def _patch_gigaam_encoder():
    base = os.path.expanduser("~/.cache/huggingface")
    target = "torch.tensor(feat_in)"
    replacement = "torch.tensor(feat_in, device='cpu')"
    for candidate in [
        os.path.join(base, "hub"),
        os.path.join(base, "modules", "transformers_modules"),
    ]:
        if not os.path.isdir(candidate):
            continue
        for root, _dirs, files in os.walk(candidate):
            if "encoder.py" in files and "gigaam" in root.lower():
                path = os.path.join(root, "encoder.py")
                try:
                    with open(path, "r", encoding="utf-8") as f:
                        content = f.read()
                    if target in content and replacement not in content:
                        content = content.replace(target, replacement)
                        with open(path, "w", encoding="utf-8") as f:
                            f.write(content)
                        logger.info("Пропатчен encoder.py: %s", path)
                except Exception as exc:
                    logger.warning("Не удалось пропатчить encoder.py: %s", exc)


def _load_gigaam_snapshot() -> str:
    snapshots_dir = os.path.expanduser(
        "~/.cache/huggingface/hub/models--waveletdeboshir--gigaam-ctc/snapshots"
    )
    if not os.path.isdir(snapshots_dir):
        raise FileNotFoundError(f"Снапшот модели не найден: {snapshots_dir}")
    entries = sorted(os.listdir(snapshots_dir))
    if not entries:
        raise FileNotFoundError(f"Снапшот модели пуст: {snapshots_dir}")
    return os.path.join(snapshots_dir, entries[-1])


def _import_gigaam_classes(snapshot_dir: str):
    pkg_name = "_gigaam_runtime"
    if pkg_name in sys.modules:
        return sys.modules[pkg_name].GigaAMConfig, sys.modules[pkg_name].GigaAMCTCHF

    module_path = os.path.join(snapshot_dir, "gigaam_transformers.py")
    if not os.path.exists(module_path):
        raise FileNotFoundError(f"gigaam_transformers.py не найден в {snapshot_dir}")

    with open(module_path, "r", encoding="utf-8") as f:
        source = f.read()

    package_dir = tempfile.mkdtemp(prefix="gigaam_pkg_")
    pkg_dir = os.path.join(package_dir, pkg_name)
    os.makedirs(pkg_dir, exist_ok=True)

    encoder_src = os.path.join(snapshot_dir, "encoder.py")
    encoder_dst = os.path.join(pkg_dir, "encoder.py")
    if os.path.exists(encoder_src):
        shutil.copy2(encoder_src, encoder_dst)

    init_path = os.path.join(pkg_dir, "__init__.py")
    with open(init_path, "w", encoding="utf-8") as f:
        f.write("from .gigaam_transformers import GigaAMConfig, GigaAMCTCHF\n")

    module_file = os.path.join(pkg_dir, "gigaam_transformers.py")
    with open(module_file, "w", encoding="utf-8") as f:
        f.write(source)

    sys.path.insert(0, package_dir)
    pkg = types.ModuleType(pkg_name)
    pkg.__path__ = [pkg_dir]
    sys.modules[pkg_name] = pkg

    gigaam_transformers = __import__(f"{pkg_name}.gigaam_transformers", fromlist=["GigaAMConfig", "GigaAMCTCHF"])
    return gigaam_transformers.GigaAMConfig, gigaam_transformers.GigaAMCTCHF


def load_model():
    global _model, _processor
    if _model is None or _processor is None:
        _patch_gigaam_encoder()
        logger.info("Загрузка модели %s...", MODEL_NAME)
        _processor = AutoProcessor.from_pretrained(MODEL_NAME, trust_remote_code=True)

        snapshot_dir = _load_gigaam_snapshot()
        GigaAMConfig, GigaAMCTCHF = _import_gigaam_classes(snapshot_dir)

        with open(os.path.join(snapshot_dir, "config.json"), "r", encoding="utf-8") as f:
            config_dict = json.load(f)
        config = GigaAMConfig(**config_dict)

        _model = GigaAMCTCHF(config)
        state_dict = load_file(os.path.join(snapshot_dir, "model.safetensors"), device="cpu")
        _model.load_state_dict(state_dict, strict=False)
        _model.to(get_device())
        _model.eval()
        logger.info("Модель загружена.")
    return _model, _processor


def decode_audio_to_mono_16k(audio_bytes: bytes) -> np.ndarray:
    try:
        out, _ = (
            ffmpeg
            .input("pipe:0")
            .output(
                "pipe:1",
                format="f32le",
                acodec="pcm_f32le",
                ac=1,
                ar=16000,
                hide_banner=None,
                loglevel="error",
            )
            .run(input=audio_bytes, capture_stdout=True, capture_stderr=True)
        )
    except ffmpeg.Error as exc:
        stderr = exc.stderr.decode(errors="replace") if exc.stderr else str(exc)
        raise RuntimeError(f"FFmpeg decode error: {stderr}") from exc

    audio = np.frombuffer(out, dtype=np.float32)
    return audio


def chunk_audio(audio: np.ndarray, chunk_length_sec: int = 30, overlap_sec: float = 1.0) -> list[np.ndarray]:
    sr = 16000
    chunk_samples = chunk_length_sec * sr
    overlap_samples = int(overlap_sec * sr)
    chunks = []
    start = 0
    while start < audio.shape[0]:
        end = min(start + chunk_samples, audio.shape[0])
        chunk = audio[start:end]
        chunks.append(chunk)
        if end >= audio.shape[0]:
            break
        start = end - overlap_samples
    return chunks


def decode_chunk(model, processor, chunk: np.ndarray, device: str) -> str:
    inputs = processor(chunk, sampling_rate=16000, return_tensors="pt")
    inputs = inputs.to(device)
    with torch.no_grad():
        logits = model(**inputs).logits
    predicted_ids = torch.argmax(logits, dim=-1)
    return processor.batch_decode(predicted_ids, skip_special_tokens=True)[0]


@app.get("/health")
async def health():
    return {"status": "ok", "model": MODEL_NAME, "device": get_device()}


@app.post("/transcribe")
async def transcribe(file: UploadFile = File(...)):
    try:
        audio_bytes = await file.read()
        if len(audio_bytes) == 0:
            raise HTTPException(status_code=400, detail="Пустой аудиофайл")

        audio = decode_audio_to_mono_16k(audio_bytes)
        model, processor = load_model()
        device = get_device()

        max_samples = 30 * 16000
        if audio.shape[0] > max_samples:
            chunks = chunk_audio(audio)
            texts = [decode_chunk(model, processor, c, device) for c in chunks]
            text = " ".join(t for t in texts if t)
        else:
            text = decode_chunk(model, processor, audio, device)

        return {"text": text.strip()}
    except HTTPException:
        raise
    except Exception as exc:
        logger.exception("Ошибка транскрибации")
        raise HTTPException(status_code=500, detail=f"Ошибка транскрибации: {exc}")
