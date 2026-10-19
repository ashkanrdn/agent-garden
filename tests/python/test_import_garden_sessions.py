import json
from collections import Counter
from pathlib import Path
import tempfile
import unittest

from agent_garden_export import empty_session, finalize_sessions, merge_metadata, parse_rollout


BASE = '2026-08-13T18:56:01.323Z'
PARENT = '019ffc7a-4dd6-7000-8000-000000000001'
CHILD = '019ffc7b-36e8-7000-8000-000000000003'


def row(kind, payload, at='2026-08-13T18:56:02.000Z', ordinal=None):
    result = {'type': kind, 'timestamp': at, 'payload': payload}
    if ordinal is not None:
        result['ordinal'] = ordinal
    return result


def header(sid=CHILD, **extra):
    if extra.get('parent_thread_id'):
        extra.setdefault('source', {'subagent': {'thread_spawn': {'parent_thread_id': extra['parent_thread_id']}}})
    return row('session_meta', {'id': sid, 'timestamp': BASE, 'cwd': '/repo', **extra}, at=BASE, ordinal=0)


def patch(call='call-1', success=True, path='src/index.ts', **extra):
    return row('event_msg', {'type': 'patch_apply_end', 'call_id': call,
               'success': success, 'changes': {path: {'type': 'update'}}, **extra})


