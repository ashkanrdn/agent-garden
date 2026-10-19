"""Launch reliability checks. No imports or user-browser actions run here."""

from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import signal
import socket
import subprocess
import sys
import threading
import time
import unittest
from unittest.mock import patch

TOOLS = Path(__file__).resolve().parents[2] / "local"
sys.path.insert(0, str(TOOLS))
import start_garden as launcher


@contextmanager
def status_service(payload):
    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            data = json.dumps(payload).encode()
            self.send_response(200)
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def log_message(self, *args):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield server.server_port
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)


class GardenLauncherTests(unittest.TestCase):
    def test_unrelated_service_is_not_reused_or_replaced(self):
        with status_service({"available": True}) as port, patch.object(launcher.subprocess, "Popen") as spawn:
            with self.assertRaisesRegex(launcher.LaunchError, "unverified service"):
                launcher.start_or_reuse(port)
            spawn.assert_not_called()

    def test_other_workspace_is_not_reused_or_replaced(self):
        status = {"available": True, "appId": launcher.APP_ID, "workspaceId": "another-workspace"}
        with status_service(status) as port, patch.object(launcher.subprocess, "Popen") as spawn:
            with self.assertRaisesRegex(launcher.LaunchError, "different garden workspace"):
                launcher.start_or_reuse(port)
            spawn.assert_not_called()

    @unittest.skipUnless(hasattr(os, "getsid"), "Detached process sessions require POSIX.")
    def test_detached_server_survives_launcher_and_is_reused(self):
        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0))
            port = sock.getsockname()[1]
        command = [sys.executable, str(TOOLS / "start_garden.py"), "--no-open", "--port", str(port)]
        pid = None
        try:
            # An unrelated cwd verifies that launcher paths resolve from source.
            first = subprocess.run(command, cwd=TOOLS.parent / "tests", capture_output=True,
                                   text=True, timeout=12)
            self.assertEqual(first.returncode, 0, first.stderr)
            status = launcher.probe_server(port)
            self.assertIsNotNone(status)
            pid = status["processId"]
            self.assertIn("Started garden server", first.stdout)
            self.assertEqual(os.getsid(pid), pid)
            self.assertTrue((launcher.RUNTIME / f"server-{port}.log").exists())
            self.assertEqual((launcher.RUNTIME / f"server-{port}.pid").read_text().strip(), str(pid))
            second = subprocess.run(command, cwd=TOOLS.parent / "tests", capture_output=True,
                                    text=True, timeout=3)
            self.assertEqual(second.returncode, 0, second.stderr)
            self.assertIn("Reused garden server", second.stdout)
            self.assertEqual(launcher.probe_server(port)["processId"], pid)
        finally:
            # Only this test's newly launched, verified child is stopped.
            if pid is not None:
                status = launcher.probe_server(port)
                if status and status.get("processId") == pid:
                    os.kill(pid, signal.SIGTERM)
                    deadline = time.monotonic() + 2
                    while time.monotonic() < deadline:
                        try:
                            status = launcher.probe_server(port)
                        except launcher.LaunchError:
                            # A connection reset is valid while the verified child exits.
                            status = True
                        if status is None:
                            break
                        time.sleep(0.05)
            for extension in ("pid", "log"):
                (launcher.RUNTIME / f"server-{port}.{extension}").unlink(missing_ok=True)


if __name__ == "__main__":
    unittest.main()
