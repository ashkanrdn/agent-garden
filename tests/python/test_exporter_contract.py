"""Synthetic adapter, CLI, and publication-contract checks."""

import ast
import copy
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

import agent_garden_export as exporter


AT = '2026-01-01T00:00:00.000Z'


class FixtureAdapter:
    def __init__(self, records, edges=()):
        self.records, self.edges = records, edges

    def read(self, cutoff):
        return exporter.SourceBatch(self.records, [{
            'id': 'fixture-source', 'kind': 'fixture', 'records': 2, 'errors': 0,
        }], self.edges)


def record(sid, agent='fixture'):
    value = exporter.normalized_session(sid, agent)
    value.update(createdAt=AT, updatedAt=AT, cwd='/synthetic/workspace',
                 sourceIds=['fixture-source'], rolloutCount=1)
    value['_events']['operation-one'] = {'at': AT, 'kind': 'tool', 'count': 1}
    return value


class ExporterContractTests(unittest.TestCase):
    def test_adapter_merge_lineage_and_enrichment_share_one_pipeline(self):
        root = record('fixture:root')
        child = record('fixture:child')
        child.update(isSubagent=True, parentId=root['id'])
        duplicate = copy.deepcopy(root)
        duplicate['_events']['operation-two'] = {'at': AT, 'kind': 'turn', 'count': 2}
        data = exporter.build_dataset(adapters=[FixtureAdapter([root, child, duplicate])], cutoff=AT)
        self.assertEqual(len(data['sessions']), 2)
        self.assertEqual(len(data['projects']), 1)
        sessions = {item['id']: item for item in data['sessions']}
        self.assertEqual(sessions[root['id']]['agentIds'], [child['id']])
        self.assertEqual(sessions[child['id']]['rootSessionId'], root['id'])
        self.assertEqual(data['coverage']['recordedToolOperations'], 2)
        self.assertEqual(data['coverage']['recordedTurns'], 2)
        self.assertEqual(root['agentIds'], [], 'The shared pipeline must not mutate adapter records')
        self.assertEqual(data['workScore']['weights'], {
            'tool': 1, 'turn': 2, 'distinctFile': 3, 'agent': 4, 'ownedCommit': 5,
        })
        self.assertFalse(any(key.startswith('_') for item in data['sessions'] for key in item))

    def test_different_agents_cannot_silently_share_an_id(self):
        with self.assertRaisesRegex(ValueError, 'namespaced'):
            exporter.build_dataset(adapters=[FixtureAdapter([
                record('same', 'codex'), record('same', 'fixture'),
            ])], cutoff=AT)

    def test_codex_defaults_to_environment_and_backup_is_optional(self):
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            self.write_history(home)
            with patch.dict(os.environ, {'CODEX_HOME': str(home)}):
                data = exporter.build_dataset(enrich_git=False)
            self.assertEqual([source['kind'] for source in data['sources']], ['codex-live'])
            self.assertEqual(data['generator']['name'], 'agent-garden-export')
            self.assertFalse(data['redacted'])
            self.assertEqual(data['sessions'][0]['agent'], 'codex')
            self.assertNotIn('SYNTHETIC_PRIVATE_MESSAGE', json.dumps(data))

    def test_backup_copies_deduplicate_before_count_evidence_is_normalized(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            self.write_history(base / 'live')
            self.write_history(base / 'backup/Codex/current')
            data = exporter.build_dataset(base / 'live', base / 'backup', enrich_git=False)
            self.assertEqual(len(data['sessions']), 1)
            self.assertEqual(data['coverage']['recordedToolOperations'], 1)
            self.assertEqual(data['sessions'][0]['sourceIds'], ['backup-current', 'live'])
            self.assertEqual(data['sources'][0]['kind'], 'codex-backup')

    def test_cli_default_output_summary_and_hidden_alias(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            home = base / 'history'
            self.write_history(home)
            script = Path(exporter.__file__).resolve()
            env = dict(os.environ, CODEX_HOME=str(home), PYTHONDONTWRITEBYTECODE='1')
            command = [sys.executable, str(script), '--skip-git']
            result = subprocess.run(command, cwd=base, env=env, text=True, capture_output=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertTrue((base / 'agent-garden.json').is_file())
            self.assertIn('1 sessions, 0 projects, 0 commits', result.stdout)
            self.assertIn('bytes)', result.stdout)
            result = subprocess.run(command + ['--live-root', str(home), '--output', 'alias.json'],
                                    cwd=base, env=env, text=True, capture_output=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertTrue((base / 'alias.json').is_file())
            result = subprocess.run([sys.executable, str(script), '--help'], env=env,
                                    text=True, capture_output=True)
            self.assertIn('--codex-home', result.stdout)
            self.assertNotIn('--live-root', result.stdout)

    def test_failed_output_replacement_preserves_previous_dataset(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'data.json'
            exporter.write_dataset({'generation': 1}, path)
            with patch.object(exporter.os, 'replace', side_effect=OSError('synthetic failure')):
                with self.assertRaises(OSError):
                    exporter.write_dataset({'generation': 2}, path)
            self.assertEqual(json.loads(path.read_text()), {'generation': 1})
            self.assertEqual(list(path.parent.iterdir()), [path])

    def test_python_39_grammar_and_deferred_annotations(self):
        source = Path(exporter.__file__).read_text()
        tree = ast.parse(source, feature_version=(3, 9))
        self.assertTrue(any(isinstance(node, ast.ImportFrom) and node.module == '__future__'
                            and any(alias.name == 'annotations' for alias in node.names)
                            for node in tree.body))

    @staticmethod
    def write_history(home):
        rollouts = home / 'sessions'
        rollouts.mkdir(parents=True)
        rows = [
            {'type': 'session_meta', 'timestamp': AT, 'payload': {
                'id': 'synthetic-session', 'timestamp': AT, 'cwd': '/synthetic/workspace',
            }},
            {'type': 'response_item', 'timestamp': AT, 'payload': {
                'type': 'function_call', 'call_id': 'synthetic-call', 'name': 'exec_command',
                'arguments': 'SYNTHETIC_PRIVATE_MESSAGE',
            }},
        ]
        (rollouts / 'synthetic.jsonl').write_text('\n'.join(json.dumps(row) for row in rows) + '\n')


if __name__ == '__main__':
    unittest.main()
