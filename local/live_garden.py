"""Incremental, read-only local Codex evidence for the live garden.

The public state contains metadata only. Message text is read on demand and is
never placed in snapshots, SSE events, or the static history file.
"""
from __future__ import annotations

from collections import defaultdict
from datetime import datetime, timezone
import base64
import copy
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import threading
import time

import sys

if __package__ in (None, ''):
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from agent_garden_export import (empty_session, lineage, merge_metadata,
                                 source_shape, stamp, uuid_time, successful,
                                 resolve_project, collapse_worktree_projects,
                                 worktree_project, _file_observation)


def _now():
    return stamp(datetime.now(timezone.utc).isoformat())


def _key(record):
    payload = record.get('payload') or {}
    explicit = payload.get('call_id') or payload.get('event_id') or payload.get('id')
    if explicit:
        return str(explicit)
    return hashlib.sha256(json.dumps(record, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def _blank(sid):
    value = empty_session(sid)
    for key in tuple(value):
        if key.startswith('_') and key != '_metadataRank':
            del value[key]
    return value


def _public_session(session):
    return copy.deepcopy({key: value for key, value in session.items() if not key.startswith('_')})


def _file_identity(path):
    try:
        stat = path.stat()
        return stat.st_dev, stat.st_ino, stat.st_size, stat.st_mtime_ns
    except OSError:
        return None


def _encode_message_cursor(item):
    value = json.dumps([item['at'], item['id']], separators=(',', ':')).encode()
    return base64.urlsafe_b64encode(value).decode().rstrip('=')


def _decode_message_cursor(value):
    if not isinstance(value, str) or not value or len(value) > 512:
        raise ValueError('invalid cursor')
    try:
        raw = base64.b64decode(value + '=' * (-len(value) % 4), altchars=b'-_', validate=True)
        pair = json.loads(raw)
    except (ValueError, UnicodeDecodeError) as error:
        raise ValueError('invalid cursor') from error
    if not isinstance(pair, list) or len(pair) != 2 or not all(isinstance(part, str) for part in pair):
        raise ValueError('invalid cursor')
    return tuple(pair)


class _Cursor:
    def __init__(self):
        self.identity = None
        self.offset = 0
        self.partial = b''
        self.sid = None
        self.birth = None
        self.boundary = None
        self.inherited = False
        self.owned = False
        self.cwd = None
        self.turn_id = None

    def reset(self):
        self.__init__()


class LiveGardenState:
    def __init__(self, live_root: Path, static_path: Path, poll_interval: float = 1.0,
                 initial_poll: bool = True, backup_root: Path | None = None):
        self.live_root = Path(live_root)
        self.backup_root = Path(backup_root).expanduser().resolve() if backup_root else None
        self.static_path = Path(static_path)
        self.poll_interval = poll_interval
        self.lock = threading.RLock()
        self.changed = threading.Condition(self.lock)
        self.revision = 0
        self.observed_at = _now()
        self.sessions = {}
        self.agents = {}
        self.projects = {}
        self.project_cache = {}
        self.paths = {}
        self._backup_message_index = None
        self.cursors = {}
        self.seen = defaultdict(set)
        self.event_seen = set()
        self.state_event_at = {}
        self.file_events = defaultdict(set)
        self.activity_events = defaultdict(set)
        self.static_cutoff = None
        self.last_db_rows = {}
        self.last_edges = set()
        self.last_delta = None
        self._last_poll = 0.0
        self._load_static()
        self.static_identity = _file_identity(self.static_path)
        if initial_poll:
            self.poll()

    def _load_static(self):
        try:
            with self.static_path.open(encoding='utf-8') as stream:
                data = json.load(stream)
        except (OSError, ValueError):
            data = {}
        collapse_worktree_projects(data.get('projects', []), data.get('sessions', []))
        self.static_cutoff = data.get('sourceCutoffAt') or data.get('generatedAt')
        self.sessions = {s['id']: s for s in data.get('sessions', []) if isinstance(s, dict) and s.get('id')}
        source_kinds = self._source_kinds({sid for sid, session in self.sessions.items()
                                          if session.get('isSubagent')})
        for session in self.sessions.values():
            has_guardian_flag = 'isGuardian' in session
            for key, value in _blank(session['id']).items():
                session.setdefault(key, value)
            source_kind = source_kinds.get(session['id'])
            if source_kind == 'guardian':
                session['isGuardian'] = True
            session['_pendingEligibility'] = (bool(session.get('isSubagent')) and
                                              not session.get('isGuardian') and
                                              source_kind != 'spawn' and not has_guardian_flag)
            if not session.get('isSubagent'):
                session['agentIds'] = []
        self.projects = {p['id']: p for p in data.get('projects', []) if isinstance(p, dict) and p.get('id')}
        guardians = {sid for sid, session in self.sessions.items()
                     if session.get('isGuardian') or session.get('_pendingEligibility')}
        for project in self.projects.values():
            project['sessionIds'] = [sid for sid in project.get('sessionIds', []) if sid not in guardians]
        for sid, session in self.sessions.items():
            if not session.get('isGuardian') and not session.get('_pendingEligibility'):
                self.agents[sid] = self._agent(session)
        # Static-only backup children need root membership before any live row
        # or rollout arrives. Reuse the same lineage rules as later upserts.
        self._lineage(set(), set(), set())

    def _source_kinds(self, ids):
        if not ids:
            return {}
        paths = []
        if self.backup_root:
            current = self.backup_root / 'Codex/current'
            primary = current / 'state_5-consistent-snapshot.sqlite'
            if not primary.is_file():
                primary = current / 'state_5.sqlite'
            paths.extend([primary, current / 'legacy-sqlite/state_5.sqlite',
                          self.backup_root / 'Codex/legacy-clicky/state_5.sqlite'])
        paths.append(self.live_root / 'state_5.sqlite')
        kinds = {}
        for path in paths:
            if not path.is_file():
                continue
            try:
                connection = sqlite3.connect(path.as_uri() + '?mode=ro', uri=True, timeout=2)
                try:
                    connection.execute('PRAGMA query_only=ON')
                    rows = connection.execute('SELECT id,source FROM threads')
                    for sid, raw_source in rows:
                        if sid not in ids:
                            continue
                        source = source_shape(raw_source)
                        subagent = source.get('subagent') if isinstance(source, dict) else None
                        if not isinstance(subagent, dict):
                            continue
                        if subagent.get('other') == 'guardian':
                            kinds[sid] = 'guardian'
                        elif 'thread_spawn' in subagent and kinds.get(sid) != 'guardian':
                            kinds[sid] = 'spawn'
                finally:
                    connection.close()
            except (OSError, sqlite3.Error):
                continue
        return kinds

    def _agent(self, session):
        return {'id': session['id'], 'rootSessionId': session.get('rootSessionId'),
                'parentId': session.get('parentId'), 'isSubagent': bool(session.get('isSubagent')),
                'nickname': session.get('nickname'), 'role': session.get('role'),
                'model': session.get('model'), 'reasoningEffort': session.get('reasoningEffort'),
                'tokensUsed': session.get('tokensUsed'), 'state': 'unknown',
                'turnStartedAt': None, 'turnEndedAt': None,
                'lastEventAt': session.get('updatedAt'), 'currentTool': None, 'quiet': False}

    def _db(self):
        path = self.live_root / 'state_5.sqlite'
        if not path.is_file():
            return {}, set()
        connection = sqlite3.connect(path.as_uri() + '?mode=ro', uri=True, timeout=2)
        try:
            connection.row_factory = sqlite3.Row
            connection.execute('PRAGMA query_only=ON')
            connection.execute('BEGIN')
            fields = {row[1] for row in connection.execute('PRAGMA table_info(threads)')}
            allowed = ['id', 'rollout_path', 'created_at_ms', 'updated_at_ms', 'created_at', 'updated_at',
                       'source', 'cwd', 'name', 'title', 'git_sha', 'git_branch', 'agent_path',
                       'agent_nickname', 'agent_role', 'model', 'reasoning_effort', 'tokens_used']
            selected = [field for field in allowed if field in fields]
            if 'id' not in selected:
                return {}, set()
            rows = {str(row['id']): dict(row) for row in connection.execute('SELECT ' + ','.join(selected) + ' FROM threads')}
            tables = {row[0] for row in connection.execute("SELECT name FROM sqlite_master WHERE type='table'")}
            edges = set()
            if 'thread_spawn_edges' in tables:
                edges = {(str(a), str(b)) for a, b in connection.execute(
                    'SELECT parent_thread_id,child_thread_id FROM thread_spawn_edges') if a and b}
            return rows, edges
        finally:
            connection.close()

    def _project(self, session, changed_projects):
        cwd = session.get('cwd')
        if not cwd:
            return
        if session.get('projectId') in self.projects and session['id'] in self.projects[session['projectId']].get('sessionIds', []):
            return
        identity = self.project_cache.get(cwd)
        if identity is None:
            identity = resolve_project(cwd)
            self.project_cache[cwd] = identity
        target = worktree_project(identity, self.projects.values())
        pid = target['id'] if target else identity['id']
        if target:
            session['projectGroupingBasis'] = 'unique-repository-for-managed-worktree-path'
        old_pid = session.get('projectId')
        session['projectId'] = pid
        if old_pid in self.projects and old_pid != pid:
            old = self.projects[old_pid]
            if session['id'] in old.get('sessionIds', []):
                old['sessionIds'].remove(session['id'])
                changed_projects.add(old_pid)
        if pid not in self.projects:
            project = {k: v for k, v in identity.items() if k not in ('cwd', 'checkoutRoot')}
            project.update(workspaces=[], sessionIds=[], git={'available': identity['gitAvailable'],
                                                               'reason': None if identity['gitAvailable'] else 'Repository unavailable'})
            self.projects[pid] = project
        project = self.projects[pid]
        if cwd not in project['workspaces']:
            project['workspaces'].append(cwd)
        if session['id'] not in project['sessionIds']:
            project['sessionIds'].append(session['id'])
        changed_projects.add(pid)

    def _lineage(self, edges, changed_sessions, changed_agents):
        for parent, child in edges:
            session = self.sessions.get(child)
            if session and not session.get('isGuardian'):
                if session.get('parentId') and session['parentId'] != parent:
                    continue
                if session.get('parentId') != parent or not session.get('isSubagent'):
                    session['parentId'], session['isSubagent'] = parent, True
                    changed_sessions.add(child)
        for sid, session in self.sessions.items():
            parent = session.get('parentId')
            seen = {sid}
            while parent and parent in self.sessions and parent not in seen:
                seen.add(parent)
                next_parent = self.sessions[parent].get('parentId')
                if not next_parent:
                    break
                parent = next_parent
            root = parent if parent in self.sessions and self.sessions[parent].get('parentId') is None else None
            if not session.get('isSubagent'):
                root = sid
            if session.get('rootSessionId') != root:
                session['rootSessionId'] = root
                changed_sessions.add(sid)
            if sid in self.agents and (self.agents[sid]['rootSessionId'] != root or self.agents[sid]['parentId'] != session.get('parentId')):
                self.agents[sid]['rootSessionId'] = root
                self.agents[sid]['parentId'] = session.get('parentId')
                changed_agents.add(sid)
        for session in self.sessions.values():
            desired = sorted(sid for sid, child in self.sessions.items() if sid != session['id']
                             and child.get('rootSessionId') == session['id'] and child.get('isSubagent')
                             and not child.get('isGuardian') and not child.get('_pendingEligibility'))
            if session.get('agentIds') != desired:
                session['agentIds'] = desired
                changed_sessions.add(session['id'])

    def _accept(self, cursor, record):
        payload = record.get('payload')
        if not isinstance(payload, dict):
            return False
        envelope, kind = record.get('type'), payload.get('type')
        if cursor.sid is None:
            if envelope != 'session_meta' or not payload.get('id'):
                return False
            cursor.sid = str(payload['id'])
            cursor.birth = stamp(payload.get('timestamp') or record.get('timestamp'))
            cursor.boundary = payload.get('subagent_history_start_ordinal')
            if not isinstance(cursor.boundary, int):
                cursor.boundary = None
            cursor.inherited = bool(payload.get('forked_from_id') or payload.get('parent_thread_id') or cursor.boundary is not None)
            cursor.owned = not cursor.inherited
            cursor.cwd = payload.get('cwd')
            return True
        if envelope == 'session_meta':
            if str(payload.get('id')) == cursor.sid:
                cursor.owned = True
                cursor.cwd = payload.get('cwd') or cursor.cwd
                return True
            cursor.owned = False
            cursor.inherited = True
            return False
        thread_id = payload.get('thread_id')
        if thread_id and str(thread_id) != cursor.sid:
            return False
        ordinal = record.get('ordinal')
        if cursor.boundary is not None and isinstance(ordinal, int):
            cursor.owned = ordinal >= cursor.boundary
        elif thread_id == cursor.sid:
            cursor.owned = True
        elif cursor.inherited and not cursor.owned and kind == 'task_started':
            birth = uuid_time(payload.get('turn_id'))
            start = stamp(payload.get('started_at'))
            if cursor.birth and birth and birth >= cursor.birth and start and start[:19] >= cursor.birth[:19]:
                cursor.owned = True
        at = stamp(record.get('timestamp'))
        if not cursor.owned or not at or cursor.birth and at < cursor.birth:
            return False
        if envelope == 'turn_context':
            cursor.cwd = payload.get('cwd') or cursor.cwd
        cursor.turn_id = payload.get('turn_id') or cursor.turn_id
        return True

    def _activity(self, session, kind, at, identity):
        sid = session['id']
        if (self.static_cutoff and at <= self.static_cutoff) or identity in self.activity_events[sid]:
            return False
        self.activity_events[sid].add(identity)
        key = at[:13]
        bucket = next((item for item in session['activity'] if item['at'][:13] == key and item['kind'] == kind), None)
        if bucket:
            bucket['count'] += 1
            bucket['at'] = max(bucket['at'], at)
        else:
            session['activity'].append({'at': at, 'kind': kind, 'count': 1})
            session['activity'].sort(key=lambda item: (item['at'], item['kind']))
        return True

    def _state(self, sid, agent, at, **changes):
        if at >= self.state_event_at.get(sid, ''):
            agent.update(changes)
            self.state_event_at[sid] = at

    def _record(self, cursor, record, changed_sessions, changed_agents, changed_projects):
        if not self._accept(cursor, record):
            return
        sid = cursor.sid
        payload = record['payload']
        at = stamp(record.get('timestamp'))
        session = self.sessions.setdefault(sid, _blank(sid))
        envelope, kind = record.get('type'), payload.get('type')
        if (session.get('isGuardian') or session.get('_pendingEligibility')) and envelope != 'session_meta':
            return
        agent = self.agents.setdefault(sid, self._agent(session))
        if envelope == 'session_meta':
            before_session = _public_session(session)
            before_agent = copy.deepcopy(agent)
            previous_cwd = session.get('cwd')
            merge_metadata(session, payload, 'live')
            if lineage(payload)['isSubagent'] and not session.get('isGuardian'):
                session['_pendingEligibility'] = False
            cursor.cwd = session.get('cwd') or cursor.cwd
            session['rolloutCount'] = max(1, session.get('rolloutCount', 0))
            if session.get('isGuardian'):
                self.agents.pop(sid, None)
            else:
                for field in ('nickname', 'role', 'model', 'reasoningEffort', 'tokensUsed'):
                    if field == 'tokensUsed':
                        value = session.get(field)
                        agent[field] = max(agent.get(field) or 0, value) if isinstance(value, int) else agent.get(field)
                        session[field] = agent[field]
                    else:
                        agent[field] = session.get(field)
                if previous_cwd != session.get('cwd'):
                    self._project(session, changed_projects)
            if before_session != _public_session(session):
                changed_sessions.add(sid)
            if before_agent != self.agents.get(sid):
                changed_agents.add(sid)
            return
        if session.get('isGuardian'):
            return
        identity = (envelope, kind, _key(record))
        if identity in self.seen[sid]:
            return
        self.seen[sid].add(identity)
        if not at:
            return
        session['updatedAt'] = max(session.get('updatedAt') or at, at)
        agent['lastEventAt'] = max(agent.get('lastEventAt') or at, at) if sid in self.event_seen else at
        self.event_seen.add(sid)
        changed_agents.add(sid)
        changed_sessions.add(sid)
        if envelope == 'event_msg' and kind == 'task_started':
            self._state(sid, agent, at, state='working', turnStartedAt=stamp(payload.get('started_at')) or at,
                        turnEndedAt=None, currentTool=None, quiet=False)
            self._activity(session, 'turn', at, ('turn', payload.get('turn_id') or identity))
        elif envelope == 'event_msg' and kind == 'task_complete':
            self._state(sid, agent, at, state='error' if payload.get('error') else 'turn-ended',
                        turnEndedAt=stamp(payload.get('completed_at')) or at,
                        currentTool=None, quiet=False)
        elif envelope == 'response_item' and kind in ('function_call', 'custom_tool_call'):
            name = payload.get('name')
            if isinstance(name, str):
                self._state(sid, agent, at, currentTool=name,
                            state='waiting' if name in ('wait_agent', 'functions.wait_agent') else 'working')
                if name not in ('exec', 'functions.exec'):
                    self._activity(session, 'tool', at, ('tool', payload.get('call_id') or identity))
        elif envelope == 'response_item' and kind in ('function_call_output', 'custom_tool_call_output'):
            self._state(sid, agent, at, currentTool=None,
                        state='working' if agent['state'] == 'waiting' else agent['state'])
        elif envelope == 'event_msg' and kind == 'token_count':
            info = payload.get('info')
            if isinstance(info, dict):
                total = info.get('total_token_usage')
                if isinstance(total, dict):
                    count = total.get('total_tokens')
                    if count is None:
                        count = sum(total.get(name, 0) or 0 for name in ('input_tokens', 'output_tokens'))
                    if isinstance(count, (int, float)) and count >= 0:
                        agent['tokensUsed'] = max(agent.get('tokensUsed') or 0, count)
                        session['tokensUsed'] = agent['tokensUsed']
        elif envelope == 'token_usage_record':
            usage = payload.get('thread_token_usage') or payload.get('total_token_usage')
            if isinstance(usage, dict):
                count = usage.get('total_tokens')
                if count is None:
                    count = sum(usage.get(name, 0) or 0 for name in ('input_tokens', 'output_tokens'))
                if isinstance(count, (int, float)) and count >= 0:
                    agent['tokensUsed'] = max(agent.get('tokensUsed') or 0, count)
                    session['tokensUsed'] = agent['tokensUsed']
        elif envelope == 'event_msg' and kind in ('patch_apply_end', 'item_completed'):
            item = payload if kind == 'patch_apply_end' else payload.get('item')
            self._state(sid, agent, at, currentTool=None,
                        state='working' if agent['state'] == 'waiting' else agent['state'])
            if isinstance(item, dict):
                item_kind = item.get('type')
                if kind == 'patch_apply_end' or item_kind == 'FileChange':
                    self._files(session, item, at, identity, cursor.cwd)
                if kind == 'patch_apply_end' or item_kind in ('CommandExecution', 'FileChange',
                                                             'McpToolCall', 'WebSearch'):
                    self._activity(session, 'tool', at, ('tool', item.get('call_id') or item.get('id') or
                                                          payload.get('call_id') or identity))
        elif envelope == 'event_msg' and kind == 'exec_command_end':
            self._state(sid, agent, at, currentTool=None)
            self._activity(session, 'tool', at, ('tool', payload.get('call_id') or identity))

    def _files(self, session, item, at, identity, cwd):
        if not successful(item):
            return
        changes = item.get('changes')
        if not isinstance(changes, dict):
            return
        observed_at, measurements = _now(), {}
        checkout = self.project_cache.get(cwd, {}).get('checkoutRoot')
        for source, change in changes.items():
            if not isinstance(source, str) or not isinstance(change, dict):
                continue
            if change.get('type') not in ('add', 'update', 'delete'):
                continue
            dest = change.get('move_path') or source
            if not isinstance(dest, str) or '\0' in dest:
                continue
            path = os.path.normpath(dest if os.path.isabs(dest) else os.path.join(cwd or '', dest))
            fid = (identity, path)
            if fid in self.file_events[session['id']]:
                continue
            self.file_events[session['id']].add(fid)
            file = next((f for f in session['files']
                         if (f.get('absolutePath') or f['path']) == path), None)
            if file is None:
                file = {'path': path, 'absolutePath': path if os.path.isabs(path) else None,
                        'events': [], 'bytes': None, 'bytesObservedAt': None, 'bytesSource': None}
                session['files'].append(file)
            # Live evidence needs the same current-size observation as an import.
            # Keep the absolute identity when the display path becomes relative.
            _file_observation(file, cwd, checkout, observed_at, measurements)
            event = {'at': at, 'kind': 'rename' if change.get('move_path') else change['type']}
            if change.get('move_path'):
                event['previousPath'] = source
            if not self.static_cutoff or at > self.static_cutoff:
                file['events'].append(event)
                file['events'].sort(key=lambda e: e['at'])
        session['files'].sort(key=lambda f: f['path'])

    def _rollouts(self, changed_sessions, changed_agents, changed_projects):
        candidates = set(self.paths.values())
        for directory in (self.live_root / 'sessions', self.live_root / 'archived_sessions'):
            if directory.is_dir():
                candidates.update(directory.rglob('*.jsonl'))
        for path in sorted(candidates):
            try:
                stat = path.stat()
            except OSError:
                continue
            cursor = self.cursors.setdefault(path, _Cursor())
            identity = (stat.st_dev, stat.st_ino)
            if cursor.identity != identity or stat.st_size < cursor.offset:
                cursor.reset()
                cursor.identity = identity
                # The static export covers files unchanged since its cutoff.
                # Read every changed file from its header so an old turn start
                # and post-export file work cannot fall outside a tail window.
                try:
                    with path.open('rb') as source:
                        header = source.readline()
                        if not header.endswith(b'\n'):
                            cursor.partial = header
                            cursor.offset = len(header)
                            continue
                        record = json.loads(header)
                        if isinstance(record, dict):
                            self._record(cursor, record, changed_sessions, changed_agents, changed_projects)
                        header_end = source.tell()
                        covered = self.static_cutoff and stamp(stat.st_mtime) <= self.static_cutoff
                        if covered:
                            source.seek(max(0, stat.st_size - 65536))
                            tail = source.read()
                            newline = tail.rfind(b'\n')
                            cursor.partial = tail[newline + 1:] if newline >= 0 else b''
                            cursor.offset = stat.st_size
                        else:
                            cursor.offset = header_end
                except (OSError, ValueError, UnicodeDecodeError):
                    cursor.reset()
                    cursor.identity = identity
            if stat.st_size == cursor.offset:
                continue
            try:
                with path.open('rb') as stream:
                    stream.seek(cursor.offset)
                    block = stream.read()
            except OSError:
                continue
            cursor.offset += len(block)
            parts = (cursor.partial + block).split(b'\n')
            cursor.partial = parts.pop()
            for line in parts:
                try:
                    record = json.loads(line)
                    if isinstance(record, dict):
                        self._record(cursor, record, changed_sessions, changed_agents, changed_projects)
                except (ValueError, UnicodeDecodeError):
                    continue

    def _rollout_reset_needed(self):
        for path, cursor in self.cursors.items():
            try:
                stat = path.stat()
            except OSError:
                return True
            if cursor.identity != (stat.st_dev, stat.st_ino) or stat.st_size < cursor.offset:
                return True
        return False

    def _reset_overlay(self):
        self.sessions.clear()
        self.agents.clear()
        self.projects.clear()
        self.project_cache.clear()
        self.paths.clear()
        self._backup_message_index = None
        self.cursors.clear()
        self.seen.clear()
        self.event_seen.clear()
        self.state_event_at.clear()
        self.file_events.clear()
        self.activity_events.clear()
        self.last_db_rows.clear()
        self.last_edges.clear()
        self._load_static()
        self.static_identity = _file_identity(self.static_path)

    def _quiet(self, changed_agents):
        current = datetime.now(timezone.utc).timestamp()
        for sid, agent in self.agents.items():
            last = agent.get('lastEventAt')
            try:
                age = current - datetime.fromisoformat(last.replace('Z', '+00:00')).timestamp() if last else 0
            except ValueError:
                age = 0
            quiet = agent['state'] in ('working', 'waiting') and age >= 60
            if quiet != agent['quiet']:
                agent['quiet'] = quiet
                changed_agents.add(sid)

    def poll(self):
        with self.lock:
            identity = _file_identity(self.static_path)
            before_sessions = {sid for sid, session in self.sessions.items()
                               if not session.get('isGuardian') and not session.get('_pendingEligibility')}
            before_agents = set(self.agents)
            reloaded = identity != self.static_identity or self._rollout_reset_needed()
            if reloaded:
                self._reset_overlay()
            changed_sessions, changed_agents, changed_projects = set(), set(), set()
            try:
                rows, edges = self._db()
            except (OSError, sqlite3.Error):
                rows, edges = {}, set()
            for sid, row in rows.items():
                previous = self.last_db_rows.get(sid)
                if previous == row:
                    continue
                session = self.sessions.setdefault(sid, _blank(sid))
                merge_metadata(session, row, 'live', database=True)
                session['_pendingEligibility'] = False
                if row.get('rollout_path'):
                    self.paths[sid] = Path(row['rollout_path'])
                if session.get('isGuardian'):
                    self.agents.pop(sid, None)
                else:
                    agent = self.agents.setdefault(sid, self._agent(session))
                    for field in ('nickname', 'role', 'model', 'reasoningEffort', 'tokensUsed'):
                        if field == 'tokensUsed':
                            value = session.get(field)
                            agent[field] = max(agent.get(field) or 0, value) if isinstance(value, int) else agent.get(field)
                            session[field] = agent[field]
                        else:
                            agent[field] = session.get(field)
                    self._project(session, changed_projects)
                    changed_agents.add(sid)
                changed_sessions.add(sid)
            self.last_db_rows = rows
            if edges != self.last_edges or changed_sessions:
                self._lineage(edges, changed_sessions, changed_agents)
                self.last_edges = edges
            self._rollouts(changed_sessions, changed_agents, changed_projects)
            if changed_sessions:
                self._lineage(edges, changed_sessions, changed_agents)
            for pid, project in self.projects.items():
                membership = [sid for sid in project.get('sessionIds', []) if sid in self.sessions and
                              not self.sessions[sid].get('isGuardian') and
                              not self.sessions[sid].get('_pendingEligibility')]
                if membership != project.get('sessionIds', []):
                    project['sessionIds'] = membership
                    changed_projects.add(pid)
            self._quiet(changed_agents)
            # Guardian records can remain in static history, but never enter live output.
            public_sessions = [sid for sid in changed_sessions if sid in self.sessions and
                               not self.sessions[sid].get('isGuardian') and
                               not self.sessions[sid].get('_pendingEligibility')]
            public_agents = [sid for sid in changed_agents if sid in self.agents]
            removed_sessions = sorted(before_sessions - {
                sid for sid, session in self.sessions.items() if not session.get('isGuardian') and
                not session.get('_pendingEligibility')})
            removed_agents = sorted(before_agents - set(self.agents))
            if public_sessions or public_agents or changed_projects or removed_sessions or removed_agents or reloaded:
                self.revision += 1
                self.observed_at = _now()
                self.last_delta = {'schemaVersion': 1, 'revision': self.revision,
                                   'observedAt': self.observed_at,
                                   'projects': [copy.deepcopy(self.projects[pid]) for pid in sorted(changed_projects)],
                                   'sessions': [_public_session(self.sessions[sid]) for sid in sorted(public_sessions)],
                                   'agents': [copy.deepcopy(self.agents[sid]) for sid in sorted(public_agents)],
                                   'removedSessionIds': removed_sessions,
                                   'removedAgentIds': removed_agents, 'reset': reloaded}
                self.changed.notify_all()
            self._last_poll = time.monotonic()
            return self.last_delta

    def snapshot(self):
        with self.lock:
            return {'schemaVersion': 1, 'revision': self.revision, 'observedAt': self.observed_at,
                    'projects': copy.deepcopy(list(self.projects.values())),
                    'sessions': [_public_session(s) for s in self.sessions.values()
                                 if not s.get('isGuardian') and not s.get('_pendingEligibility')],
                    'agents': copy.deepcopy(list(self.agents.values()))}

    def fresh_snapshot(self):
        if time.monotonic() - self._last_poll >= self.poll_interval:
            self.poll()
        return self.snapshot()

    def wait_delta(self, revision, timeout=15):
        with self.changed:
            self.changed.wait_for(lambda: self.revision > revision, timeout=timeout)
            return copy.deepcopy(self.last_delta) if self.revision > revision else None

    def _message_sources(self, selected):
        # Index relocated backup headers once. Do not feed backup records into
        # the live overlay: their activity is already in the static import.
        if self._backup_message_index is None:
            index = defaultdict(list)
            for root in ([self.backup_root / 'Codex/current', self.backup_root / 'Codex/legacy-clicky']
                         if self.backup_root else []):
                for directory in (root / 'sessions', root / 'archived_sessions'):
                    if not directory.is_dir():
                        continue
                    for path in sorted(directory.rglob('*.jsonl')):
                        try:
                            with path.open('rb') as stream:
                                line = stream.readline()
                            if not line.endswith(b'\n'):
                                continue
                            header = json.loads(line)
                            payload = header.get('payload') if isinstance(header, dict) else None
                            if isinstance(payload, dict) and header.get('type') == 'session_meta' and payload.get('id'):
                                index[str(payload['id'])].append(path)
                        except (OSError, ValueError, UnicodeDecodeError):
                            continue
            self._backup_message_index = index
        sources = dict.fromkeys((sid, path) for sid in sorted(selected)
                                for path in self._backup_message_index.get(sid, ()))
        # Directory discovery also finds live sessions missing database paths.
        for path, state in self.cursors.items():
            if state.sid in selected:
                sources[state.sid, path] = None
        for sid in sorted(selected):
            if self.paths.get(sid):
                sources[sid, self.paths[sid]] = None
        return list(sources)

    def messages(self, root_id, agent_id=None, cursor=None, limit=20):
        with self.lock:
            selected = {sid for sid, session in self.sessions.items()
                        if not session.get('isGuardian') and not session.get('_pendingEligibility')
                        and session.get('rootSessionId') == root_id}
            if agent_id:
                if agent_id not in selected:
                    return None
            if root_id not in self.sessions or self.sessions[root_id].get('isGuardian'):
                return None
            paths = self._message_sources(selected)
            id_by_path = {session.get('agentPath'): sid for sid, session in self.sessions.items()
                          if sid in selected and session.get('agentPath')}
            id_by_path['/root'] = root_id
            agent_paths = {sid: self.sessions[sid].get('agentPath') for sid in selected}
        items = []
        for sid, path in paths:
            if not path or not path.is_file():
                continue
            cursor_state = _Cursor()
            try:
                with path.open('rb') as source:
                    for line in source:
                        if not line.endswith(b'\n'):
                            break
                        try:
                            record = json.loads(line)
                        except (ValueError, UnicodeDecodeError):
                            continue
                        if (not isinstance(record, dict) or not self._accept(cursor_state, record)
                                or cursor_state.sid != sid):
                            continue
                        payload = record.get('payload') or {}
                        if record.get('type') != 'response_item':
                            continue
                        at = stamp(record.get('timestamp'))
                        kind, text, target, sender, role = None, None, None, sid, None
                        if payload.get('type') in ('function_call', 'custom_tool_call'):
                            name = payload.get('name')
                            if name in ('spawn_agent', 'send_message', 'followup_task'):
                                try:
                                    args = json.loads(payload.get('arguments') or '{}')
                                except (ValueError, TypeError):
                                    args = {}
                                text = args.get('message')
                                target_path = args.get('task_name') or args.get('target')
                                if isinstance(target_path, str):
                                    if not target_path.startswith('/'):
                                        parent_path = agent_paths.get(sid) or '/root'
                                        target_path = parent_path.rstrip('/') + '/' + target_path
                                    target = id_by_path.get(target_path)
                                kind = 'spawn-task' if name == 'spawn_agent' else 'agent-message'
                        elif payload.get('type') == 'message' and payload.get('role') in ('user', 'assistant'):
                            role = payload['role']
                            kind = 'message'
                            content = payload.get('content')
                            if isinstance(content, list):
                                text = '\n'.join(part['text'] for part in content
                                                 if isinstance(part, dict) and part.get('type') in ('input_text', 'output_text', 'text')
                                                 and isinstance(part.get('text'), str))
                            elif isinstance(content, str):
                                text = content
                        elif payload.get('type') == 'agent_message':
                            kind = 'agent-message'
                            content = payload.get('content')
                            if isinstance(content, list):
                                text = '\n'.join(part.get('text', '') for part in content
                                                 if isinstance(part, dict) and part.get('type') in ('input_text', 'output_text')
                                                 and isinstance(part.get('text'), str))
                            else:
                                text = payload.get('message') or payload.get('text')
                            sender = id_by_path.get(payload.get('author')) or sid
                            target = id_by_path.get(payload.get('recipient'))
                        if kind and isinstance(text, str) and text:
                            key = str(payload.get('id') or payload.get('call_id') or sid + ':' + _key(record))
                            items.append({'id': key, 'at': at, 'kind': kind,
                                          'fromAgentId': sender, 'toAgentId': target, 'text': text,
                                          **({'role': role} if role else {})})
            except OSError:
                continue
        items = list({item['id']: item for item in items}.values())
        if agent_id:
            items = [item for item in items if item['fromAgentId'] == agent_id or
                     item['toAgentId'] == agent_id]
        items.sort(key=lambda item: (item['at'] or '', item['id']), reverse=True)
        if cursor is not None:
            boundary = _decode_message_cursor(cursor)
            items = [item for item in items if (item['at'] or '', item['id']) < boundary]
        page = items[:limit]
        next_cursor = _encode_message_cursor(page[-1]) if len(items) > limit else None
        return {'messages': page, 'nextCursor': next_cursor}
