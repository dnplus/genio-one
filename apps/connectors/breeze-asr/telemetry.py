import base64
import contextvars
import hashlib
import json
import logging
import os
import queue
import re
import secrets
import sqlite3
import threading
import time
import urllib.request
import urllib.error
import traceback
from contextlib import contextmanager, closing
from pathlib import Path

_context = contextvars.ContextVar("asr_observation", default=None)


class Telemetry:
    def __init__(self):
        self.origin = os.getenv("OTEL_EXPORTER_OTLP_ENDPOINT", "").rstrip("/")
        self.path = Path(os.getenv("GENIO_ONE_OTEL_SPOOL_DIR", ".local/otel-outbox")) / "asr.sqlite"
        self.pending = queue.Queue(maxsize=128)
        self.stopped = threading.Event()
        self.pending_bytes = 0
        self.pending_lock = threading.Lock()
        self.storage_failed = False
        self.dropped = 0
        self.started_at = time.time()
        self.failures = 0
        self.last_success = None
        self.available = False
        self.threads = []
        if self.origin:
            for target in (self._write, self._send):
                worker = threading.Thread(target=target, daemon=True)
                worker.start()
                self.threads.append(worker)

    def _database(self):
        self.path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        database = sqlite3.connect(self.path, timeout=1)
        database.execute("pragma auto_vacuum=incremental")
        database.execute("pragma journal_mode=wal")
        database.execute("pragma synchronous=full")
        database.execute("create table if not exists events (id text primary key, created real not null, signal text not null, body text not null)")
        database.commit()
        os.chmod(self.path, 0o600)
        return database

    def _drop(self, reason, count=1):
        self.dropped += count
        logging.getLogger("genio.asr.telemetry").warning(json.dumps({"event": "telemetry.asr.dropped", "reason": reason, "count": count}))

    def _write(self):
        database = None
        while not self.stopped.is_set():
            try:
                database = self._database()
                self.available = True
                self.storage_failed = False
                break
            except Exception:
                self.storage_failed = True
                self._drop("STORAGE_UNAVAILABLE")
                self.stopped.wait(1)
        if database is None:
            return
        last_cleanup = 0
        try:
            while not self.stopped.is_set() or not self.pending.empty():
                try:
                    signal, body, size = self.pending.get(timeout=0.2)
                    try:
                        database.execute("insert into events values (?, ?, ?, ?)", (secrets.token_hex(16), time.time(), signal, body))
                        database.commit()
                    except Exception:
                        database.rollback()
                        self._drop("STORAGE_WRITE")
                    finally:
                        with self.pending_lock:
                            self.pending_bytes -= size
                        self.pending.task_done()
                except queue.Empty:
                    pass
                if time.time() - last_cleanup > 30:
                    try:
                        removed = database.execute("delete from events where created < ?", (time.time() - 7200,)).rowcount
                        removed += database.execute("delete from events where id in (select id from (select id, sum(length(body)) over (order by created desc, id desc) as retained from events) where retained > 268435456)").rowcount
                        database.commit()
                        database.execute("pragma incremental_vacuum(256)")
                        if removed:
                            self._drop("AGE_OR_CAPACITY", removed)
                    except Exception:
                        database.rollback()
                    last_cleanup = time.time()
                    health = {"scope": "PROCESS", "started_at": self.started_at, "observed_at": time.time(), "dropped_records": self.dropped, "pending_bytes": self.pending_bytes, "consecutive_failures": self.failures, "last_success_at": self.last_success, "storage_failed": self.storage_failed}
                    self.emit("logs", self.packet("logs", [{"timeUnixNano": str(time.time_ns()), "severityText": "WARN" if self.failures else "INFO", "severityNumber": 13 if self.failures else 9, "body": {"stringValue": "telemetry.delivery.health"}, "attributes": [{"key": "genio.delivery.health", "value": {"stringValue": json.dumps(health)}}]}]))
        finally:
            database.close()

    def _send(self):
        delay = 1
        while not self.stopped.wait(0.2):
            if not self.available:
                continue
            try:
                with closing(self._database()) as database:
                    rows = database.execute("select id, signal, body from events order by created, id limit 16").fetchall()
                    for identifier, signal, body in rows:
                        request = urllib.request.Request(f"{self.origin}/v1/{signal}", data=body.encode(), headers={"content-type": "application/json"})
                        try:
                            with urllib.request.urlopen(request, timeout=5) as response:
                                result = json.loads(response.read() or "{}")
                        except urllib.error.HTTPError as error:
                            if 400 <= error.code < 500 and error.code not in (408, 429):
                                self._drop("COLLECTOR_REJECTION")
                                database.execute("delete from events where id = ?", (identifier,))
                                database.commit()
                                continue
                            raise
                        partial = result.get("partialSuccess", result.get("partial_success", {}))
                        if any(key.startswith("rejected") and int(value) > 0 for key, value in partial.items() if key.startswith("rejected")):
                            self._drop("COLLECTOR_PARTIAL_REJECTION")
                        database.execute("delete from events where id = ?", (identifier,))
                        database.commit()
                delay = 1
                if rows:
                    self.last_success = time.time()
                self.failures = 0
            except Exception:
                self.failures += 1
                self.stopped.wait(delay)
                delay = min(delay * 2, 30)

    def emit(self, signal, body):
        if not self.origin:
            return
        if self.storage_failed:
            self._drop("STORAGE_UNAVAILABLE")
            return
        encoded = json.dumps(body)
        size = len(encoded.encode())
        with self.pending_lock:
            if self.pending_bytes + size > 16 * 1024 * 1024:
                self._drop("MEMORY_CAPACITY")
                return
            try:
                self.pending.put_nowait((signal, encoded, size))
                self.pending_bytes += size
            except queue.Full:
                self._drop("MEMORY_CAPACITY")

    def resource(self):
        values = {"service.name": "genio-connector-breeze-asr", "service.version": os.getenv("GENIO_ONE_BUILD_REVISION", "0.1.0"), "service.instance.id": f"{os.uname().nodename}:{os.getpid()}", "genio.tenant.id": os.getenv("GENIO_ONE_TENANT_ID", "unassigned"), "genio.build.availability": "CAPTURED" if os.getenv("GENIO_ONE_BUILD_REVISION") else "NOT_CONFIGURED"}
        return {"attributes": [{"key": key, "value": {"stringValue": value}} for key, value in values.items()]}

    def packet(self, signal, values):
        resource_key, scope_key, item_key = {"traces": ("resourceSpans", "scopeSpans", "spans"), "logs": ("resourceLogs", "scopeLogs", "logRecords"), "metrics": ("resourceMetrics", "scopeMetrics", "metrics")}[signal]
        return {resource_key: [{"resource": self.resource(), scope_key: [{"scope": {"name": "genio.asr"}, item_key: values}]}]}

    @contextmanager
    def operation(self, name, attributes, traceparent=None):
        parent = _context.get()
        match = re.fullmatch(r"00-([a-f0-9]{32})-([a-f0-9]{16})-[a-f0-9]{2}", traceparent or "")
        trace = parent[0] if parent else match[1] if match else secrets.token_hex(16)
        parent_span = parent[1] if parent else match[2] if match else None
        span = secrets.token_hex(8)
        token = _context.set((trace, span))
        started = time.time_ns()
        details = dict(attributes)
        failed = False
        try:
            yield details
        except BaseException as error:
            failed = True
            details.update({"error.type": type(error).__name__, "error.message": str(error), "error.stack": traceback.format_exc()})
            raise
        finally:
            ended = time.time_ns()
            failed = failed or int(details.get("http.response.status_code", 200)) >= 400
            fields = [{"key": key, "value": {"stringValue": str(value)}} for key, value in details.items()]
            fields.append({"key": "genio.outcome", "value": {"stringValue": "CANCELLED" if details.get("error.type") == "CancelledError" else "FAILED" if failed else "COMPLETED"}})
            observation = {"traceId": trace, "spanId": span, "name": name, "kind": 1, "startTimeUnixNano": str(started), "endTimeUnixNano": str(ended), "attributes": fields, "status": {"code": 2 if failed else 1}}
            if parent_span:
                observation["parentSpanId"] = parent_span
            self.emit("traces", self.packet("traces", [observation]))
            log = {"timeUnixNano": str(ended), "traceId": trace, "spanId": span, "severityNumber": 17 if failed else 9, "severityText": "ERROR" if failed else "INFO", "body": {"stringValue": name}, "attributes": fields}
            self.emit("logs", self.packet("logs", [log]))
            duration = (ended - started) / 1000000000
            point = {"startTimeUnixNano": str(started), "timeUnixNano": str(ended), "count": "1", "sum": duration, "bucketCounts": ["1"], "explicitBounds": [], "attributes": [{"key": "operation", "value": {"stringValue": name}}], "exemplars": [{"timeUnixNano": str(ended), "asDouble": duration, "traceId": trace, "spanId": span}]}
            metric = {"name": "asr.operation.duration", "unit": "s", "histogram": {"aggregationTemporality": 1, "dataPoints": [point]}}
            self.emit("metrics", self.packet("metrics", [metric]))
            _context.reset(token)

    def audio(self, data):
        trace, span = _context.get() or (secrets.token_hex(16), secrets.token_hex(8))
        digest = hashlib.sha256(data).hexdigest()
        if not self.origin:
            return digest
        fields = {"audio.sha256": digest, "audio.bytes": str(len(data)), "audio.encoding": "base64", "audio.payload": base64.b64encode(data).decode()}
        event = {"timeUnixNano": str(time.time_ns()), "traceId": trace, "spanId": span, "body": {"stringValue": "asr.audio.input"}, "attributes": [{"key": key, "value": {"stringValue": value}} for key, value in fields.items()]}
        self.emit("logs", self.packet("logs", [event]))
        return digest

    def close(self):
        self.stopped.set()
        for thread in self.threads:
            thread.join(timeout=1)
