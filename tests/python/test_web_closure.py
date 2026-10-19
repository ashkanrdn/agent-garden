"""Validate the static site's imports, CSS, and generated worker dependency."""

from pathlib import Path
import re
import unittest


WEB = Path(__file__).resolve().parents[2] / 'web'


class WebClosureTests(unittest.TestCase):
    def test_local_dependencies_exist_inside_static_root(self):
        queue = [WEB / 'index.html']
        visited = set()
        while queue:
            path = queue.pop().resolve()
            if path in visited:
                continue
            visited.add(path)
            path.relative_to(WEB.resolve())
            self.assertTrue(path.is_file(), path.name)
            if path.suffix not in ('.js', '.css', '.html'):
                continue
            text = path.read_text()
            if path.suffix == '.js':
                refs = re.findall(
                    r'''(?:\bfrom\s*|\bimport\s*(?:\(\s*)?|\bnew URL\(\s*)['"]([^'"]+)['"]''', text)
            elif path.suffix == '.html':
                refs = re.findall(r'''(?:src|href)=["']([^"']+)["']''', text)
            else:
                refs = re.findall(r'''url\(["']?([^\)"']+)''', text)
            for ref in refs:
                if path.suffix == '.js' and not ref.startswith(('./', '../')):
                    continue
                if ref.startswith(('#', 'data:', 'http:', 'https:', '/api/')):
                    continue
                queue.append(path.parent / ref.split('?')[0].split('#')[0])
        self.assertIn((WEB / 'garden-hill-environment.js').resolve(), visited)
        self.assertIn((WEB / 'vendor/p5-brush-2.2.2/brush.esm.js').resolve(), visited)
        runtime = {path.resolve() for path in WEB.rglob('*')
                   if path.is_file() and path.suffix in ('.js', '.css', '.html')}
        self.assertEqual(visited, runtime, 'The static root must contain only its runtime closure and notices')

    def test_worker_module_and_local_dataset_paths_remain_explicit(self):
        source = (WEB / 'canvas-garden.js').read_text()
        self.assertIn("new URL('./garden-hill-environment.js',import.meta.url)", source)
        self.assertIn("fetch('local-session-data.json?refresh='", source)
        self.assertNotIn('tools/import_garden_sessions.py', source)


if __name__ == '__main__':
    unittest.main()
