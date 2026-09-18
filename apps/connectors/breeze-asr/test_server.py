import io
import wave
import struct

import pytest

from fastapi.testclient import TestClient

from server import create_app, verify_model


def wav(seconds=1):
    output = io.BytesIO()
    with wave.open(output, "wb") as audio:
        audio.setnchannels(1)
        audio.setsampwidth(2)
        audio.setframerate(16000)
        audio.writeframes(b"\x00\x00" * 16000 * seconds)
    return output.getvalue()


class Recognizer:
    device = "test"
    quantization = "Q8_0"

    def transcribe(self, audio):
        assert len(audio) == 16000
        return "測試辨識結果"


def test_upload_contract(monkeypatch):
    monkeypatch.delenv("BREEZE_ASR_API_KEY", raising=False)
    with TestClient(create_app(Recognizer), client=("127.0.0.1", 50000)) as client:
        assert client.get("/health").json()["status"] == "ready"
        assert client.get("/health").json()["quantization"] == "Q8_0"
        assert "configured" in client.get("/health").json()["telemetry"]
        assert client.get("/v1/models").json()["data"][0]["id"] == "breeze-asr"
        response = client.post("/v1/audio/transcriptions", data={"model": "breeze-asr"}, files={"file": ("recording.wav", wav())})
        assert response.status_code == 200
        assert response.json()["text"] == "測試辨識結果"
        assert client.post("/v1/audio/transcriptions", data={"model": "other"}, files={"file": ("recording.wav", wav())}).status_code == 400
        assert client.post("/v1/audio/transcriptions", data={"model": "breeze-asr", "prompt": "ignored"}, files={"file": ("recording.wav", wav())}).status_code == 400
        assert client.post("/v1/audio/transcriptions", data={"model": "breeze-asr"}, files={"file": ("recording.wav", wav(61))}).status_code == 413
        assert client.post("/v1/audio/transcriptions", data={"model": "breeze-asr"}, files={"file": ("recording.wav", b"invalid")}).status_code == 400


def test_service_auth(monkeypatch):
    monkeypatch.setenv("BREEZE_ASR_API_KEY", "test-service-key")
    with TestClient(create_app(Recognizer), client=("127.0.0.1", 50000)) as client:
        assert client.get("/v1/models").status_code == 401
        assert client.get("/v1/models", headers={"authorization": "Bearer test-service-key"}).status_code == 200


def test_remote_requires_service_key(monkeypatch):
    monkeypatch.delenv("BREEZE_ASR_API_KEY", raising=False)
    with TestClient(create_app(Recognizer), client=("192.0.2.1", 50000)) as client:
        assert client.get("/v1/models").status_code == 403


def test_model_rejects_unquantized_or_unverified_weights(tmp_path):
    path = tmp_path / "model.bin"
    for ftype in (0, 1):
        path.write_bytes(struct.pack("<12i", 0x67676D6C, *([0] * 10), ftype))
        with pytest.raises(RuntimeError, match="ASR_Q8_MODEL_REQUIRED"):
            verify_model(path)
    path.write_bytes(struct.pack("<12i", 0x67676D6C, *([0] * 10), 1007))
    with pytest.raises(RuntimeError, match="ASR_MODEL_CHECKSUM_MISMATCH"):
        verify_model(path)
