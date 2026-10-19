#!/usr/bin/env python3
"""Serve the garden on loopback and run an explicit, local data refresh.

Usage: python3 local/serve_garden.py --port 8766
The server never accepts source paths or commands through HTTP.
"""

from __future__ import annotations

import argparse
import hashlib
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import mimetypes
import os
from pathlib import Path
import shutil
import subprocess
import sys
import threading
from urllib.parse import parse_qs, unquote, urlsplit

if __package__ in (None, ''):
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from local.live_garden import LiveGardenState
from agent_garden_export import default_codex_home


REPO_ROOT = Path(__file__).resolve().parent.parent
STATIC_ROOT = REPO_ROOT / "web"
IMPORTER = REPO_ROOT / "agent_garden_export.py"
APP_ID = "agent-garden"


def workspace_identity(root: Path = REPO_ROOT) -> str:
    return hashlib.sha256(str(root.resolve()).encode()).hexdigest()[:24]


def now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


class RefreshState:
    def __init__(self, directory: Path, importer: Path):
        self.directory = directory
        self.importer = importer
        self.lock = threading.Lock()
        self.busy = False
        self.last_result = None
        self.imported_at = self.read_imported_at()

    def read_imported_at(self):
        try:
            with (self.directory / "local-session-data.json").open() as source:
                dataset = json.load(source)
            value = dataset.get("generatedAt") or dataset.get("importedAt") or dataset.get("observedAt")
            return value if isinstance(value, str) else None
        except (OSError, ValueError, AttributeError):
            return None

    def snapshot(self) -> dict:
        with self.lock:
            return {"available": True, "appId": APP_ID,
                    "workspaceId": workspace_identity(), "processId": os.getpid(),
                    "busy": self.busy,
                    "lastResult": self.last_result, "importedAt": self.imported_at}

    def start(self) -> bool:
        with self.lock:
            if self.busy:
                return False
            self.busy = True
            started_at = now()
            self.last_result = {"ok": None, "startedAt": started_at, "finishedAt": None}
        threading.Thread(target=self._run, args=(started_at,), daemon=True).start()
        return True

    def _run(self, started_at: str):
        result = {"ok": False, "startedAt": started_at}
        try:
            process = subprocess.run(
                [sys.executable, str(self.importer), "--output", str(self.directory / "local-session-data.json")],
                cwd=REPO_ROOT, capture_output=True, text=True, timeout=900,
            )
            result["ok"] = process.returncode == 0
            if result["ok"]:
                # Only count-like values enter HTTP status. Never expose raw
                # subprocess logs, paths, commands, or conversation text.
                try:
                    with (self.directory / 'local-session-data.json').open() as source:
                        data = json.load(source)
                    summary = {key: len(data.get(key, [])) for key in ('sessions', 'projects', 'commits')}
                    if isinstance(summary, dict):
                        result["summary"] = {
                            key: value for key, value in summary.items()
                            if isinstance(value, (int, float, bool)) and not isinstance(value, str)
                        }
                except (ValueError, OSError, TypeError, AttributeError):
                    pass
            else:
                result["error"] = "Import failed. Run the local importer to inspect the cause."
        except subprocess.TimeoutExpired:
            result["error"] = "Import exceeded 15 minutes. The previous dataset remains available."
        except OSError:
            result["error"] = "The local importer could not start. Check the Python installation."
        result["finishedAt"] = now()
        imported_at = self.read_imported_at() if result["ok"] else self.imported_at
        with self.lock:
            self.imported_at = imported_at
            self.last_result = result
            self.busy = False


class GardenServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, port: int, directory: Path = STATIC_ROOT, importer: Path = IMPORTER,
                 live_root: Path | None = None, poll_interval: float = 1.0,
                 initial_poll: bool | None = None):
        self.directory = directory.resolve()
        self.refresh = RefreshState(self.directory, importer.resolve())
        default_live = default_codex_home() if self.directory == STATIC_ROOT else self.directory.parent / 'codex'
        self.live = LiveGardenState(live_root or default_live,
                                    self.directory / 'local-session-data.json', poll_interval,
                                    initial_poll=(live_root is not None if initial_poll is None else initial_poll))
        self._stop_live = threading.Event()
        super().__init__(("127.0.0.1", port), GardenHandler)
        self._live_thread = threading.Thread(target=self._watch_live, daemon=True)
        self._live_thread.start()

    def _watch_live(self):
        while not self._stop_live.is_set():
            self.live.poll()
            self._stop_live.wait(self.live.poll_interval)

    def server_close(self):
        self._stop_live.set()
        super().server_close()


