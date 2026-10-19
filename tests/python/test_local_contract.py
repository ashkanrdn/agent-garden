"""Exercise local routing and refresh without requiring a listening socket."""

import io
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest

from local.serve_garden import GardenHandler, RefreshState, IMPORTER, STATIC_ROOT


class MemoryConnection:
    def __init__(self, request):
        self.input = io.BytesIO(request)
        self.output = io.BytesIO()

    def makefile(self, mode, *args):
        return self.input

    def sendall(self, data):
        self.output.write(data)


class LocalContractTests(unittest.TestCase):
    def test_page_and_dataset_routes_keep_static_path_isolation(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            public = root / 'public'
            public.mkdir()
            (public / 'index.html').write_text('synthetic garden')
            (public / 'local-session-data.json').write_text('{"sessions":[]}')
            (root / 'private.txt').write_text('synthetic private file')
            (public / 'escape.txt').symlink_to(root / 'private.txt')
            server = SimpleNamespace(directory=public.resolve(), server_port=8766)
            for path, status, expected in [
                ('/', 200, b'synthetic garden'),
                ('/local-session-data.json', 200, b'{"sessions":[]}'),
                ('/escape.txt', 403, None),
                ('/%2e%2e/private.txt', 403, None),
                ('/.hidden', 403, None),
                ('/missing', 404, None),
            ]:
                with self.subTest(path=path):
                    connection = MemoryConnection(
                        f'GET {path} HTTP/1.0\r\nHost: 127.0.0.1:8766\r\n\r\n'.encode())
                    GardenHandler(connection, ('127.0.0.1', 10000), server)
                    headers, body = connection.output.getvalue().split(b'\r\n\r\n', 1)
                    self.assertIn(f' {status} '.encode(), headers.split(b'\r\n')[0])
                    if expected is not None:
                        self.assertEqual(body, expected)
                    self.assertNotIn(b'synthetic private file', body)

    def test_refresh_accepts_human_cli_summary_and_reads_only_dataset_counts(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            script = root / 'synthetic_export.py'
            script.write_text(
                'import json, sys\nfrom pathlib import Path\n'
                'Path(sys.argv[2]).write_text(json.dumps({"generatedAt":"2026-01-01T00:00:00Z",'
                '"sessions":[{},{}],"projects":[{}],"commits":[]}))\n'
                'print("Exported 2 sessions. SYNTHETIC_PRIVATE_LOG")\n')
            state = RefreshState(root, script)
            state._run('2026-01-01T00:00:00Z')
            result = state.snapshot()['lastResult']
            self.assertTrue(result['ok'])
            self.assertEqual(result['summary'], {'sessions': 2, 'projects': 1, 'commits': 0})
            self.assertNotIn('SYNTHETIC_PRIVATE_LOG', json.dumps(result))

    def test_refresh_failure_preserves_dataset_and_imported_at(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            output = root / 'local-session-data.json'
            output.write_text('{"generatedAt":"2026-01-01T00:00:00Z"}')
            script = root / 'synthetic_export.py'
            script.write_text('raise SystemExit(1)\n')
            state = RefreshState(root, script)
            state._run('2026-01-02T00:00:00Z')
            self.assertFalse(state.snapshot()['lastResult']['ok'])
            self.assertEqual(state.imported_at, '2026-01-01T00:00:00Z')
            self.assertEqual(json.loads(output.read_text())['generatedAt'], state.imported_at)

    def test_default_server_paths_point_to_carried_product(self):
        self.assertEqual(STATIC_ROOT.name, 'web')
        self.assertTrue((STATIC_ROOT / 'index.html').is_file())
        self.assertEqual(IMPORTER.name, 'agent_garden_export.py')
        self.assertTrue(IMPORTER.is_file())


if __name__ == '__main__':
    unittest.main()