class ImportTests(unittest.TestCase):
    def parse(self, rows, copies=1):
        sessions = {}
        stats = Counter(records=0, errors=0)
        stats['_rolloutIds'] = set()
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'rollout.jsonl'
            path.write_text('\n'.join(json.dumps(value) for value in rows) + '\n')
            for _ in range(copies):
                parse_rollout(path, sessions, 'fixture', '2026-09-17T00:00:00.000Z', stats)
        finalize_sessions(sessions, set())
        return sessions

    def test_duplicate_source_copies_and_call_outcome_are_counted_once(self):
        sessions = self.parse([header(), row('response_item', {'type': 'function_call',
                 'name': 'apply_patch', 'call_id': 'call-1', 'arguments': 'private'}), patch()], copies=2)
        session = sessions[CHILD]
        self.assertEqual(sum(event['count'] for event in session['activity']), 1)
        self.assertEqual(len(session['files'][0]['events']), 1)
        self.assertNotIn('private', json.dumps(session))

    def test_failed_patch_does_not_create_file_evidence(self):
        session = self.parse([header(), patch(success=False), patch(call='good', path='src/good.ts')])[CHILD]
        self.assertEqual([file['path'] for file in session['files']], ['/repo/src/good.ts'])
        self.assertEqual(session['coverage']['unsuccessfulFileOutcomes'], 1)

    def test_new_file_change_preserves_real_folder_and_unknown_bytes(self):
        rows = [header(), row('event_msg', {'type': 'item_completed', 'thread_id': CHILD,
            'item': {'type': 'FileChange', 'id': 'new-file', 'status': 'completed',
                     'changes': {'a/index.ts': {'type': 'add'}, 'b/index.ts': {'type': 'update'}}}})]
        session = self.parse(rows)[CHILD]
        self.assertEqual([file['path'] for file in session['files']], ['/repo/a/index.ts', '/repo/b/index.ts'])
        self.assertTrue(all(file['bytes'] is None for file in session['files']))

    def test_paginated_child_excludes_parent_and_preserves_own_boundary(self):
        rows = [header(parent_thread_id=PARENT, subagent_history_start_ordinal=4),
                row('session_meta', {'id': PARENT}, ordinal=1),
                {**patch(path='inherited.ts'), 'ordinal': 3},
                {**patch(call='own', path='own.ts'), 'ordinal': 4}]
        session = self.parse(rows)[CHILD]
        self.assertEqual([file['path'] for file in session['files']], ['/repo/own.ts'])
        self.assertIsNone(session['rootSessionId'])

    def test_legacy_copied_envelope_timestamp_does_not_prove_ownership(self):
        rows = [header(parent_thread_id=PARENT, forked_from_id=PARENT),
                row('session_meta', {'id': PARENT}),
                row('event_msg', {'type': 'task_started', 'turn_id': '019ffc7a-e1bf-7000-8000-000000000002', 'started_at': 1786647339}),
                patch(path='inherited.ts'),
                row('event_msg', {'type': 'task_started', 'turn_id': '019ffc7b-3734-7000-8000-000000000004', 'started_at': 1786647361}),
                patch(call='own', path='own.ts')]
        session = self.parse(rows)[CHILD]
        self.assertEqual([file['path'] for file in session['files']], ['/repo/own.ts'])
        self.assertEqual(session['coverage']['derivedTurnBoundaries'], 1)

    def test_ambiguous_legacy_history_is_excluded(self):
        session = self.parse([header(parent_thread_id=PARENT), row('session_meta', {'id': PARENT}), patch()])[CHILD]
        self.assertEqual(session['files'], [])
        self.assertEqual(session['activity'], [])

    def test_foreign_thread_after_boundary_stays_excluded(self):
        rows = [header(subagent_history_start_ordinal=1),
                {**patch(thread_id=PARENT, path='foreign.ts'), 'ordinal': 2},
                {**patch(call='own', thread_id=CHILD, path='own.ts'), 'ordinal': 3}]
        self.assertEqual([file['path'] for file in self.parse(rows)[CHILD]['files']], ['/repo/own.ts'])

    def test_same_id_metadata_repeat_is_not_inheritance(self):
        session = self.parse([header(), header(), patch()])[CHILD]
        self.assertEqual(len(session['files']), 1)
        self.assertFalse(session['isSubagent'])

    def test_lineage_rolls_descendants_into_primary_once(self):
        sessions = {PARENT: empty_session(PARENT), CHILD: empty_session(CHILD)}
        finalize_sessions(sessions, {(PARENT, CHILD)})
        self.assertEqual(sessions[PARENT]['agentIds'], [CHILD])
        self.assertEqual(sessions[CHILD]['rootSessionId'], PARENT)
        self.assertTrue(sessions[CHILD]['isSubagent'])

    def test_fork_metadata_alone_does_not_turn_primary_into_subagent(self):
        rows = [header(parent_thread_id=PARENT, source='vscode'),
                patch(thread_id=CHILD)]
        session = self.parse(rows)[CHILD]
        self.assertFalse(session['isSubagent'])
        self.assertEqual(session['rootSessionId'], CHILD)

    def test_guardian_is_excluded_from_parent_agent_flock(self):
        guardian = '019ffc7c-36e8-7000-8000-000000000005'
        sessions = {PARENT: empty_session(PARENT), CHILD: empty_session(CHILD),
                    guardian: empty_session(guardian)}
        merge_metadata(sessions[guardian], {'source': {'subagent': {'other': 'guardian'}}}, 'live')
        finalize_sessions(sessions, {(PARENT, CHILD), (PARENT, guardian)})
        self.assertTrue(sessions[guardian]['isGuardian'])
        self.assertEqual(sessions[PARENT]['agentIds'], [CHILD])

    def test_optional_agent_metadata_keeps_null_tokens(self):
        session = empty_session(CHILD)
        merge_metadata(session, {'source': {'subagent': {'thread_spawn': {
            'parent_thread_id': PARENT, 'agent_nickname': 'Sprout', 'agent_role': 'builder'}}},
            'model': 'fixture-model', 'reasoning_effort': 'high', 'tokens_used': None}, 'live')
        self.assertEqual((session['nickname'], session['role'], session['model'],
                          session['reasoningEffort']), ('Sprout', 'builder', 'fixture-model', 'high'))
        self.assertIsNone(session['tokensUsed'])

    def test_display_name_precedes_prompt_based_legacy_title(self):
        session = empty_session(CHILD)
        merge_metadata(session, {'name': 'Garden rebuild', 'title': 'Prompt\nprivate body',
                       'updated_at': 1786647361}, 'live', database=True)
        self.assertEqual(session['title'], 'Garden rebuild')
        self.assertEqual(session['titleSource'], 'database-name')


if __name__ == '__main__':
    unittest.main()
