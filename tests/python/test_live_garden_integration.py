import http.client
import json
import shutil
import sqlite3
import tempfile
import threading
import time
import unittest
from pathlib import Path
from urllib.parse import urlencode

from local.serve_garden import GardenServer


FIXTURES = Path(__file__).parent.parent / 'fixtures/live-garden'
PRIVATE_MARKERS = ('SYNTHETIC_ROOT_PRIVATE_TEXT', 'SYNTHETIC_CHILD_PRIVATE_TEXT',
                  'SYNTHETIC_GUARDIAN_PRIVATE_TEXT')


def record(kind, payload, at='2026-09-24T10:00:07.000Z'):
    return json.dumps({'type': kind, 'timestamp': at, 'payload': payload}, separators=(',', ':'))


class LiveGardenIntegrationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.base = Path(self.temp.name)
        self.live_root = self.base / 'live'
        self.rollouts = self.live_root / 'sessions/2026/09/24'
        self.rollouts.mkdir(parents=True)
        self.public = self.base / 'public'
        self.public.mkdir()
        (self.public / 'index.html').write_text('synthetic garden')
        self.static_path = self.public / 'local-session-data.json'
        self.static_path.write_text(json.dumps({
            'schemaVersion': 1, 'generatedAt': '2026-09-24T09:00:00.000Z',
            'projects': [], 'sessions': [],
        }))
        self.paths = {
            'fixture-root': self.rollouts / 'root.jsonl',
            'fixture-child': self.rollouts / 'child.jsonl',
            'fixture-guardian': self.rollouts / 'guardian.jsonl',
        }
        for sid, path in self.paths.items():
            shutil.copyfile(FIXTURES / (sid.removeprefix('fixture-') + '.jsonl'), path)
        db = sqlite3.connect(self.live_root / 'state_5.sqlite')
        db.execute('''CREATE TABLE threads (
            id TEXT PRIMARY KEY, source TEXT, rollout_path TEXT,
            created_at_ms INTEGER, updated_at_ms INTEGER, cwd TEXT, name TEXT,
            agent_nickname TEXT, agent_role TEXT, model TEXT,
            reasoning_effort TEXT, tokens_used INTEGER)''')
        rows = [
            ('fixture-root', '"vscode"', self.paths['fixture-root'], 'Root synthetic', 40, 'primary'),
            ('fixture-child', json.dumps({'subagent': {'thread_spawn': {'parent_thread_id': 'fixture-root'}}}),
             self.paths['fixture-child'], 'Child synthetic', 7, 'worker'),
            ('fixture-guardian', json.dumps({'subagent': {'other': 'guardian'}}),
             self.paths['fixture-guardian'], 'Guardian synthetic', 2, 'guardian'),
        ]
        for sid, source, rollout, name, tokens, nickname in rows:
            db.execute('INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
                       (sid, source, str(rollout), 1790244000000, 1790244005000,
                        '/synthetic/project', name, nickname, None, 'fixture-model', 'minimal', tokens))
        db.execute('CREATE TABLE thread_spawn_edges (parent_thread_id TEXT, child_thread_id TEXT, status TEXT)')
        db.executemany('INSERT INTO thread_spawn_edges VALUES (?, ?, ?)', [
            ('fixture-root', 'fixture-child', 'open'),
            ('fixture-root', 'fixture-guardian', 'open'),
        ])
        db.commit()
        db.close()
        self.server = GardenServer(0, self.public, self.base / 'unused-importer.py',
                                   live_root=self.live_root, poll_interval=60)
        self.server.live.backup_root = self.base / 'backup'
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.origin = f'http://127.0.0.1:{self.server.server_port}'

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)
        self.temp.cleanup()

    def request(self, path, *, origin=True):
        connection = http.client.HTTPConnection('127.0.0.1', self.server.server_port, timeout=3)
        headers = {'Origin': self.origin} if origin else {}
        connection.request('GET', path, headers=headers)
        response = connection.getresponse()
        body = response.read()
        result = response.status, response.getheaders(), body
        connection.close()
        return result

    def snapshot(self):
        status, _, body = self.request('/api/live/snapshot')
        self.assertEqual(status, 200)
        return json.loads(body)

    def test_snapshot_privacy_guardians_and_selected_text_boundaries(self):
        snapshot = self.snapshot()
        self.assertEqual(snapshot['schemaVersion'], 1)
        sessions = {item['id']: item for item in snapshot['sessions']}
        agents = {item['id']: item for item in snapshot['agents']}
        self.assertIn('fixture-root', sessions)
        self.assertNotIn('fixture-guardian', sessions)
        self.assertNotIn('fixture-guardian', agents)
        self.assertEqual(sessions['fixture-root']['agentIds'], ['fixture-child'])
        self.assertEqual(agents['fixture-child']['rootSessionId'], 'fixture-root')
        self.assertEqual(agents['fixture-child']['tokensUsed'], 7)
        self.assertFalse(any(marker in json.dumps(snapshot) for marker in PRIVATE_MARKERS))

        query = urlencode({'rootSessionId': 'fixture-root', 'agentId': 'fixture-child'})
        status, _, body = self.request('/api/live/messages?' + query)
        self.assertEqual(status, 200)
        messages = json.loads(body)['messages']
        self.assertEqual([item['text'] for item in messages], ['SYNTHETIC_CHILD_PRIVATE_TEXT'])
        self.assertTrue(all(item['fromAgentId'] == 'fixture-child' for item in messages))

        all_query = urlencode({'rootSessionId': 'fixture-root'})
        status, _, body = self.request('/api/live/messages?' + all_query)
        self.assertEqual(status, 200)
        all_text = [item['text'] for item in json.loads(body)['messages']]
        self.assertEqual(set(all_text), set(PRIVATE_MARKERS[:2]))
        self.assertNotIn(PRIVATE_MARKERS[2], all_text)

        status, _, _ = self.request('/api/live/messages?' + all_query, origin=False)
        self.assertEqual(status, 403)
        self.assertNotIn(PRIVATE_MARKERS[1], self.static_path.read_text())
        self.assertNotIn(PRIVATE_MARKERS[1], json.dumps(self.snapshot()))

    def test_session_conversation_endpoint_returns_roles_and_older_messages(self):
        with self.paths['fixture-root'].open('a') as stream:
            stream.write(record('response_item', {'type': 'message', 'id': 'user-turn', 'role': 'user',
                'content': [{'type': 'input_text', 'text': 'Synthetic user request'}]}) + '\n')
            stream.write(record('response_item', {'type': 'message', 'id': 'assistant-turn', 'role': 'assistant',
                'content': [{'type': 'output_text', 'text': 'Synthetic assistant answer'}]},
                at='2026-09-24T10:00:08.000Z') + '\n')
        self.server.live.poll()
        query = {'rootSessionId': 'fixture-root', 'agentId': 'fixture-root', 'limit': 1}
        status, headers, body = self.request('/api/live/messages?' + urlencode(query))
        self.assertEqual(status, 200)
        page = json.loads(body)
        self.assertEqual(page['messages'][0]['role'], 'assistant')
        self.assertEqual(page['messages'][0]['text'], 'Synthetic assistant answer')
        query['cursor'] = page['nextCursor']
        status, _, body = self.request('/api/live/messages?' + urlencode(query))
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body)['messages'][0]['role'], 'user')
        self.assertNotIn('Synthetic assistant answer', json.dumps(self.snapshot()))
        self.assertIn(('Cache-Control', 'no-store'), headers)

    def test_backup_conversation_endpoint_reads_relocated_archive(self):
        sid = 'fixture-backup-root'
        self.static_path.write_text(json.dumps({
            'schemaVersion': 1, 'generatedAt': '2026-09-24T09:00:00.000Z', 'projects': [],
            'sessions': [{'id': sid, 'rootSessionId': sid, 'isSubagent': False}]}))
        path = self.base / 'backup/Codex/current/archived_sessions/moved.jsonl'
        path.parent.mkdir(parents=True)
        path.write_text(record('session_meta', {'id': sid, 'timestamp': '2026-09-24T10:00:07.000Z'}) + '\n'
            + record('response_item', {'type': 'message', 'role': 'user',
                'content': [{'type': 'input_text', 'text': 'Synthetic relocated backup'}]}) + '\n')
        self.server.live.poll()
        query = urlencode({'rootSessionId': sid, 'agentId': sid, 'limit': 20})
        status, headers, body = self.request('/api/live/messages?' + query)
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body)['messages'][0]['text'], 'Synthetic relocated backup')
        self.assertIn(('Cache-Control', 'no-store'), headers)
        self.assertNotIn('Synthetic relocated backup', json.dumps(self.snapshot()))

    def test_partial_completion_dedup_tokens_and_error_state(self):
        initial = self.snapshot()
        child = next(agent for agent in initial['agents'] if agent['id'] == 'fixture-child')
        self.assertEqual(child['state'], 'working')
        session = next(item for item in initial['sessions'] if item['id'] == 'fixture-child')
        before_turns = sum(item['count'] for item in session['activity'] if item['kind'] == 'turn')

        duplicate_start = record('event_msg', {'type': 'task_started', 'thread_id': 'fixture-child',
                                               'turn_id': 'fixture-child-turn-1', 'started_at': 1790244003},
                                   at='2026-09-24T10:00:03.000Z')
        tokens = record('event_msg', {'type': 'token_count', 'info': {'total_token_usage': {
            'input_tokens': 11, 'output_tokens': 4}}}, at='2026-09-24T10:00:08.000Z')
        with self.paths['fixture-child'].open('ab') as stream:
            stream.write((duplicate_start + '\n' + tokens + '\n' + tokens + '\n').encode())
        self.server.live.poll()
        self.server.live.poll()
        after = self.snapshot()
        child = next(agent for agent in after['agents'] if agent['id'] == 'fixture-child')
        session = next(item for item in after['sessions'] if item['id'] == 'fixture-child')
        self.assertEqual(child['tokensUsed'], 15, 'cumulative reports replace the total; they are not summed')
        after_turns = sum(item['count'] for item in session['activity'] if item['kind'] == 'turn')
        self.assertEqual(after_turns, before_turns)

        completion = record('event_msg', {'type': 'task_complete', 'thread_id': 'fixture-child',
                                          'turn_id': 'fixture-child-turn-1', 'error': 'synthetic failure'})
        with self.paths['fixture-child'].open('ab') as stream:
            stream.write(completion.encode())
        self.server.live.poll()
        partial = next(agent for agent in self.snapshot()['agents'] if agent['id'] == 'fixture-child')
        self.assertEqual(partial['state'], 'working', 'an incomplete final JSONL line is not observable')
        with self.paths['fixture-child'].open('ab') as stream:
            stream.write(b'\n')
        self.server.live.poll()
        finished = next(agent for agent in self.snapshot()['agents'] if agent['id'] == 'fixture-child')
        self.assertEqual(finished['state'], 'error')
        self.assertIsNotNone(finished['turnEndedAt'])

    def test_sse_snapshot_and_upsert_match_http_state_and_reconnect_is_current(self):
        before = self.snapshot()
        connection = http.client.HTTPConnection('127.0.0.1', self.server.server_port, timeout=3)
        connection.request('GET', '/api/events', headers={'Origin': self.origin})
        response = connection.getresponse()
        self.assertEqual(response.status, 200)
        self.assertEqual(response.getheader('Content-Type').split(';')[0], 'text/event-stream')

        def add_update():
            time.sleep(.05)
            update = record('event_msg', {'type': 'task_complete', 'thread_id': 'fixture-child',
                                          'turn_id': 'fixture-child-turn-1'})
            with self.paths['fixture-child'].open('ab') as stream:
                stream.write((update + '\n').encode())
            self.server.live.poll()

        writer = threading.Thread(target=add_update, daemon=True)
        writer.start()

        def next_event():
            event_name = None
            payload = None
            while event_name is None or payload is None:
                line = response.readline().decode().rstrip('\r\n')
                if line.startswith('event: '):
                    event_name = line[7:]
                elif line.startswith('data: '):
                    payload = json.loads(line[6:])
            return event_name, payload

        first_kind, first = next_event()
        second_kind, second = next_event()
        writer.join(timeout=2)
        self.assertEqual(first_kind, 'snapshot')
        self.assertEqual(first['revision'], before['revision'])
        self.assertEqual(set(agent['id'] for agent in first['agents']),
                         set(agent['id'] for agent in before['agents']))
        self.assertEqual(second_kind, 'upsert')
        self.assertGreater(second['revision'], first['revision'])
        self.assertFalse(any(marker in json.dumps([first, second]) for marker in PRIVATE_MARKERS))
        connection.close()

        current = self.snapshot()
        ids = [agent['id'] for agent in current['agents']]
        self.assertEqual(len(ids), len(set(ids)))
        self.assertEqual(set(ids), {'fixture-root', 'fixture-child'})
        applied = {name: {item['id']: item for item in first[name]}
                   for name in ('projects', 'sessions', 'agents')}
        for name in ('projects', 'sessions', 'agents'):
            for item in second[name]:
                applied[name][item['id']] = item
        for name, removed in (('sessions', 'removedSessionIds'), ('agents', 'removedAgentIds')):
            for sid in second.get(removed, []):
                applied[name].pop(sid, None)
        for name in ('projects', 'sessions', 'agents'):
            self.assertEqual(applied[name], {item['id']: item for item in current[name]},
                             f'SSE snapshot plus upserts must equal current {name}')
        reconnect = http.client.HTTPConnection('127.0.0.1', self.server.server_port, timeout=3)
        reconnect.request('GET', '/api/events', headers={'Origin': self.origin})
        resumed = reconnect.getresponse()
        self.assertEqual(resumed.status, 200)
        # A fresh poll wakes SSE so its first snapshot flushes promptly.
        def add_metadata():
            time.sleep(.05)
            db = sqlite3.connect(self.live_root / 'state_5.sqlite')
            db.execute("UPDATE threads SET tokens_used=8 WHERE id='fixture-child'")
            db.commit()
            db.close()
            self.server.live.poll()
        writer = threading.Thread(target=add_metadata, daemon=True)
        writer.start()
        kind, resumed_snapshot = next_event_for(resumed)
        self.assertEqual(kind, 'snapshot')
        self.assertEqual(resumed_snapshot['revision'], current['revision'])
        resumed_ids = [agent['id'] for agent in resumed_snapshot['agents']]
        self.assertEqual(len(resumed_ids), len(set(resumed_ids)))
        self.assertEqual(set(resumed_ids), {'fixture-root', 'fixture-child'})
        reconnect.close()
        writer.join(timeout=2)


def next_event_for(response):
    event_name = None
    payload = None
    while event_name is None or payload is None:
        line = response.readline().decode().rstrip('\r\n')
        if line.startswith('event: '):
            event_name = line[7:]
        elif line.startswith('data: '):
            payload = json.loads(line[6:])
    return event_name, payload


if __name__ == '__main__':
    unittest.main()