class GardenHandler(BaseHTTPRequestHandler):
    server: GardenServer

    def log_message(self, format, *args):
        # URLs can contain private paths. HTTP requests are intentionally quiet.
        pass

    def _local_host(self) -> str | None:
        port = self.server.server_port
        host = self.headers.get("Host", "")
        if self.client_address[0] != "127.0.0.1" or host not in {f"127.0.0.1:{port}", f"localhost:{port}"}:
            return None
        return host

    def _json(self, status: int, data: dict):
        payload = json.dumps(data, separators=(",", ":")).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(payload)

    def _same_origin_read(self, host: str) -> bool:
        origin = self.headers.get('Origin')
        referer = self.headers.get('Referer')
        if origin:
            return origin == f'http://{host}'
        if referer:
            parsed = urlsplit(referer)
            return parsed.scheme == 'http' and parsed.netloc == host
        return False

    def _events(self):
        snapshot = self.server.live.fresh_snapshot()
        self.send_response(200)
        self.send_header('Content-Type', 'text/event-stream; charset=utf-8')
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('Connection', 'keep-alive')
        self.end_headers()
        if self.command == 'HEAD':
            return
        try:
            self._sse('snapshot', snapshot)
            revision = snapshot['revision']
            while not self.server._stop_live.is_set():
                delta = self.server.live.wait_delta(revision, timeout=15)
                if delta is None:
                    self.wfile.write(b': keepalive\n\n')
                elif delta['revision'] == revision + 1 and not delta.get('reset'):
                    self._sse('upsert', delta)
                    revision = delta['revision']
                else:
                    snapshot = self.server.live.snapshot()
                    self._sse('snapshot', snapshot)
                    revision = snapshot['revision']
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError, OSError):
            pass

    def _sse(self, name, data):
        encoded = json.dumps(data, separators=(',', ':')).encode('utf-8')
        self.wfile.write(b'event: ' + name.encode() + b'\ndata: ' + encoded + b'\n\n')

    def do_POST(self):
        host = self._local_host()
        if not host or self.headers.get("Origin") != f"http://{host}":
            self._json(403, {"error": "A same-origin loopback request is required."})
            return
        if urlsplit(self.path).path != "/api/refresh":
            self._json(404, {"error": "Unknown endpoint."})
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            length = -1
        if length < 0 or length > 1024 or self.headers.get("Transfer-Encoding"):
            self._json(400, {"error": "Invalid refresh request."})
            return
        if length:
            self.rfile.read(length)
        started = self.server.refresh.start()
        self._json(202, {"busy": True, "alreadyRunning": not started})

    def do_HEAD(self):
        self.do_GET()

    def do_GET(self):
        host = self._local_host()
        if not host:
            self._json(403, {"error": "A loopback host is required."})
            return
        url = urlsplit(self.path)
        path = url.path
        if path == "/api/status":
            self._json(200, self.server.refresh.snapshot())
            return
        if path in ('/api/live/snapshot', '/api/events', '/api/live/messages'):
            if not self._same_origin_read(host):
                self._json(403, {'error': 'A same-origin loopback request is required.'})
                return
            if path == '/api/live/snapshot':
                self._json(200, self.server.live.fresh_snapshot())
                return
            if path == '/api/events':
                self._events()
                return
            params = parse_qs(url.query)
            root = params.get('rootSessionId', [''])[0]
            agent = params.get('agentId', [None])[0]
            cursor = params.get('cursor', [None])[0]
            try:
                limit = int(params.get('limit', ['20'])[0])
            except ValueError:
                limit = 0
            if not root or not 1 <= limit <= 50 or cursor is not None and len(cursor) > 512:
                self._json(400, {'error': 'Invalid message request.'})
                return
            try:
                result = self.server.live.messages(root, agent, cursor, limit)
            except ValueError:
                self._json(400, {'error': 'Invalid message cursor.'})
                return
            self._json(200, result) if result is not None else self._json(404, {'error': 'Unknown agent tree.'})
            return
        if path.startswith("/api/"):
            self._json(404, {"error": "Unknown endpoint."})
            return
        try:
            decoded = unquote(path)
            if "\0" in decoded:
                raise ValueError("invalid path")
            target = (self.server.directory / (decoded.lstrip("/") or "index.html")).resolve()
            target.relative_to(self.server.directory)
            if any(part.startswith(".") for part in Path(decoded).parts if part not in {"/", "."}):
                raise ValueError("hidden path")
        except (ValueError, OSError):
            self._json(403, {"error": "Path is outside the public garden."})
            return
        if not target.is_file():
            self._json(404, {"error": "File not found. Directory listings are disabled."})
            return
        try:
            source = target.open("rb")
        except OSError:
            self._json(404, {"error": "File unavailable."})
            return
        with source:
            self.send_response(200)
            self.send_header("Content-Type", mimetypes.guess_type(str(target))[0] or "application/octet-stream")
            self.send_header("Content-Length", str(os.fstat(source.fileno()).st_size))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.end_headers()
            if self.command != "HEAD":
                shutil.copyfileobj(source, self.wfile)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=8766)
    args = parser.parse_args()
    server = GardenServer(args.port)
    print(f"Garden: http://127.0.0.1:{server.server_port}/index.html", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
