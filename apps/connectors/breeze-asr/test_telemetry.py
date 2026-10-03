import base64
import hashlib
import io
import json
import sqlite3
import threading
import time
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest
from fastapi.testclient import TestClient

from server import create_app, safe_correlation_id
from telemetry import Telemetry


def wait_for(check):
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        if check():
            return
        time.sleep(0.02)
    assert check()


def test_asr_reply_and_offline_telemetry_keep_canaries_out_of_sqlite_and_otlp(monkeypatch, tmp_path):
    received = []
    online = threading.Event()
    audio_canary = b"G11_PRIVATE_AUDIO_CANARY"
    transcript_canary = "G11_PRIVATE_TRANSCRIPT_轉錄哨兵"
    recording = io.BytesIO()
    with wave.open(recording, "wb") as output:
        output.setnchannels(1)
        output.setsampwidth(2)
        output.setframerate(16000)
        output.writeframes(b"\x00\x00" * 16000)
    audio = recording.getvalue() + audio_canary

    class Recognizer:
        device = "test"
        quantization = "Q8_0"

        def transcribe(self, samples):
            assert len(samples) == 16000
            return transcript_canary

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self):
            data = self.rfile.read(int(self.headers["Content-Length"]))
            if online.is_set():
                received.append((self.path, data))
            self.send_response(200 if online.is_set() else 503)
            self.end_headers()
            self.wfile.write(b"{}")

        def log_message(self, *args):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    monkeypatch.setenv("OTEL_EXPORTER_OTLP_ENDPOINT", f"http://127.0.0.1:{server.server_port}")
    monkeypatch.setenv("GENIO_ONE_OTEL_SPOOL_DIR", str(tmp_path))
    monkeypatch.setenv("GENIO_ONE_TENANT_ID", "isolated-test")
    monkeypatch.delenv("BREEZE_ASR_API_KEY", raising=False)
    completed = []
    monkeypatch.setattr("server.logger.info", completed.append)
    telemetry = Telemetry()
    try:
        monkeypatch.setattr("server.Telemetry", lambda: telemetry)
        with TestClient(create_app(Recognizer), client=("127.0.0.1", 50000)) as client:
            response = client.post(
                "/v1/audio/transcriptions",
                data={"model": "breeze-asr"},
                files={"file": ("recording.wav", audio, "audio/wav")},
                headers={"x-genio-correlation-id": "g11-correlation", "traceparent": f"00-{'a' * 32}-{'b' * 16}-01"},
            )
            assert response.status_code == 200, response.text
            assert response.json() == {"text": transcript_canary}
            assert json.loads(completed[-1])["correlation_id"] == "g11-correlation"
        telemetry.pending.join()
        with sqlite3.connect(telemetry.path) as database:
            rows = database.execute("select signal, body from events where body not like '%telemetry.delivery.health%'").fetchall()
            assert len(rows) == 13
            queued = "\n".join(body for _, body in rows).encode()
            assert audio_canary not in queued
            assert base64.b64encode(audio) not in queued
            assert transcript_canary.encode() not in queued
            assert json.dumps(transcript_canary)[1:-1].encode() not in queued
            assert b"G11_PRIVATE_TRANSCRIPT_" not in queued
            assert b'"audio.payload"' not in queued
            assert b'"gen_ai.response.text"' not in queued
            assert b'"audio.sha256"' in queued
            assert hashlib.sha256(audio).hexdigest().encode() in queued
            assert b'"gen_ai.response.text_length"' in queued
            assert b'g11-correlation' in queued
            for index, key in enumerate(("audio.payload", "gen_ai.response.text", "error.message", "error.stack")):
                legacy = {"attributes": [{"key": key, "value": {"stringValue": transcript_canary}}]}
                database.execute("insert into events values (?, ?, ?, ?)", (f"legacy-{index}", time.time() - 1, "logs", json.dumps(legacy)))
        telemetry.close()
        online.set()
        telemetry = Telemetry()
        wait_for(lambda: len([body for _, body in received if b"telemetry.delivery.health" not in body]) >= 13)
        assert {path for path, _ in received} == {"/v1/traces", "/v1/logs", "/v1/metrics"}
        spans = [span for path, body in received if path == "/v1/traces" for group in json.loads(body)["resourceSpans"] for scope in group["scopeSpans"] for span in scope["spans"]]
        assert all(span["traceId"] == "a" * 32 for span in spans)
        assert next(span for span in spans if span["name"] == "asr.http")["parentSpanId"] == "b" * 16
        outbound = b"\n".join(body for _, body in received)
        assert audio_canary not in outbound
        assert base64.b64encode(audio) not in outbound
        assert transcript_canary.encode() not in outbound
        assert json.dumps(transcript_canary)[1:-1].encode() not in outbound
        assert b"G11_PRIVATE_TRANSCRIPT_" not in outbound
        assert b'"audio.payload"' not in outbound
        assert b'"gen_ai.response.text"' not in outbound
        assert b'"error.message"' not in outbound
        assert b'"error.stack"' not in outbound
        assert telemetry.dropped >= 4
        wait_for(lambda: sqlite3.connect(telemetry.path).execute("select count(*) from events").fetchone()[0] == 0)
    finally:
        telemetry.close()
        server.shutdown()
        server.server_close()


def test_correlation_falls_back_to_valid_request_id():
    assert safe_correlation_id({"x-genio-correlation-id": "invalid/value", "x-request-id": "valid-request-id"}) == "valid-request-id"
    assert safe_correlation_id({"x-genio-correlation-id": "invalid/value", "x-request-id": "also/invalid"}) == ""


def test_expired_entries_are_cleaned_without_network(monkeypatch, tmp_path):
    monkeypatch.setenv("OTEL_EXPORTER_OTLP_ENDPOINT", "http://127.0.0.1:1")
    monkeypatch.setenv("GENIO_ONE_OTEL_SPOOL_DIR", str(tmp_path))
    telemetry = Telemetry()
    try:
        wait_for(lambda: telemetry.available)
        telemetry.close()
        with sqlite3.connect(telemetry.path) as database:
            database.execute("insert into events values ('expired', ?, 'logs', '{}')", (time.time() - 7300,))
        telemetry = Telemetry()
        wait_for(lambda: telemetry.dropped > 0)
    finally:
        telemetry.close()


def test_error_class_is_recorded_without_exception_text_or_unlisted_fields(monkeypatch, tmp_path):
    canary = "G11_EXCEPTION_PRIVATE_TRANSCRIPT"
    monkeypatch.setenv("OTEL_EXPORTER_OTLP_ENDPOINT", "http://127.0.0.1:1")
    monkeypatch.setenv("GENIO_ONE_OTEL_SPOOL_DIR", str(tmp_path))
    telemetry = Telemetry()
    try:
        with pytest.raises(ValueError, match=canary):
            with telemetry.operation("asr.failure", {"gen_ai.response.text": canary}):
                raise ValueError(canary)
        telemetry.pending.join()
        with sqlite3.connect(telemetry.path) as database:
            records = "\n".join(row[0] for row in database.execute("select body from events")).encode()
        assert b'"error.type"' in records
        assert b'"ValueError"' in records
        assert canary.encode() not in records
        assert b'"gen_ai.response.text"' not in records
        assert b'"error.message"' not in records
        assert b'"error.stack"' not in records
    finally:
        telemetry.close()
