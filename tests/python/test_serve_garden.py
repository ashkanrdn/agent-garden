"""Verify local refresh boundaries and static-file restrictions."""

import http.client
import json
from pathlib import Path
import tempfile
import threading
import time
import unittest
from unittest import mock

from local.serve_garden import GardenServer


class GardenServerTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.base = Path(self.temp.name)
        self.public = self.base / "public"
        self.public.mkdir()
        (self.public / "index.html").write_text("garden")
        (self.base / "private.txt").write_text("private fixture")
        (self.public / "escape.txt").symlink_to(self.base / "private.txt")
        (self.public / "directory").mkdir()
        importer = self.base / "fixture_import.py"
        importer.write_text(
            'import json, sys, time\nfrom pathlib import Path\n'
            'time.sleep(0.1)\n'
            'Path(sys.argv[2]).write_text(json.dumps({"generatedAt":"2026-09-17T00:00:00Z","sessions":[{}, {}, {}]}))\n'
            'print(json.dumps({"sessions":3,"privateLog":"must not escape"}))\n'
        )
        self.server = GardenServer(0, self.public, importer)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.host = f"127.0.0.1:{self.server.server_port}"

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()
        self.temp.cleanup()

    def request(self, method, path, headers=None):
        connection = http.client.HTTPConnection("127.0.0.1", self.server.server_port, timeout=3)
        connection.request(method, path, headers=headers or {})
        response = connection.getresponse()
        body = response.read()
        status = response.status
        connection.close()
        return status, body

    def test_nonlocal_host_and_cross_origin_refresh_are_rejected(self):
        self.assertEqual(self.request("GET", "/api/status", {"Host": "attacker.invalid"})[0], 403)
        self.assertEqual(self.request("POST", "/api/refresh", {"Origin": "https://attacker.invalid"})[0], 403)
        self.assertEqual(self.request("POST", "/api/refresh")[0], 403)
        self.assertFalse(self.server.refresh.snapshot()["busy"])

    def test_static_escape_and_directory_listing_are_rejected(self):
        self.assertEqual(self.request("GET", "/index.html"), (200, b"garden"))
        self.assertEqual(self.request("GET", "/escape.txt")[0], 403)
        self.assertEqual(self.request("GET", "/%2e%2e/private.txt")[0], 403)
        self.assertEqual(self.request("GET", "/directory/")[0], 404)

    def test_refresh_is_single_job_and_status_is_safe(self):
        headers = {"Origin": f"http://{self.host}"}
        first_status, first_body = self.request("POST", "/api/refresh", headers)
        self.assertEqual(first_status, 202)
        self.assertFalse(json.loads(first_body)["alreadyRunning"])
        status, body = self.request("POST", "/api/refresh", headers)
        self.assertEqual(status, 202)
        self.assertTrue(json.loads(body)["alreadyRunning"])
        deadline = time.monotonic() + 3
        while self.server.refresh.snapshot()["busy"] and time.monotonic() < deadline:
            time.sleep(0.02)
        status, body = self.request("GET", "/api/status")
        result = json.loads(body)
        self.assertEqual(status, 200)
        self.assertFalse(result["busy"])
        self.assertTrue(result["lastResult"]["ok"])
        self.assertEqual(result["lastResult"]["summary"], {"sessions": 3, "projects": 0, "commits": 0})
        self.assertEqual(result["importedAt"], "2026-09-17T00:00:00Z")
        self.assertNotIn(b"must not escape", body)

    def test_atomic_dataset_replacement_keeps_response_length_consistent(self):
        target = (self.public / "local-session-data.json").resolve()
        target.write_text('{"sessions":1}')
        original_open = Path.open

        def open_then_replace(path, *args, **kwargs):
            source = original_open(path, *args, **kwargs)
            if path == target and args and args[0] == "rb":
                replacement = target.with_suffix(".tmp")
                replacement.write_text('{"sessions":123456789}')
                replacement.replace(target)
            return source

        with mock.patch.object(Path, "open", open_then_replace):
            self.assertEqual(self.request("GET", "/local-session-data.json"), (200, b'{"sessions":1}'))


if __name__ == "__main__":
    unittest.main()
