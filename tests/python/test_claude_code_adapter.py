"""Synthetic Claude records: ownership, explicit edit outcomes, and privacy."""
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import agent_garden_export as exporter


FIXTURE = Path(__file__).resolve().parents[1] / 'fixtures' / 'claude-code'
CUTOFF = '2026-02-01T00:00:00.000Z'
ROOT = 'claude-code:session-main'


class ClaudeCodeAdapterTests(unittest.TestCase):
    def dataset(self, **kwargs):
        return exporter.build_dataset(adapters=[exporter.ClaudeCodeAdapter(FIXTURE)],
                                      cutoff=CUTOFF, include_git=False, **kwargs)

    def test_counts_titles_and_hourly_buckets(self):
        data = self.dataset()
        session = next(item for item in data['sessions'] if item['id'] == ROOT)
        self.assertEqual(session['agent'], 'claude-code')
        self.assertEqual(session['title'], 'Latest synthetic tree title')
        self.assertEqual(session['titleSource'], 'ai-title-excerpt')
        self.assertEqual(session['createdAt'], '2026-01-02T10:00:00.000Z')
        self.assertEqual(session['updatedAt'], '2026-01-02T10:05:00.000Z')
        self.assertEqual(session['gitContext'], {'branch': 'feature/leaf-work'})
        self.assertEqual(session['activity'], [
            {'at': '2026-01-02T10:00:00.000Z', 'kind': 'turn', 'count': 1},
            {'at': '2026-01-02T10:02:00.000Z', 'kind': 'tool', 'count': 8},
        ])
        self.assertEqual(session['coverage']['invocationsMatchedToOutcomes'], 7)
        self.assertEqual(session['coverage']['unmatchedToolInvocations'], 1)
        self.assertEqual(session['coverage']['unmatchedToolResults'], 1)

    def test_only_successful_explicit_edits_create_file_evidence(self):
        session = next(item for item in self.dataset()['sessions'] if item['id'] == ROOT)
        files = {file['path']: file for file in session['files']}
        self.assertEqual(set(files), {'src/leaf.py', 'docs/guide.md', 'notes/experiment.ipynb'})
        self.assertEqual(len(files['src/leaf.py']['events']), 2)
        self.assertEqual(sum(len(file['events']) for file in files.values()), 4)
        self.assertEqual(session['coverage']['unsuccessfulFileOutcomes'], 1)
        self.assertTrue(all(file['bytes'] is None for file in files.values()))

    def test_file_subagents_and_nested_spawn_links(self):
        sessions = {item['id']: item for item in self.dataset()['sessions']}
        child = sessions[ROOT + ':agent:child-one']
        nested = sessions[ROOT + ':agent:nested']
        fallback = sessions[ROOT + ':agent:fallback']
        self.assertTrue(child['isSubagent'])
        self.assertEqual(child['parentId'], ROOT)
        self.assertEqual(nested['parentId'], child['id'])
        self.assertEqual(nested['rootSessionId'], ROOT)
        self.assertEqual(fallback['parentId'], ROOT)
        self.assertEqual(fallback['coverage']['unresolvedSpawnLinks'], 1)
        self.assertCountEqual(sessions[ROOT]['agentIds'], [child['id'], nested['id'], fallback['id']])
        self.assertEqual([file['path'] for file in child['files']], ['src/child.py'])

    def test_legacy_sidechains_keep_their_own_work(self):
        sessions = {item['id']: item for item in self.dataset()['sessions']}
        root = sessions['claude-code:session-legacy']
        child = sessions[root['id'] + ':sidechain:side-prompt']
        self.assertEqual(root['files'], [])
        self.assertEqual(child['parentId'], root['id'])
        self.assertEqual(child['rootSessionId'], root['id'])
        self.assertEqual([file['path'] for file in child['files']], ['legacy/branch.ts'])
        self.assertEqual(len(root['agentIds']), 2)
        self.assertEqual(root['title'], 'Build the older synthetic tree')

    def test_malformed_unknown_and_privacy_coverage(self):
        data = self.dataset()
        source = data['sources'][0]
        self.assertEqual(source['kind'], 'claude-code')
        self.assertEqual(source['rollouts'], 5)
        self.assertEqual(source['sessions'], 7)
        self.assertEqual(source['malformedRecords'], 1)
        self.assertEqual(source['unrecognizedEnvelopeRecords'], 1)
        self.assertEqual(data['coverage']['malformedRecords'], 1)
        self.assertEqual(data['coverage']['parser']['unrecognizedEnvelopeRecords'], 1)
        batch = exporter.ClaudeCodeAdapter(FIXTURE).read(CUTOFF)
        # Check the seam as well as the final JSON; private bodies never cross it.
        for value in (data, batch.records):
            text = json.dumps(value)
            self.assertNotIn('PRIVATE_', text)
            for field in ('message', 'content', 'input', 'toolUseResult', 'sourceToolAssistantUUID'):
                self.assertNotIn('"' + field + '":', text)

    def custom(self, rows, cutoff=CUTOFF):
        with tempfile.TemporaryDirectory() as directory:
            folder = Path(directory) / 'projects' / 'encoded'
            folder.mkdir(parents=True)
            (folder / 'synthetic.jsonl').write_text('\n'.join(json.dumps(row) for row in rows) + '\n')
            return exporter.build_dataset(adapters=[exporter.ClaudeCodeAdapter(directory)],
                                          cutoff=cutoff, include_git=False)

    def test_duplicate_out_of_order_outcomes_and_cutoff(self):
        at = '2026-01-01T00:00:00Z'
        result = {'type': 'user', 'uuid': 'result', 'timestamp': at, 'message': {
            'content': [{'type': 'tool_result', 'tool_use_id': 'edit', 'is_error': False}]}}
        call = {'type': 'assistant', 'uuid': 'call', 'timestamp': at, 'cwd': '/synthetic/project',
                'message': {'content': [{'type': 'tool_use', 'id': 'edit', 'name': 'Edit',
                                         'input': {'file_path': 'one.ts'}}]}}
        future = dict(call, uuid='future', timestamp='2027-01-01T00:00:00Z')
        data = self.custom([result, call, call, result, future])
        self.assertEqual(data['coverage']['successfulFileEvents'], 1)
        self.assertEqual(data['coverage']['recordedToolOperations'], 1)
        self.assertEqual(data['sources'][0]['recordsAfterCutoff'], 1)

    def test_summary_precedence_and_prompt_excerpt_limit(self):
        user = {'type': 'user', 'uuid': 'u', 'timestamp': '2026-01-01T00:00:00Z',
                'message': {'content': 'x' * 100 + '\nPRIVATE_BODY'}}
        self.assertEqual(self.custom([user])['sessions'][0]['title'], 'x' * 60)
        summary = {'type': 'summary', 'summary': 'A compact title\nPRIVATE_SUMMARY'}
        self.assertEqual(self.custom([user, summary])['sessions'][0]['title'], 'A compact title')

    def test_invalid_record_shapes_do_not_crash(self):
        rows = [None, [], 7, {'type': []}, {'type': 'assistant', 'message': []},
                {'type': 'user', 'uuid': 'u', 'timestamp': '2026-01-01T00:00:00Z',
                 'message': {'content': [None, {'type': 'text', 'text': 'Synthetic prompt'}]}}]
        data = self.custom(rows)
        self.assertEqual(data['sources'][0]['malformedRecords'], 4)
        self.assertEqual(data['coverage']['recordedTurns'], 1)

    def test_claude_home_precedence(self):
        with patch.dict(os.environ, {'CLAUDE_CONFIG_DIR': str(FIXTURE)}):
            self.assertEqual(exporter.ClaudeCodeAdapter().claude_home, FIXTURE.resolve())
            self.assertNotEqual(exporter.ClaudeCodeAdapter('/synthetic/explicit').claude_home, FIXTURE.resolve())
        with patch.dict(os.environ, {}, clear=True), patch.object(Path, 'home', return_value=Path('/synthetic/home')):
            self.assertEqual(exporter.default_claude_home(), Path('/synthetic/home/.claude'))


if __name__ == '__main__':
    unittest.main()
