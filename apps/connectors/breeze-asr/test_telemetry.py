import base64
import json
import sqlite3
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from telemetry import Telemetry


def wait_for(check):
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        if check():
            return
        time.sleep(0.02)
    assert check()


def test_offline_restart_preserves_all_signals_and_audio(monkeypatch, tmp_path):
    received = []
    online = threading.Event()

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self):
            data = self.rfile.read(int(self.headers["Content-Length"]))
            if online.is_set():
                received.append((self.path, json.loads(data)))
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
    telemetry = Telemetry()
    try:
        with telemetry.operation("http", {}, f"00-{'a' * 32}-{'b' * 16}-01"):
            with telemetry.operation("inference", {}) as evidence:
                telemetry.audio(b"original-audio")
                evidence["gen_ai.response.text"] = "result"
        telemetry.pending.join()
        with sqlite3.connect(telemetry.path) as database:
            assert database.execute("select count(*) from events where body not like '%telemetry.delivery.health%'").fetchone()[0] == 7
        telemetry.close()
        online.set()
        telemetry = Telemetry()
        wait_for(lambda: len([body for _, body in received if "telemetry.delivery.health" not in json.dumps(body)]) >= 7)
        assert {path for path, _ in received} == {"/v1/traces", "/v1/logs", "/v1/metrics"}
        spans = [span for path, body in received if path == "/v1/traces" for group in body["resourceSpans"] for scope in group["scopeSpans"] for span in scope["spans"]]
        assert all(span["traceId"] == "a" * 32 for span in spans)
        assert next(span for span in spans if span["name"] == "http")["parentSpanId"] == "b" * 16
        assert base64.b64encode(b"original-audio").decode() in json.dumps(received)
        wait_for(lambda: sqlite3.connect(telemetry.path).execute("select count(*) from events").fetchone()[0] == 0)
    finally:
        telemetry.close()
        server.shutdown()
        server.server_close()


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
