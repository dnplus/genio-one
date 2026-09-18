from telemetry import Telemetry
import asyncio
import hashlib
import hmac
import json
import logging
import os
import re
import struct
import subprocess
import tempfile
import threading
import time
from contextlib import asynccontextmanager
from pathlib import Path

import numpy as np
from fastapi import FastAPI, HTTPException, Request
from huggingface_hub import hf_hub_download
from pywhispercpp.model import Model

MODEL_ID = "MediaTek-Research/Breeze-ASR-25"
MODEL_ALIAS = "breeze-asr"
MODEL_REPOSITORY = "shdennlin/breeze-asr-25-ggml"
MODEL_REVISION = "36c726093efe1760d1dd39c3cfe8b6a7282437d1"
MODEL_FILENAME = "ggml-breeze-asr-25-q8_0.bin"
MODEL_SHA256 = "d4b187c40ffbf1f620734b77821e2ca8a97c8ecf5754d02b2a175069348cafcf"
MAX_BYTES = 4_000_000
MAX_SECONDS = 60
logger = logging.getLogger("genio.asr")
logger.setLevel(logging.INFO)
if not logger.handlers:
    logger.addHandler(logging.StreamHandler())
logger.propagate = False


def verify_model(path):
    with Path(path).open("rb") as model:
        header = model.read(48)
        if len(header) != 48 or struct.unpack("<12i", header)[0] != 0x67676D6C or struct.unpack("<12i", header)[11] % 1000 != 7:
            raise RuntimeError("ASR_Q8_MODEL_REQUIRED")
        model.seek(0)
        if hashlib.file_digest(model, "sha256").hexdigest() != MODEL_SHA256:
            raise RuntimeError("ASR_MODEL_CHECKSUM_MISMATCH")


class BreezeRecognizer:
    def __init__(self):
        self.lock = threading.Lock()
        path = hf_hub_download(MODEL_REPOSITORY, MODEL_FILENAME, revision=MODEL_REVISION)
        verify_model(path)
        self.quantization = "Q8_0"
        self.model = Model(path, context_params={"use_gpu": True, "flash_attn": True},
                           language="auto", no_context=True, print_progress=False, print_realtime=False,
                           print_timestamps=False)
        self.device = self.model.system_info()
        logger.info(json.dumps({"event": "asr.loaded", "model": MODEL_ALIAS, "source_model": MODEL_ID, "revision": MODEL_REVISION, "backend": "whisper.cpp", "quantization": self.quantization, "weight_bytes": Path(path).stat().st_size, "device": self.device}))

    def transcribe(self, audio):
        if not self.lock.acquire(blocking=False):
            raise HTTPException(429, "ASR_BUSY")
        try:
            return " ".join(segment.text for segment in self.model.transcribe(audio)).strip()
        finally:
            self.lock.release()


def decode_audio(data):
    with tempfile.TemporaryDirectory(prefix="genio-asr-") as directory:
        path = Path(directory) / "recording"
        path.write_bytes(data)
        try:
            result = subprocess.run(
                ["ffmpeg", "-nostdin", "-v", "error", "-protocol_whitelist", "file,pipe", "-format_whitelist", "wav,mp3,ogg,matroska,webm,mov,aac,flac", "-i", str(path), "-t", str(MAX_SECONDS + 1), "-vn", "-ac", "1", "-ar", "16000", "-f", "f32le", "pipe:1"],
                capture_output=True, timeout=20, check=True,
            )
        except (subprocess.SubprocessError, OSError):
            raise HTTPException(400, "ASR_INVALID_AUDIO") from None
    audio = np.frombuffer(result.stdout, dtype=np.float32).copy()
    if len(audio) > MAX_SECONDS * 16000:
        raise HTTPException(413, "ASR_AUDIO_TOO_LONG")
    if len(audio) < 1600 or not np.isfinite(audio).all():
        raise HTTPException(400, "ASR_INVALID_AUDIO")
    return audio


