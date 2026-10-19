"""Synthetic evidence checks for the incremental live reader."""
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest

from local.live_garden import LiveGardenState


PARENT = '019ffc7a-4dd6-7000-8000-000000000001'
CHILD = '019ffc7b-36e8-7000-8000-000000000002'
GUARDIAN = '019ffc7c-36e8-7000-8000-000000000003'
LEGACY_CHILD = '019ffc7d-36e8-7000-8000-000000000004'
LEGACY_GUARDIAN = '019ffc7e-36e8-7000-8000-000000000005'
AT = '2026-09-24T00:00:00.000Z'


def line(envelope, payload, *, ordinal=None, at=AT):
    item = {'type': envelope, 'timestamp': at, 'payload': payload}
    if ordinal is not None:
        item['ordinal'] = ordinal
    return json.dumps(item) + '\n'


class LiveGardenBackendTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.base = Path(self.temp.name)
        self.root = self.base / 'codex'
        self.root.mkdir()
        self.rollout = self.root / 'sessions' / 'child.jsonl'
        self.rollout.parent.mkdir()
        self.static = self.base / 'public' / 'local-session-data.json'
        self.static.parent.mkdir()
        self.static.write_text(json.dumps({'schemaVersion': 1, 'generatedAt': '2026-09-23T00:00:00Z',
                                           'projects': [], 'sessions': []}))
        database = sqlite3.connect(self.root / 'state_5.sqlite')
        database.execute('CREATE TABLE threads (id TEXT PRIMARY KEY, source TEXT, rollout_path TEXT, '
                         'created_at_ms INTEGER, updated_at_ms INTEGER, cwd TEXT, name TEXT, '
                         'agent_nickname TEXT, agent_role TEXT, model TEXT, reasoning_effort TEXT, tokens_used INTEGER)')
        database.execute('CREATE TABLE thread_spawn_edges (parent_thread_id TEXT, child_thread_id TEXT, status TEXT)')
        rows = [(PARENT, 'exec', None, '/repo', None, None, None),
                (CHILD, json.dumps({'subagent': {'thread_spawn': {'parent_thread_id': PARENT,
                             'agent_path': '/root/child'}}}), str(self.rollout), '/repo', 'Sprout', 'build', 10),
                (GUARDIAN, json.dumps({'subagent': {'other': 'guardian'}}), None, '/repo', None, None, None)]
        database.executemany('INSERT INTO threads (id,source,rollout_path,cwd,agent_nickname,agent_role,tokens_used) '
                             'VALUES (?,?,?,?,?,?,?)', rows)
        database.execute('INSERT INTO thread_spawn_edges VALUES (?,?,?)', (PARENT, CHILD, 'open'))
        database.commit()
        database.close()

    def tearDown(self):
        self.temp.cleanup()

    def state(self):
        return LiveGardenState(self.root, self.static, poll_interval=60,
                               backup_root=self.base / 'backup')

    def test_guardian_lineage_and_optional_metadata(self):
        state = self.state()
        snapshot = state.snapshot()
        self.assertNotIn(GUARDIAN, {item['id'] for item in snapshot['agents']})
        self.assertNotIn(GUARDIAN, {item['id'] for item in snapshot['sessions']})
        self.assertEqual(state.sessions[PARENT]['agentIds'], [CHILD])
        child = state.agents[CHILD]
        self.assertEqual((child['rootSessionId'], child['parentId']), (PARENT, PARENT))
        self.assertEqual((child['nickname'], child['role'], child['tokensUsed']), ('Sprout', 'build', 10))

    def test_live_file_changes_have_current_sizes_and_refresh_after_edits(self):
        target = self.base / 'project' / 'src' / 'new.py'
        target.parent.mkdir(parents=True)
        target.write_text('print(1)\n')
        cwd = str(target.parent.parent)
        with sqlite3.connect(self.root / 'state_5.sqlite') as database:
            database.execute('UPDATE threads SET cwd=? WHERE id=?', (cwd, CHILD))
        self.rollout.write_text(line('session_meta', {'id': CHILD, 'timestamp': AT, 'cwd': cwd})
            + line('event_msg', {'type': 'item_completed', 'item': {
                'type': 'FileChange', 'id': 'first', 'status': 'completed',
                'changes': {'src/new.py': {'type': 'add'}}}}))
        state = self.state()
        file = state.sessions[CHILD]['files'][0]
        self.assertEqual(file['bytes'], target.stat().st_size)
        self.assertEqual(file['bytesSource'], 'current-file-stat')
        self.assertTrue(file['bytesObservedAt'])
        target.write_text('print("longer file")\n')
        with self.rollout.open('a') as stream:
            stream.write(line('event_msg', {'type': 'item_completed', 'item': {
                'type': 'FileChange', 'id': 'second', 'status': 'completed',
                'changes': {str(target): {'type': 'update'}}}}))
        state.poll()
        self.assertEqual(len(state.sessions[CHILD]['files']), 1)
        self.assertEqual(file['bytes'], target.stat().st_size)
        target.unlink()
        with self.rollout.open('a') as stream:
            stream.write(line('event_msg', {'type': 'item_completed', 'item': {
                'type': 'FileChange', 'id': 'third', 'status': 'completed',
                'changes': {str(target): {'type': 'delete'}}}}))
        state.poll()
        self.assertIsNone(file['bytes'])
        self.assertEqual(file['bytesMissingReason'], 'file-unavailable')
        self.assertEqual(len(file['events']), 3)

    def test_partial_append_turn_state_token_snapshot_and_quiet(self):
        self.rollout.write_text(line('session_meta', {'id': CHILD, 'timestamp': AT, 'cwd': '/repo',
                         'subagent_history_start_ordinal': 2}, ordinal=0)
                         + line('event_msg', {'type': 'task_started', 'turn_id': 'turn-old'}, ordinal=1)
                         + line('event_msg', {'type': 'task_started', 'turn_id': 'turn-new'}, ordinal=2)
                         + line('response_item', {'type': 'function_call', 'name': 'wait_agent',
                                                  'call_id': 'wait-1'}, ordinal=3)
                         + '{"type":"event_msg","timestamp":')
        state = self.state()
        self.assertEqual(state.agents[CHILD]['state'], 'waiting')
        self.assertEqual(state.agents[CHILD]['currentTool'], 'wait_agent')
        self.assertTrue(state.agents[CHILD]['quiet'])
        self.assertEqual(sum(item['count'] for item in state.sessions[CHILD]['activity'] if item['kind'] == 'turn'), 1)
        previous = state.revision
        state.poll()
        self.assertEqual(state.revision, previous)
        with self.rollout.open('a') as stream:
            stream.write('"2026-09-24T00:00:01Z","payload":{"type":"token_count","info":null}}\n')
            stream.write(line('event_msg', {'type': 'token_count', 'info': {
                'total_token_usage': {'input_tokens': 7, 'output_tokens': 3}}}, ordinal=4))
            stream.write(line('event_msg', {'type': 'task_complete', 'turn_id': 'turn-new',
                                            'error': {'kind': 'cancelled'}}, ordinal=5))
        state.poll()
        self.assertEqual(state.agents[CHILD]['state'], 'error')
        self.assertFalse(state.agents[CHILD]['quiet'])
        self.assertEqual(state.agents[CHILD]['tokensUsed'], 10)
        self.assertNotIn('cancelled', json.dumps(state.snapshot()))

    def test_rotation_and_inherited_file_exclusion(self):
        self.rollout.write_text(line('session_meta', {'id': CHILD, 'timestamp': AT, 'cwd': '/repo',
                        'subagent_history_start_ordinal': 3}, ordinal=0)
                        + line('event_msg', {'type': 'patch_apply_end', 'call_id': 'inherited',
                          'success': True, 'changes': {'private.ts': {'type': 'update'}}}, ordinal=2)
                        + line('event_msg', {'type': 'patch_apply_end', 'call_id': 'own',
                          'success': True, 'changes': {'src/own.ts': {'type': 'update'}}}, ordinal=3))
        state = self.state()
        self.assertEqual([f['path'] for f in state.sessions[CHILD]['files']], ['src/own.ts'])
        self.assertEqual(state.sessions[CHILD]['files'][0]['absolutePath'], '/repo/src/own.ts')
        old = state.revision
        replacement = self.rollout.with_suffix('.new')
        replacement.write_text(self.rollout.read_text())
        replacement.replace(self.rollout)
        state.poll()
        self.assertEqual(state.revision, old + 1)
        self.assertTrue(state.last_delta['reset'])
        self.assertEqual(len(state.sessions[CHILD]['files'][0]['events']), 1)

    def test_messages_are_only_in_selected_response(self):
        self.rollout.write_text(line('session_meta', {'id': CHILD, 'timestamp': AT, 'cwd': '/repo',
                              'source': {'subagent': {'thread_spawn': {'parent_thread_id': PARENT,
                                                                    'agent_path': '/root/child'}}}})
                                + line('response_item', {'type': 'agent_message', 'id': 'msg-1',
                                      'author': '/root/child', 'recipient': '/root',
                                      'content': [{'type': 'input_text', 'text': 'synthetic private message'}]}))
        state = self.state()
        self.assertNotIn('synthetic private message', json.dumps(state.snapshot()))
        page = state.messages(PARENT, limit=1)
        self.assertEqual(page['messages'][0]['text'], 'synthetic private message')
        self.assertEqual(page['messages'][0]['fromAgentId'], CHILD)
        self.assertIsNone(state.messages(CHILD, agent_id=PARENT))

    def test_selected_session_includes_user_and_assistant_conversation(self):
        parent_path = self.rollout.parent / 'parent.jsonl'
        parent_path.write_text(line('session_meta', {'id': PARENT, 'timestamp': AT, 'cwd': '/repo'})
            + line('response_item', {'type': 'message', 'role': 'user', 'id': 'user-1',
                'content': [{'type': 'input_text', 'text': 'Synthetic request'}]})
            + line('response_item', {'type': 'message', 'role': 'assistant', 'id': 'answer-1',
                'content': [{'type': 'output_text', 'text': 'Synthetic answer'}]}, at='2026-09-24T00:00:01Z')
            + line('response_item', {'type': 'message', 'role': 'developer', 'id': 'internal-1',
                'content': [{'type': 'input_text', 'text': 'Internal instructions'}]}))
        database = sqlite3.connect(self.root / 'state_5.sqlite')
        database.execute('UPDATE threads SET rollout_path=? WHERE id=?', (str(parent_path), PARENT))
        database.commit()
        database.close()
        state = self.state()
        messages = state.messages(PARENT, agent_id=PARENT)['messages']
        self.assertEqual([item['text'] for item in messages], ['Synthetic answer', 'Synthetic request'])
        self.assertEqual([item['role'] for item in messages], ['assistant', 'user'])
        self.assertNotIn('Synthetic answer', json.dumps(state.snapshot()))
        self.assertNotIn('Synthetic request', self.static.read_text())

    def test_backup_only_conversations_use_relocated_files_without_live_database_rows(self):
        for location in ('Codex/current/sessions', 'Codex/current/archived_sessions',
                         'Codex/legacy-clicky/sessions', 'Codex/legacy-clicky/archived_sessions'):
            with self.subTest(location=location):
                sid = 'backup-' + location.replace('/', '-')
                self.static.write_text(json.dumps({'generatedAt': AT, 'projects': [], 'sessions': [
                    {'id': sid, 'isSubagent': False, 'rootSessionId': sid, 'sourceIds': ['backup-current']}]}))
                path = self.base / 'backup' / location / 'relocated.jsonl'
                path.parent.mkdir(parents=True, exist_ok=True)
                (path.parent / 'malformed.jsonl').write_text('[]\n')
                path.write_text(line('session_meta', {'id': sid, 'timestamp': AT})
                    + line('response_item', {'type': 'message', 'role': 'user', 'id': 'backup-message',
                        'content': [{'type': 'input_text', 'text': 'Synthetic backup conversation'}]}))
                state = self.state()
                before = state.snapshot()
                page = state.messages(sid, agent_id=sid)
                self.assertEqual([item['text'] for item in page['messages']], ['Synthetic backup conversation'])
                self.assertEqual(state.snapshot(), before, 'backup inspection must not replay activity as Live events')
                self.assertNotIn('Synthetic backup conversation', json.dumps(state.snapshot()))

    def test_discovered_live_rollout_supplies_messages_without_database_path(self):
        path = self.rollout.parent / 'discovered.jsonl'
        path.write_text(line('session_meta', {'id': PARENT, 'timestamp': AT, 'cwd': '/repo'})
            + line('response_item', {'type': 'message', 'role': 'user', 'id': 'discovered-message',
                'content': [{'type': 'input_text', 'text': 'Synthetic discovered conversation'}]}))
        state = self.state()
        self.assertNotIn(PARENT, state.paths)
        self.assertEqual(state.messages(PARENT, agent_id=PARENT)['messages'][0]['text'],
                         'Synthetic discovered conversation')

    def test_backup_and_current_conversations_merge_deduplicate_and_page(self):
        header = line('session_meta', {'id': PARENT, 'timestamp': AT, 'cwd': '/repo'})
        def message(identity, second):
            return line('response_item', {'type': 'message', 'role': 'assistant', 'id': identity,
                        'content': [{'type': 'output_text', 'text': 'Synthetic ' + identity}]},
                        at=f'2026-09-24T00:00:0{second}Z')
        backup = self.base / 'backup/Codex/current/archived_sessions/old.jsonl'
        backup.parent.mkdir(parents=True)
        backup.write_text(header + message('old', 1) + message('shared', 2))
        current = self.rollout.parent / 'current.jsonl'
        current.write_text(header + message('shared', 2) + message('new', 3))
        state = self.state()
        first = state.messages(PARENT, PARENT, limit=2)
        self.assertEqual([item['id'] for item in first['messages']], ['new', 'shared'])
        second = state.messages(PARENT, PARENT, cursor=first['nextCursor'], limit=2)
        self.assertEqual([item['id'] for item in second['messages']], ['old'])
        self.assertIsNone(second['nextCursor'])

    def test_wrong_database_path_cannot_return_another_sessions_messages(self):
        self.rollout.write_text(line('session_meta', {'id': CHILD, 'timestamp': AT, 'cwd': '/repo'})
            + line('response_item', {'type': 'message', 'role': 'user',
                'content': [{'type': 'input_text', 'text': 'Another session'}]}))
        state = self.state()
        state.paths[PARENT] = self.rollout
        self.assertEqual(state.messages(PARENT, PARENT)['messages'], [])

    def test_conversation_paging_excludes_inherited_text_and_keeps_agent_paths_within_root(self):
        self.rollout.write_text(line('session_meta', {'id': CHILD, 'timestamp': AT, 'cwd': '/repo',
            'subagent_history_start_ordinal': 2}, ordinal=0)
            + line('response_item', {'type': 'message', 'role': 'user', 'id': 'inherited',
                'content': [{'type': 'input_text', 'text': 'Inherited context'}]}, ordinal=1)
            + line('response_item', {'type': 'message', 'role': 'user', 'id': 'own-request',
                'content': [{'type': 'input_text', 'text': 'Own task'}]}, ordinal=2)
            + line('response_item', {'type': 'agent_message', 'id': 'own-answer',
                'author': '/root/child', 'recipient': '/root', 'text': 'Own answer'},
                ordinal=3, at='2026-09-24T00:00:01Z'))
        state = self.state()
        state.sessions['unrelated'] = {'agentPath': '/root/child', 'rootSessionId': 'different-root'}
        first = state.messages(PARENT, CHILD, limit=1)
        self.assertEqual([item['text'] for item in first['messages']], ['Own answer'])
        self.assertEqual(first['messages'][0]['fromAgentId'], CHILD)
        second = state.messages(PARENT, CHILD, cursor=first['nextCursor'], limit=1)
        self.assertEqual([item['text'] for item in second['messages']], ['Own task'])
        self.assertIsNone(second['nextCursor'])
        self.assertIsNone(state.messages(PARENT, 'unrelated'))

    def test_older_duplicate_source_cannot_reopen_completed_turn(self):
        self.rollout.write_text(line('session_meta', {'id': CHILD, 'timestamp': AT, 'cwd': '/repo'})
                                + line('event_msg', {'type': 'task_started', 'turn_id': 'turn-1'},
                                       at='2026-09-24T00:00:01Z')
                                + line('event_msg', {'type': 'task_complete', 'turn_id': 'turn-1'},
                                       at='2026-09-24T00:00:03Z'))
        state = self.state()
        self.assertEqual(state.agents[CHILD]['state'], 'turn-ended')
        duplicate = self.rollout.parent / 'later-copy.jsonl'
        duplicate.write_text(line('session_meta', {'id': CHILD, 'timestamp': AT, 'cwd': '/repo'})
                             + line('event_msg', {'type': 'task_started', 'turn_id': 'turn-1'},
                                    at='2026-09-24T00:00:01Z'))
        state.poll()
        self.assertEqual(state.agents[CHILD]['state'], 'turn-ended')
        self.assertEqual(sum(item['count'] for item in state.sessions[CHILD]['activity']
                             if item['kind'] == 'turn'), 1)

    def test_manual_static_refresh_rebases_live_activity(self):
        self.rollout.write_text(line('session_meta', {'id': CHILD, 'timestamp': AT, 'cwd': '/repo'})
                                + line('event_msg', {'type': 'task_started', 'turn_id': 'turn-1'},
                                       at='2026-09-24T00:00:01Z'))
        state = self.state()
        activity = state.sessions[CHILD]['activity']
        self.assertEqual(sum(item['count'] for item in activity), 1)
        refreshed = {**state.snapshot(), 'generatedAt': '2026-09-25T00:00:00Z',
                     'sourceCutoffAt': '2026-09-25T00:00:00Z'}
        self.static.write_text(json.dumps(refreshed))
        state.poll()
        self.assertTrue(state.last_delta['reset'])
        self.assertEqual(sum(item['count'] for item in state.sessions[CHILD]['activity']), 1)

    def test_historical_spawn_survives_without_live_database_row(self):
        live_database = sqlite3.connect(self.root / 'state_5.sqlite')
        live_database.execute('DELETE FROM threads')
        live_database.execute('DELETE FROM thread_spawn_edges')
        live_database.commit()
        live_database.close()
        backup = self.base / 'backup' / 'Codex/current'
        backup.mkdir(parents=True)
        database = sqlite3.connect(backup / 'state_5-consistent-snapshot.sqlite')
        database.execute('CREATE TABLE threads (id TEXT PRIMARY KEY, source TEXT)')
        database.executemany('INSERT INTO threads VALUES (?,?)', [
            (LEGACY_CHILD, json.dumps({'subagent': {'thread_spawn': {'parent_thread_id': PARENT}}})),
            (LEGACY_GUARDIAN, json.dumps({'subagent': {'other': 'guardian'}})),
        ])
        database.commit()
        database.close()
        self.static.write_text(json.dumps({'schemaVersion': 1, 'generatedAt': '2026-09-23T00:00:00Z',
            'projects': [{'id': 'legacy-project', 'name': 'Legacy', 'sessionIds': [PARENT, LEGACY_CHILD,
                                                                              LEGACY_GUARDIAN],
                          'workspaces': ['/repo']}],
            'sessions': [{'id': PARENT, 'isSubagent': False, 'rootSessionId': PARENT,
                          'projectId': 'legacy-project', 'cwd': '/repo',
                          'agentIds': [LEGACY_CHILD, LEGACY_GUARDIAN]},
                         {'id': LEGACY_CHILD, 'isSubagent': True, 'parentId': PARENT,
                          'rootSessionId': PARENT, 'projectId': 'legacy-project', 'cwd': '/repo'},
                         {'id': LEGACY_GUARDIAN, 'isSubagent': True, 'parentId': PARENT,
                          'rootSessionId': PARENT, 'projectId': 'legacy-project', 'cwd': '/repo'}]}))
        state = LiveGardenState(self.root, self.static, poll_interval=60,
                                initial_poll=False, backup_root=self.base / 'backup')
        snapshot = state.snapshot()
        self.assertIn(LEGACY_CHILD, {session['id'] for session in snapshot['sessions']})
        self.assertIn(LEGACY_CHILD, {agent['id'] for agent in snapshot['agents']})
        self.assertNotIn(LEGACY_GUARDIAN, {agent['id'] for agent in snapshot['agents']})
        self.assertEqual(state.sessions[PARENT]['agentIds'], [LEGACY_CHILD])
        project = next(p for p in snapshot['projects'] if p['id'] == 'legacy-project')
        self.assertIn(LEGACY_CHILD, project['sessionIds'])
        self.assertNotIn(LEGACY_GUARDIAN, project['sessionIds'])
        state.poll()
        self.assertEqual(state.sessions[PARENT]['agentIds'], [LEGACY_CHILD])

    def test_completed_operation_types_count_without_wrapper(self):
        self.rollout.write_text(line('session_meta', {'id': CHILD, 'timestamp': AT, 'cwd': '/repo'})
                                + line('response_item', {'type': 'custom_tool_call', 'name': 'exec',
                                                         'call_id': 'wrapper-1'})
                                + ''.join(line('event_msg', {'type': 'item_completed',
                                           'item': {'type': kind, 'id': key}})
                                           for kind, key in [('CommandExecution', 'cmd-1'),
                                                             ('McpToolCall', 'mcp-1'),
                                                             ('WebSearch', 'web-1')]))
        state = self.state()
        self.assertEqual(sum(item['count'] for item in state.sessions[CHILD]['activity']
                             if item['kind'] == 'tool'), 3)

    def test_message_cursor_stays_stable_after_new_arrival(self):
        header = line('session_meta', {'id': CHILD, 'timestamp': AT, 'cwd': '/repo',
                       'source': {'subagent': {'thread_spawn': {'parent_thread_id': PARENT,
                                                             'agent_path': '/root/child'}}}})
        def message(mid, second):
            return line('response_item', {'type': 'agent_message', 'id': mid,
                        'author': '/root/child', 'recipient': '/root',
                        'content': [{'type': 'input_text', 'text': 'synthetic-' + mid}]},
                        at=f'2026-09-24T00:00:{second:02d}Z')
        self.rollout.write_text(header + message('old-0', 1) + message('old-1', 2)
                                + message('old-2', 3))
        state = self.state()
        first = state.messages(PARENT, limit=2)
        self.assertEqual([item['id'] for item in first['messages']], ['old-2', 'old-1'])
        with self.rollout.open('a') as stream:
            stream.write(message('new', 4))
        state.poll()
        second = state.messages(PARENT, cursor=first['nextCursor'], limit=2)
        self.assertEqual([item['id'] for item in second['messages']], ['old-0'])
        self.assertIsNone(second['nextCursor'])
        self.assertEqual([item['id'] for item in state.messages(PARENT, limit=2)['messages']],
                         ['new', 'old-2'])

    def test_late_guardian_removal_updates_stream_and_project(self):
        path = self.rollout.parent / 'late-guardian.jsonl'
        path.write_text(line('session_meta', {'id': GUARDIAN, 'timestamp': AT, 'cwd': '/repo'}))
        database = sqlite3.connect(self.root / 'state_5.sqlite')
        database.execute('UPDATE threads SET source=?, rollout_path=? WHERE id=?',
                         ('exec', str(path), GUARDIAN))
        database.commit()
        database.close()
        state = self.state()
        self.assertIn(GUARDIAN, state.agents)
        project_id = state.sessions[GUARDIAN]['projectId']
        self.assertIn(GUARDIAN, state.projects[project_id]['sessionIds'])
        with path.open('a') as stream:
            stream.write(line('session_meta', {'id': GUARDIAN, 'timestamp': AT, 'cwd': '/repo',
                              'source': {'subagent': {'other': 'guardian'}}},
                              at='2026-09-24T00:00:01Z'))
        state.poll()
        self.assertEqual(state.last_delta['removedAgentIds'], [GUARDIAN])
        self.assertEqual(state.last_delta['removedSessionIds'], [GUARDIAN])
        project = next(p for p in state.last_delta['projects'] if p['id'] == project_id)
        self.assertNotIn(GUARDIAN, project['sessionIds'])

    def test_truncation_rebuilds_turn_and_activity(self):
        header = line('session_meta', {'id': CHILD, 'timestamp': AT, 'cwd': '/repo'})
        self.rollout.write_text(header + line('event_msg', {'type': 'task_started', 'turn_id': 't1'}))
        state = self.state()
        self.assertEqual(state.agents[CHILD]['state'], 'working')
        self.rollout.write_text(header)
        state.poll()
        self.assertTrue(state.last_delta['reset'])
        self.assertEqual(state.agents[CHILD]['state'], 'unknown')
        self.assertEqual(state.sessions[CHILD]['activity'], [])

    def test_first_header_waits_for_newline(self):
        header = line('session_meta', {'id': CHILD, 'timestamp': AT, 'cwd': '/repo'})
        self.rollout.write_text(header.rstrip('\n'))
        state = self.state()
        self.assertEqual(state.sessions[CHILD]['rolloutCount'], 0)
        with self.rollout.open('a') as stream:
            stream.write('\n')
        state.poll()
        self.assertEqual(state.sessions[CHILD]['rolloutCount'], 1)


if __name__ == '__main__':
    unittest.main()
