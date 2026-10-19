"""Public CLI and recursive privacy checks use synthetic data only."""
import copy
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from contextlib import redirect_stdout, redirect_stderr
from unittest.mock import patch

import agent_garden_export as exporter


FIXTURE = Path(__file__).resolve().parents[1] / 'fixtures' / 'claude-code'
SCRIPT = Path(exporter.__file__).resolve()


def strings(value):
    if isinstance(value, str):
        yield value
    elif isinstance(value, dict):
        for child in value.values():
            yield from strings(child)
    elif isinstance(value, list):
        for child in value:
            yield from strings(child)


class ExportCliTests(unittest.TestCase):
    def run_cli(self, base, *args, env=None):
        environment = dict(os.environ, CODEX_HOME=str(base / 'missing-codex'),
                           CLAUDE_CONFIG_DIR=str(FIXTURE), PYTHONDONTWRITEBYTECODE='1')
        environment.update(env or {})
        return subprocess.run([sys.executable, str(SCRIPT), *args], cwd=base, env=environment,
                              text=True, capture_output=True)

    def test_default_all_skips_missing_source_and_writes_default_file(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            result = self.run_cli(base, '--no-git')
            self.assertEqual(result.returncode, 0, result.stderr)
            data = json.loads((base / 'agent-garden.json').read_text())
            self.assertEqual({source['kind'] for source in data['sources']}, {'codex-live', 'claude-code'})
            self.assertEqual(len(data['sessions']), 7)
            self.assertEqual(len(result.stderr.splitlines()), 1)
            self.assertIn('codex-live', result.stderr)
            self.assertIn('claude-code (claude-code): 7 sessions', result.stdout)
            self.assertIn('Exported 7 sessions, 1 projects, 0 commits.', result.stdout)
            self.assertIn(str(base / 'agent-garden.json'), result.stdout)

    def test_all_sources_merge_through_one_project_pipeline(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            home = base / 'codex' / 'sessions'
            home.mkdir(parents=True)
            (home / 'synthetic.jsonl').write_text(json.dumps({
                'type': 'session_meta', 'timestamp': '2026-01-01T00:00:00Z',
                'payload': {'id': 'synthetic-codex', 'cwd': '/synthetic/cedar-studio',
                            'timestamp': '2026-01-01T00:00:00Z'},
            }) + '\n')
            result = self.run_cli(base, '--no-git', '--codex-home', str(home.parent))
            self.assertEqual(result.returncode, 0, result.stderr)
            data = json.loads((base / 'agent-garden.json').read_text())
            self.assertEqual(len(data['sessions']), 8)
            self.assertEqual(len(data['projects']), 1)
            self.assertEqual({session['agent'] for session in data['sessions']}, {'codex', 'claude-code'})
            result = self.run_cli(base, '--source', 'codex', '--no-git', '--codex-home', str(home.parent))
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(len(json.loads((base / 'agent-garden.json').read_text())['sessions']), 1)

    def test_selected_claude_source_and_explicit_home_override_environment(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            result = self.run_cli(base, '--source', 'claude-code', '--claude-home', str(FIXTURE),
                                  '--no-git', '--output', 'nested/custom.json',
                                  env={'CLAUDE_CONFIG_DIR': str(base / 'missing')})
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(result.stderr, '')
            data = json.loads((base / 'nested/custom.json').read_text())
            self.assertEqual([source['kind'] for source in data['sources']], ['claude-code'])

    def test_no_sessions_fails_without_replacing_output(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            output = base / 'agent-garden.json'
            output.write_text('previous synthetic output')
            result = self.run_cli(base, '--no-git', env={'CLAUDE_CONFIG_DIR': str(base / 'missing')})
            self.assertEqual(result.returncode, 1)
            self.assertEqual(result.stderr.count('is missing; skipped.'), 2)
            self.assertIn('No sessions found', result.stderr)
            self.assertEqual(output.read_text(), 'previous synthetic output')

    def test_no_git_runs_no_git_commands_but_keeps_projects(self):
        output, errors = io.StringIO(), io.StringIO()
        with tempfile.TemporaryDirectory() as directory, patch.object(exporter, '_git') as git:
            with redirect_stdout(output), redirect_stderr(errors):
                exporter.main(['--source', 'claude-code', '--claude-home', str(FIXTURE),
                               '--no-git', '--output', str(Path(directory) / 'data.json')])
            git.assert_not_called()
            data = json.loads((Path(directory) / 'data.json').read_text())
            self.assertEqual(len(data['projects']), 1)
            self.assertEqual(data['commits'], [])
            self.assertEqual(data['coverage']['git']['gitProjects'][0]['status'], 'skipped')
            self.assertEqual(data['projects'][0]['gitUnavailableReason'], 'git-inspection-skipped')

    def test_help_has_flags_and_plain_privacy_statement(self):
        with tempfile.TemporaryDirectory() as directory:
            result = self.run_cli(Path(directory), '--help')
        self.assertEqual(result.returncode, 0)
        for flag in ('--source', '--codex-home', '--claude-home', '--backup-root', '--output', '--no-git', '--redact'):
            self.assertIn(flag, result.stdout)
        text = ' '.join(result.stdout.split())
        self.assertIn('No message text, prompts, tool output, or file contents are written.', text)
        self.assertNotIn('--skip-git', text)

    def test_redacted_cli_output_has_no_original_private_strings(self):
        with tempfile.TemporaryDirectory(prefix='history-private-', dir='/tmp') as directory:
            base = Path(directory)
            home = base / 'history-store'
            shutil.copytree(FIXTURE, home)
            environment = {'CLAUDE_CONFIG_DIR': str(home)}
            args = ('--source', 'claude-code', '--no-git')
            result = self.run_cli(base, *args, env=environment)
            self.assertEqual(result.returncode, 0, result.stderr)
            original = json.loads((base / 'agent-garden.json').read_text())
            result = self.run_cli(base, *args, '--redact', '--output', 'redacted.json', env=environment)
            self.assertEqual(result.returncode, 0, result.stderr)
            redacted = json.loads((base / 'redacted.json').read_text())
        forbidden = {project['name'] for project in original['projects']}
        forbidden.update(session['title'] for session in original['sessions'])
        forbidden.update(session['gitContext']['branch'] for session in original['sessions'])
        # Every original path segment must disappear, including source directories.
        self.assertTrue(all('path' not in source for source in redacted['sources']))
        paths = [source['path'] for source in original['sources']]
        paths += [session['cwd'] for session in original['sessions']]
        paths += [file['path'] for session in original['sessions'] for file in session['files']]
        forbidden.update(part for path in paths for part in Path(path).parts if part != '/')
        for value in strings(redacted):
            self.assertFalse(os.path.isabs(value), value)
            for secret in forbidden:
                self.assertNotIn(secret, value)
        self.assertTrue(redacted['redacted'])
        self.assertEqual([project['name'] for project in redacted['projects']], ['project-1'])
        self.assertTrue(all('title' not in session and 'cwd' not in session for session in redacted['sessions']))
        original_files = [file for session in original['sessions'] for file in session['files']]
        redacted_files = [file for session in redacted['sessions'] for file in session['files']]
        for before, after in zip(original_files, redacted_files):
            self.assertEqual(len(Path(before['path']).parts), len(Path(after['path']).parts))
            self.assertEqual(Path(before['path']).suffix, Path(after['path']).suffix)
            self.assertEqual(before['events'], after['events'])
            self.assertEqual(before['bytes'], after['bytes'])

    def test_redaction_is_deterministic_and_preserves_graphs_and_renames(self):
        original = exporter.build_dataset(adapters=[exporter.ClaudeCodeAdapter(FIXTURE)], include_git=False)
        project = original['projects'][0]
        first, second = 'a' * 40, 'b' * 40
        root = next(session for session in original['sessions'] if session['id'] == 'claude-code:session-main')
        root['gitContext']['sha'] = second
        root['files'][0]['events'][0]['previousPath'] = '/synthetic/cedar-studio/old/leaf.md'
        original['commits'] = [
            {'id': project['id'] + ':' + first, 'projectId': project['id'], 'sha': first,
             'parentShas': [], 'parents': [], 'branches': ['feature/leaf-work'], 'sessionId': None},
            {'id': project['id'] + ':' + second, 'projectId': project['id'], 'sha': second,
             'parentShas': [first], 'parents': [first], 'branches': [], 'sessionId': root['id']},
        ]
        before = copy.deepcopy(original)
        redacted = exporter.redact_dataset(original)
        self.assertEqual(original, before)
        self.assertEqual(redacted, exporter.redact_dataset(original))
        commits = redacted['commits']
        self.assertEqual(commits[1]['parentShas'], [commits[0]['sha']])
        self.assertEqual(commits[1]['parents'], [commits[0]['sha']])
        sessions = {session['id']: session for session in redacted['sessions']}
        changed_root = sessions[commits[1]['sessionId']]
        self.assertEqual(changed_root['gitContext']['sha'], commits[1]['sha'])
        self.assertEqual(changed_root['gitContext']['branch'], commits[0]['branches'][0])
        self.assertEqual(changed_root['projectId'], redacted['projects'][0]['id'])
        self.assertTrue(all(sessions[sid]['rootSessionId'] == changed_root['id'] for sid in changed_root['agentIds']))
        self.assertTrue(all(sid in sessions for sid in redacted['projects'][0]['sessionIds']))
        self.assertEqual(changed_root['sourceIds'], [redacted['sources'][0]['id']])
        for value in strings(redacted):
            for secret in (first, second, 'feature/leaf-work', 'cedar-studio', 'leaf.md'):
                self.assertNotIn(secret, value)


if __name__ == '__main__':
    unittest.main()