def create_app(recognizer_factory=BreezeRecognizer):
    telemetry = Telemetry()
    @asynccontextmanager
    async def lifespan(app):
        app.state.recognizer = await asyncio.to_thread(recognizer_factory)
        yield
        app.state.recognizer = None
        await asyncio.to_thread(telemetry.close)

    app = FastAPI(lifespan=lifespan)
    admission = asyncio.Semaphore(1)

    @app.middleware("http")
    async def authenticate_and_limit(request: Request, call_next):
        from starlette.responses import JSONResponse

        key = os.environ.get("BREEZE_ASR_API_KEY", "")
        if key:
            if not hmac.compare_digest(request.headers.get("authorization", ""), f"Bearer {key}"):
                return JSONResponse({"error": {"message": "ASR_AUTH_REQUIRED"}}, status_code=401)
        elif not request.client or request.client.host not in ("127.0.0.1", "::1"):
            return JSONResponse({"error": {"message": "ASR_API_KEY_REQUIRED"}}, status_code=403)
        if request.method == "POST":
            try:
                length = int(request.headers.get("content-length", "0"))
            except ValueError:
                return JSONResponse({"error": {"message": "ASR_INVALID_LENGTH"}}, status_code=400)
            if length > MAX_BYTES:
                return JSONResponse({"error": {"message": "ASR_AUDIO_TOO_LARGE"}}, status_code=413)
            data = bytearray()
            async for chunk in request.stream():
                data.extend(chunk)
                if len(data) > MAX_BYTES:
                    return JSONResponse({"error": {"message": "ASR_AUDIO_TOO_LARGE"}}, status_code=413)
            request._body = bytes(data)
        return await call_next(request)

    @app.get("/health")
    async def health():
        return {"service": "genio-connector-breeze-asr", "status": "ready", "model": MODEL_ALIAS, "device": app.state.recognizer.device, "quantization": app.state.recognizer.quantization, "telemetry": {"configured": bool(telemetry.origin), "storage_available": telemetry.available, "pending_records": telemetry.pending.qsize(), "dropped_records": telemetry.dropped}}

    @app.middleware("http")
    async def observe_request(request: Request, call_next):
        with telemetry.operation("asr.http", {"http.request.method": request.method, "http.route": request.url.path, "genio.correlation.id": request.headers.get("x-genio-correlation-id", request.headers.get("x-request-id", ""))}, request.headers.get("traceparent")) as evidence:
            response = await call_next(request)
            evidence["http.response.status_code"] = response.status_code
            return response

    @app.get("/v1/models")
    async def models():
        return {"object": "list", "data": [{"id": MODEL_ALIAS, "object": "model", "owned_by": "local", "capabilities": ["TRANSCRIPTION"]}]}

    @app.post("/v1/audio/transcriptions")
    async def transcribe(request: Request):
        if admission.locked():
            raise HTTPException(429, "ASR_BUSY")
        async with admission:
            async with request.form(max_files=1, max_fields=5, max_part_size=MAX_BYTES) as form:
                if len(form.getlist("model")) != 1 or form.get("model") != MODEL_ALIAS:
                    raise HTTPException(400, "ASR_INVALID_MODEL")
                if len(form.getlist("response_format")) > 1 or form.get("response_format", "json") != "json" or form.get("stream"):
                    raise HTTPException(400, "ASR_JSON_REQUIRED")
                if any(key not in ("file", "model", "response_format") for key in form):
                    raise HTTPException(400, "ASR_UNSUPPORTED_PARAMETER")
                upload = form.get("file")
                if len(form.getlist("file")) != 1 or upload is None or not hasattr(upload, "read"):
                    raise HTTPException(400, "ASR_INVALID_FILE")
                data = await upload.read(MAX_BYTES + 1)
                if len(data) > MAX_BYTES:
                    raise HTTPException(413, "ASR_AUDIO_TOO_LARGE")
                started = time.monotonic()
                with telemetry.operation("asr.decode", {"audio.bytes": len(data)}) as evidence:
                    evidence["audio.sha256"] = telemetry.audio(data)
                    audio = await asyncio.to_thread(decode_audio, data)
                    evidence["audio.seconds"] = len(audio) / 16000
                    evidence["audio.pcm.sha256"] = hashlib.sha256(audio.tobytes()).hexdigest()
                    evidence["audio.sample_rate"] = 16000
                with telemetry.operation("asr.inference", {"gen_ai.request.model": MODEL_ALIAS}) as evidence:
                    def recognize():
                        with telemetry.operation("asr.model.execute", {"gen_ai.request.model": MODEL_ALIAS}) as result:
                            value = app.state.recognizer.transcribe(audio)
                            result["gen_ai.response.text"] = value
                            return value
                    text = await asyncio.to_thread(recognize)
                    evidence["gen_ai.response.text_length"] = len(text)
                logger.info(json.dumps({"event": "asr.completed", "model": MODEL_ALIAS, "correlation_id": request.headers.get("x-request-id") if re.fullmatch(r"[A-Za-z0-9_-]{1,128}", request.headers.get("x-request-id", "")) else None, "audio_seconds": round(len(audio) / 16000, 2), "elapsed_ms": round((time.monotonic() - started) * 1000)}))
                return {"text": text}

    return app


app = create_app()
