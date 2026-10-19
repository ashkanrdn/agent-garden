#!/usr/bin/env python3
"""Build a private garden dataset from local Codex history.

Input databases and rollouts are read-only. This adapter exports display names,
short legacy title excerpts and evidence counts, never transcripts or tool output.
"""
from __future__ import annotations

import argparse
from collections import Counter, defaultdict
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import shutil
import sqlite3
import tempfile
import uuid


import hashlib
from datetime import datetime
import os
from pathlib import Path
import stat
import subprocess
from typing import Any


def _identity(kind: str, value: str) -> str:
    return f"{kind}-" + hashlib.sha256(value.encode()).hexdigest()[:20]


def _git(cwd: str, *args: str, timeout: int = 20) -> subprocess.CompletedProcess:
    env = dict(os.environ, GIT_OPTIONAL_LOCKS="0", GIT_TERMINAL_PROMPT="0")
    return subprocess.run(
        ["git", "-C", cwd, *args], capture_output=True, text=True,
        encoding="utf-8", errors="replace", timeout=timeout, env=env,
    )


def resolve_project(cwd: str | None, git_metadata: dict | None = None) -> dict:
    """Resolve a worktree to its shared Git directory, or retain its full cwd.

    Git context in a session header is deliberately not proof of repository
    availability. Missing child directories can still resolve through an
    existing ancestor, without combining unrelated same-name directories.
    """
    del git_metadata
    original = cwd if isinstance(cwd, str) and cwd else None
    local_path = bool(original and os.path.isabs(original) and "\0" not in original)
    original = os.path.normpath(original) if local_path else original
    ancestor = Path(original) if local_path else None
    while ancestor is not None and not ancestor.is_dir():
        ancestor = None if ancestor.parent == ancestor else ancestor.parent
    if ancestor is not None:
        try:
            top = _git(str(ancestor), "rev-parse", "--show-toplevel")
            common = _git(str(ancestor), "rev-parse", "--path-format=absolute", "--git-common-dir")
            if top.returncode == common.returncode == 0:
                root = os.path.realpath(top.stdout.strip())
                common_dir = os.path.realpath(common.stdout.strip())
                # A linked worktree shares the main repository's .git directory.
                display_root = str(Path(common_dir).parent) if Path(common_dir).name == ".git" else root
                return {
                    "id": _identity("repo", common_dir), "name": Path(display_root).name,
                    "root": display_root, "checkoutRoot": root,
                    "gitCommonDir": common_dir, "gitAvailable": True,
                    "identityBasis": "local-git-common-directory", "cwd": original,
                }
        except (OSError, subprocess.TimeoutExpired):
            pass
    return {
        "id": _identity("workspace", original or "unknown"),
        "name": Path(original).name if original else "Unlocated sessions",
        "root": original, "checkoutRoot": original if local_path else None, "gitCommonDir": None,
        "gitAvailable": False, "identityBasis": "recorded-working-directory",
        "gitUnavailableReason": "no-readable-git-repository" if local_path else "working-directory-not-local-absolute",
        "cwd": original,
    }


def worktree_project(identity: dict, projects) -> dict | None:
    """Recover display grouping for removed Codex worktrees, conservatively.

    This is an explicit managed-path inference, not evidence that the old
    checkout or its files remain available. Ambiguous repository names stay
    separate, as do arbitrary directories with matching basenames.
    """
    if identity.get('gitAvailable'):
        return None
    parts = Path(identity.get('root') or '').parts
    for index in range(len(parts) - 3):
        if parts[index:index + 2] == ('.codex', 'worktrees'):
            name = parts[index + 3]
            matches = [p for p in projects if p.get('gitAvailable')
                       and Path(p.get('root') or '').name == name]
            return matches[0] if len(matches) == 1 else None
    return None


def collapse_worktree_projects(projects: list, sessions: list) -> dict:
    """Merge managed-worktree display lots while retaining recorded cwd paths."""
    aliases = {}
    for project in projects:
        target = worktree_project(project, projects)
        if target is None:
            continue
        aliases[project['id']] = target['id']
        for key in ('workspaces', 'sessionIds'):
            values = target.setdefault(key, [])
            values.extend(value for value in project.get(key, []) if value not in values)
    for session in sessions:
        old = session.get('projectId')
        if old in aliases:
            session['projectId'] = aliases[old]
            session['projectGroupingBasis'] = 'unique-repository-for-managed-worktree-path'
    projects[:] = [p for p in projects if p['id'] not in aliases]
    return aliases


def _read_commits(project: dict, start_at: str, end_at: str, limit: int, observed_at: str) -> tuple[list, dict]:
    coverage = {"projectId": project["id"], "status": "unavailable", "count": 0,
                "truncated": False, "limit": limit, "startAt": start_at, "endAt": end_at,
                "scope": "locally-reachable-refs", "ownership": "unknown", "observedAt": observed_at}
    if not project["gitAvailable"]:
        return [], coverage
    try:
        log = _git(project["_gitPath"], "log", "--all", f"--since-as-filter={start_at}",
                   f"--until={end_at}", f"--max-count={limit + 1}",
                   "--format=%H%x00%P%x00%cI%x00%aI", timeout=45)
        refs = _git(project["_gitPath"], "for-each-ref", "--format=%(objectname)%00%(refname)",
                    "refs/heads", "refs/remotes")
    except subprocess.TimeoutExpired:
        coverage["status"] = "timed-out"
        return [], coverage
    except OSError:
        coverage["status"] = "git-command-unavailable"
        return [], coverage
    if log.returncode != 0:
        coverage["status"] = "git-log-failed"
        return [], coverage
    # These labels identify branch tips, not branch membership throughout history.
    tips: dict[str, list[str]] = {}
    if refs.returncode == 0:
        for line in refs.stdout.splitlines():
            sha, sep, ref = line.partition("\0")
            if sep:
                tips.setdefault(sha, []).append(ref)
    rows = [line for line in log.stdout.splitlines() if line]
    coverage["truncated"] = len(rows) > limit
    commits = []
    for line in rows[:limit]:
        fields = line.split("\0")
        if len(fields) != 4:
            coverage["malformedRows"] = coverage.get("malformedRows", 0) + 1
            continue
        sha, parents, committed_at, authored_at = fields
        commits.append({"id": f"{project['id']}:{sha}", "projectId": project["id"],
                        "sha": sha, "parentShas": parents.split(), "at": committed_at,
                        "authoredAt": authored_at, "sessionId": None,
                        "ownership": "unknown", "branches": tips.get(sha, []),
                        "branchLabelBasis": "current-ref-tip", "branchLabelsObservedAt": observed_at,
                        "evidence": "local-git-object"})
    commits.sort(key=lambda commit: (datetime.fromisoformat(commit["at"].replace("Z", "+00:00")).timestamp(), commit["sha"]))
    coverage.update(status="ok", count=len(commits))
    return commits, coverage


def _file_observation(file: dict, cwd: str | None, checkout: str | None,
                      observed_at: str, cache: dict) -> None:
    raw = file.get("absolutePath") or file.get("path")
    if not isinstance(raw, str) or not raw:
        file.update(bytes=None, bytesSource="unknown", bytesObservedAt=None,
                    bytesMissingReason="path-unavailable")
        return
    absolute = os.path.normpath(raw if os.path.isabs(raw) else os.path.join(cwd or "", raw))
    if not os.path.isabs(absolute):
        file.update(bytes=None, bytesSource="unknown", bytesObservedAt=None,
                    bytesMissingReason="working-directory-unavailable")
        return
    file["absolutePath"] = absolute
    file["path"] = absolute
    if checkout:
        try:
            # Resolve directory aliases (for example macOS /var -> /private/var)
            # without following a final symlink into a different file.
            canonical = os.path.join(os.path.realpath(os.path.dirname(absolute)), os.path.basename(absolute))
            if os.path.commonpath([canonical, checkout]) == checkout:
                file["path"] = os.path.relpath(canonical, checkout)
        except ValueError:
            pass
    if absolute not in cache:
        try:
            observation = os.stat(absolute, follow_symlinks=False)
            if stat.S_ISREG(observation.st_mode):
                cache[absolute] = (observation.st_size, None)
            else:
                cache[absolute] = (None, "not-a-regular-file")
        except FileNotFoundError:
            cache[absolute] = (None, "file-unavailable")
        except OSError:
            cache[absolute] = (None, "stat-failed")
    size, missing = cache[absolute]
    file.update(bytes=size, bytesSource="current-file-stat" if size is not None else "unknown",
                bytesObservedAt=observed_at if size is not None else None)
    if missing:
        file["bytesMissingReason"] = missing
    else:
        file.pop("bytesMissingReason", None)


def enrich_projects(sessions: list[dict[str, Any]], observed_at: str, *,
                    start_at: str | None = None, end_at: str | None = None,
                    max_commits_per_project: int = 10000) -> dict:
    """Attach canonical projects and current byte evidence; return actual Git DAGs.

    Mutates session.projectId and file paths/byte evidence only. A current byte
    observation cannot be replayed as a historical measurement. Git commits
    remain unassigned unless another evidence layer verifies session ownership.
    """
    if max_commits_per_project < 1:
        raise ValueError("max_commits_per_project must be positive")
    start_at = start_at or min((s["createdAt"] for s in sessions if s.get("createdAt")), default=observed_at)
    end_at = end_at or observed_at
    project_by_id: dict[str, dict] = {}
    cwd_cache: dict[str | None, dict] = {}
    byte_cache: dict[str, tuple] = {}
    for session in sessions:
        cwd = session.get("cwd")
        if cwd not in cwd_cache:
            cwd_cache[cwd] = resolve_project(cwd, session.get("gitContext"))
        identity = cwd_cache[cwd]
        session["projectId"] = identity["id"]
        if identity["id"] not in project_by_id:
            project_by_id[identity["id"]] = {
                key: value for key, value in identity.items() if key not in {"cwd", "checkoutRoot"}
            }
            project_by_id[identity["id"]].update(
                workspaces=[], sessionIds=[], _gitPath=identity["checkoutRoot"])
        project = project_by_id[identity["id"]]
        if cwd and cwd not in project["workspaces"]:
            project["workspaces"].append(cwd)
        if session["id"] not in project["sessionIds"]:
            project["sessionIds"].append(session["id"])
        for file in session.get("files", []):
            _file_observation(file, cwd, identity["checkoutRoot"], observed_at, byte_cache)
    projects = list(project_by_id.values())
    collapse_worktree_projects(projects, sessions)
    commits, git_coverage = [], []
    for project in projects:
        project_commits, project_coverage = _read_commits(project, start_at, end_at, max_commits_per_project, observed_at)
        commits.extend(project_commits)
        git_coverage.append(project_coverage)
        project["gitCoverage"] = project_coverage
        project.pop("_gitPath", None)
    return {
        "projects": sorted(projects, key=lambda p: (p["name"].lower(), p["id"])),
        "commits": commits,
        "coverage": {
            "gitProjects": git_coverage,
            "knownCurrentBytePaths": sum(size is not None for size, _ in byte_cache.values()),
            "unknownBytePaths": sum(size is None for size, _ in byte_cache.values()),
            "byteBasis": "Current regular-file stat, observed at import time; no historical size claims.",
            "gitLimitations": [
                "Only local refs and available objects are inspected; no fetch or remote history recovery.",
                "Commit ownership is unknown. Checkout metadata and time proximity do not prove ownership.",
                "Branch labels identify current ref tips; historical branch names are unavailable.",
                "Removed Codex worktrees group by managed path only when a unique repository name matches; other missing workspaces stay separate.",
            ],
        },
    }



EXPORTER_VERSION = '0.1.0'
DEFAULT_OUTPUT = Path('agent-garden.json')


def default_codex_home():
    return Path(os.environ.get('CODEX_HOME') or Path.home() / '.codex')

KNOWN_ENVELOPES = {'session_meta', 'turn_context', 'response_item', 'event_msg',
                   'compacted', 'token_usage_record', 'world_state',
                   'thread_settings_applied', 'inter_agent_communication_metadata'}


def stamp(value):
    """Normalize actual source timestamps; absent or malformed values stay absent."""
    if value is None or value == '':
        return None
    try:
        if isinstance(value, (float, int)):
            value = value / 1000 if value > 100_000_000_000 else value
            date = datetime.fromtimestamp(value, timezone.utc)
        else:
            date = datetime.fromisoformat(str(value).replace('Z', '+00:00'))
            date = date.replace(tzinfo=timezone.utc) if date.tzinfo is None else date.astimezone(timezone.utc)
        return date.isoformat(timespec='milliseconds').replace('+00:00', 'Z')
    except (ValueError, TypeError, OSError, OverflowError):
        return None


def uuid_time(value):
    try:
        parsed = uuid.UUID(value)
        return stamp(parsed.int >> 80) if parsed.version == 7 else None
    except (ValueError, TypeError, AttributeError):
        return None


def source_shape(value):
    if isinstance(value, str):
        try:
            return json.loads(value)
        except (ValueError, TypeError):
            return value
    return value


def lineage(metadata):
    source = source_shape(metadata.get('source'))
    subagent = source.get('subagent') if isinstance(source, dict) else None
    spawn = subagent.get('thread_spawn', {}) if isinstance(subagent, dict) else {}
    return {
        'isSubagent': subagent is not None,
        'isGuardian': isinstance(subagent, dict) and subagent.get('other') == 'guardian',
        'parentId': metadata.get('parent_thread_id') or spawn.get('parent_thread_id'),
        'agentPath': metadata.get('agent_path') or spawn.get('agent_path'),
        'forkedFromId': metadata.get('forked_from_id'),
        'nickname': metadata.get('agent_nickname') or spawn.get('agent_nickname'),
        'role': metadata.get('agent_role') or spawn.get('agent_role'),
    }


def empty_session(sid):
    return {'id': sid, 'agent': 'codex', 'title': 'Session ' + sid[:8], 'titleSource': 'id', 'cwd': None,
            'createdAt': None, 'updatedAt': None, 'isSubagent': False,
            'isGuardian': False, 'nickname': None, 'role': None,
            'model': None, 'reasoningEffort': None, 'tokensUsed': None,
            'parentId': None, 'rootSessionId': None, 'agentPath': None,
            'forkedFromId': None, 'sourceIds': [], 'rolloutCount': 0,
            'activity': [], 'files': [], 'commits': [], 'agentIds': [],
            'gitContext': {}, 'coverage': {}, '_metadataRank': '',
            '_events': {}, '_calls': {}, '_outcomes': {}, '_turns': {},
            '_fallbackTurns': {}, '_files': {}, '_coverage': Counter()}


def merge_metadata(session, metadata, source_id, *, database=False):
    created = stamp(metadata.get('created_at_ms') or metadata.get('created_at') or metadata.get('timestamp'))
    updated = stamp(metadata.get('updated_at_ms') or metadata.get('updated_at') or metadata.get('timestamp'))
    if created:
        session['createdAt'] = min(x for x in [session['createdAt'], created] if x)
    if updated:
        session['updatedAt'] = max(x for x in [session['updatedAt'], updated] if x)
    if source_id not in session['sourceIds']:
        session['sourceIds'].append(source_id)
    rank = (updated or '') + ('z' if source_id == 'live' else 'a')
    if rank >= session['_metadataRank']:
        session['_metadataRank'] = rank
        if metadata.get('cwd'):
            session['cwd'] = str(metadata['cwd'])
        if database and (metadata.get('name') or metadata.get('title')):
            label = metadata.get('name') or metadata.get('title')
            session['title'] = (str(label).strip().splitlines() or [session['title']])[0][:120]
            session['titleSource'] = 'database-name' if metadata.get('name') else 'database-title-excerpt'
        git = metadata.get('git') or {}
        if metadata.get('git_sha') or git.get('commit_hash'):
            session['gitContext']['sha'] = metadata.get('git_sha') or git.get('commit_hash')
        if metadata.get('git_branch') or git.get('branch'):
            session['gitContext']['branch'] = metadata.get('git_branch') or git.get('branch')
    values = lineage(metadata)
    session['isSubagent'] |= values['isSubagent']
    session['isGuardian'] |= values['isGuardian']
    for key in ['parentId', 'agentPath', 'forkedFromId', 'nickname', 'role']:
        if values[key]:
            session[key] = values[key]
    for target, source in [('model', 'model'), ('reasoningEffort', 'reasoning_effort'),
                           ('tokensUsed', 'tokens_used')]:
        value = metadata.get(source)
        if value is not None and (target != 'tokensUsed' or isinstance(value, int) and value >= 0):
            session[target] = value


def put_unique(target, key, value, coverage):
    if key in target:
        coverage['duplicateEvidence'] += 1
        return
    target[key] = value


def event_key(record, payload, line_no):
    identifier = payload.get('call_id') or payload.get('id') or payload.get('event_id')
    if identifier:
        return str(identifier)
    # Hashing is internal only. Neither the digest nor the source body is exported.
    digest = hashlib.sha256(json.dumps(payload, sort_keys=True, separators=(',', ':')).encode()).hexdigest()[:24]
    return str(record.get('timestamp', '')) + ':' + digest


def successful(payload):
    if payload.get('success') is False or payload.get('status') in ('failed', 'declined', 'cancelled', 'canceled', 'interrupted', 'in_progress'):
        return False
    return payload.get('success') is True or payload.get('status') == 'completed'


def record_files(session, payload, at, key, cwd):
    coverage = session['_coverage']
    changes = payload.get('changes')
    if not successful(payload):
        coverage['unsuccessfulFileOutcomes'] += 1
        return
    if not isinstance(changes, dict):
        coverage['unrecognizedFileChanges'] += 1
        return
    for source_path, change in changes.items():
        if not isinstance(source_path, str) or not isinstance(change, dict):
            coverage['unrecognizedFileChanges'] += 1
            continue
        kind = change.get('type', 'unknown')
        if kind not in ('add', 'update', 'delete'):
            coverage['unrecognizedFileChanges'] += 1
            continue
        destination = change.get('move_path') or source_path
        if not isinstance(destination, str) or '\x00' in destination:
            coverage['unrecognizedFileChanges'] += 1
            continue
        absolute = os.path.normpath(destination if os.path.isabs(destination) else os.path.join(cwd or '', destination))
        if not os.path.isabs(absolute):
            coverage['filesWithoutWorkingDirectory'] += 1
        previous = None
        if change.get('move_path'):
            previous = os.path.normpath(source_path if os.path.isabs(source_path) else os.path.join(cwd or '', source_path))
        identity = absolute if os.path.isabs(absolute) else 'unresolved:' + absolute
        file = session['_files'].setdefault(identity, {'path': absolute,
                    'absolutePath': absolute if os.path.isabs(absolute) else None,
                    'events': {}, 'bytes': None, 'bytesObservedAt': None,
                    'bytesSource': None})
        event = {'at': at, 'kind': 'rename' if previous else kind}
        if previous:
            event['previousPath'] = previous
        put_unique(file['events'], key + ':' + absolute, event, coverage)


def parse_rollout(path, sessions, source_id, cutoff, source_stats):
    """Stream one source; exclude inherited history before a proven boundary."""
    session = None
    sid = None
    boundary = None
    owned = True
    inherited = False
    birth = None
    turn_id = None
    cwd = None
    try:
        stream = path.open('r', encoding='utf-8', errors='replace')
    except OSError:
        source_stats['errors'] += 1
        return None
    with stream:
        for line_no, line in enumerate(stream):
            source_stats['records'] += 1
            try:
                record = json.loads(line)
                payload = record.get('payload', {})
                if not isinstance(payload, dict):
                    continue
            except (ValueError, AttributeError):
                source_stats['malformedRecords'] += 1
                continue
            at = stamp(record.get('timestamp'))
            if session is None and record.get('type') == 'session_meta' and at and at > cutoff:
                source_stats['rolloutsAfterCutoff'] += 1
                return None
            if at and at > cutoff:
                source_stats['recordsAfterCutoff'] += 1
                continue
            envelope = record.get('type')
            kind = payload.get('type')
            if session is None:
                if envelope != 'session_meta' or not payload.get('id'):
                    source_stats['recordsBeforeHeader'] += 1
                    continue
                sid = str(payload['id'])
                session = sessions.setdefault(sid, empty_session(sid))
                merge_metadata(session, payload, source_id)
                session['rolloutCount'] += 1
                source_stats['_rolloutIds'].add(sid)
                birth = stamp(payload.get('timestamp')) or at
                boundary = payload.get('subagent_history_start_ordinal')
                if not isinstance(boundary, int):
                    boundary = None
                inherited = bool(payload.get('forked_from_id') or payload.get('parent_thread_id') or boundary is not None)
                owned = not inherited
                session['_coverage'].setdefault('ownershipBoundary',
                    'explicit-ordinal' if boundary is not None else 'unresolved' if inherited else 'not-applicable')
                cwd = payload.get('cwd') or session['cwd']
                continue
            coverage = session['_coverage']
            if envelope == 'session_meta':
                if str(payload.get('id')) != sid:
                    inherited = True
                    owned = False
                    if coverage.get('ownershipBoundary') == 'not-applicable':
                        coverage['ownershipBoundary'] = 'unresolved'
                    coverage['foreignMetadataRecords'] += 1
                else:
                    merge_metadata(session, payload, source_id)
                    owned = True
                    if inherited:
                        coverage['ownershipBoundary'] = 'explicit-metadata'
                    cwd = payload.get('cwd') or cwd
                continue
            record_thread = payload.get('thread_id')
            ordinal = record.get('ordinal')
            if record_thread and str(record_thread) != sid:
                coverage['excludedForeignThreadRecords'] += 1
                continue
            if boundary is not None and isinstance(ordinal, int):
                owned = ordinal >= boundary
            elif record_thread == sid:
                owned = True
                if inherited:
                    coverage['ownershipBoundary'] = 'explicit-thread'
            elif inherited and not owned and kind == 'task_started':
                # Legacy forks rewrite envelope timestamps. Embedded start time
                # plus a newly created UUIDv7 turn gives an independent boundary.
                turn_birth = uuid_time(payload.get('turn_id'))
                embedded_start = stamp(payload.get('started_at'))
                if (birth and turn_birth and turn_birth >= birth and embedded_start
                        and embedded_start[:19] >= birth[:19]):
                    owned = True
                    coverage['derivedTurnBoundaries'] += 1
                    coverage['ownershipBoundary'] = 'derived-turn'
            if not owned:
                coverage['excludedInheritedOrUnresolvedRecords'] += 1
                continue
            if at is None:
                coverage['recordsWithoutTimestamp'] += 1
                continue
            if birth and at < birth:
                coverage['excludedPreBirthRecords'] += 1
                continue
            session['updatedAt'] = max(session['updatedAt'] or at, at)
            if envelope not in KNOWN_ENVELOPES:
                coverage['unrecognizedEnvelopeRecords'] += 1
            if envelope == 'turn_context':
                cwd = payload.get('cwd') or cwd
                turn_id = payload.get('turn_id') or turn_id
                continue
            turn_id = payload.get('turn_id') or turn_id
            if envelope == 'response_item' and kind not in ('function_call', 'custom_tool_call'):
                continue
            if envelope == 'event_msg' and kind not in ('task_started', 'user_message', 'exec_command_end', 'patch_apply_end', 'item_completed'):
                continue
            key = event_key(record, payload, line_no) if envelope in ('event_msg', 'response_item') else ''
            if envelope == 'response_item' and kind in ('function_call', 'custom_tool_call'):
                name = str(payload.get('name', ''))
                put_unique(session['_calls'], key, {'at': at, 'kind': 'tool', 'count': 1,
                           '_turn': turn_id, '_wrapper': name in ('exec', 'functions.exec'),
                           '_evidence': 'invocation'}, coverage)
            elif envelope == 'event_msg' and kind in ('task_started', 'user_message'):
                target = session['_turns'] if kind == 'task_started' else session['_fallbackTurns']
                identifier = str(payload.get('turn_id')) if payload.get('turn_id') else key
                put_unique(target, identifier, {'at': at, 'kind': 'turn', 'count': 1}, coverage)
            elif envelope == 'event_msg' and kind in ('exec_command_end', 'patch_apply_end'):
                put_unique(session['_outcomes'], key, {'at': at, 'kind': 'tool', 'count': 1,
                           '_turn': turn_id, '_evidence': 'completed-operation'}, coverage)
                if kind == 'patch_apply_end':
                    record_files(session, payload, at, key, cwd)
            elif envelope == 'event_msg' and kind == 'item_completed':
                item = payload.get('item') or {}
                if not isinstance(item, dict):
                    continue
                item_kind = item.get('type')
                item_key = str(item.get('id') or key)
                if item_kind in ('CommandExecution', 'FileChange', 'McpToolCall', 'WebSearch'):
                    put_unique(session['_outcomes'], item_key, {'at': at, 'kind': 'tool', 'count': 1,
                               '_turn': turn_id, '_evidence': 'completed-operation'}, coverage)
                if item_kind == 'FileChange':
                    record_files(session, item, at, item_key, cwd)
            # Intentionally omit token reports: the two reporting families overlap.
    if session is None:
        source_stats['rolloutsWithoutHeader'] += 1
    return sid


def database_rows(path, *, live=False, recover_wal=False):
    """Read stable backups or a live read transaction; recover legacy WAL on copies."""
    temporary = None
    if recover_wal:
        temporary = tempfile.TemporaryDirectory(prefix='garden-sqlite-')
        copy = Path(temporary.name) / path.name
        shutil.copy2(path, copy)
        wal = Path(str(path) + '-wal')
        if wal.exists():
            shutil.copy2(wal, Path(str(copy) + '-wal'))
        path = copy
    connection = None
    try:
        uri = path.as_uri() + ('?mode=ro' if live or recover_wal else '?mode=ro&immutable=1')
        connection = sqlite3.connect(uri, uri=True)
        connection.row_factory = sqlite3.Row
        connection.execute('PRAGMA query_only=ON')
        connection.execute('BEGIN')
        names = {row[0] for row in connection.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        if 'threads' not in names:
            return [], [], 'no-thread-table'
        fields = {row[1] for row in connection.execute('PRAGMA table_info(threads)')}
        allowed = ['id', 'created_at', 'updated_at', 'created_at_ms', 'updated_at_ms', 'source',
                   'cwd', 'title', 'name', 'git_sha', 'git_branch', 'agent_path', 'history_mode',
                   'rollout_path', 'agent_nickname', 'agent_role', 'model', 'reasoning_effort', 'tokens_used']
        selected = [field for field in allowed if field in fields]
        rows = [dict(row) for row in connection.execute('SELECT ' + ','.join(selected) + ' FROM threads')]
        edges = []
        if 'thread_spawn_edges' in names:
            edges = [dict(row) for row in connection.execute('SELECT parent_thread_id,child_thread_id,status FROM thread_spawn_edges')]
        return rows, edges, 'read-only-copy-with-wal' if recover_wal else 'read-only'
    finally:
        if connection:
            connection.close()
        if temporary:
            temporary.cleanup()


def normalize_codex_evidence(session):
    """Convert Codex invocation/outcome records to source-neutral count evidence."""
    outcomes = session['_outcomes']
    structured_turns = {event['_turn'] for event in outcomes.values()}
    events = {'tool:' + key: event for key, event in outcomes.items()}
    for key, event in session['_calls'].items():
        if key in outcomes:
            session['_coverage']['invocationsMatchedToOutcomes'] += 1
        elif event['_wrapper'] and event['_turn'] in structured_turns:
            session['_coverage']['wrapperInvocationsReplacedByOutcomes'] += 1
        else:
            events['tool:' + key] = event
            session['_coverage']['unmatchedToolInvocations'] += 1
    events.update({'turn:' + key: event for key, event in
                   (session['_turns'] or session['_fallbackTurns']).items()})
    session['_events'] = {key: {field: event[field] for field in ('at', 'kind', 'count')}
                          for key, event in events.items()}
    for key in ('_calls', '_outcomes', '_turns', '_fallbackTurns'):
        session.pop(key, None)


def finalize_sessions(sessions, spawn_edges):
    for parent, child in spawn_edges:
        if child in sessions:
            current = sessions[child]
            if current['parentId'] and current['parentId'] != parent:
                current['_coverage']['conflictingParentEdges'] += 1
                current['parentId'] = None
                current['_ambiguousParent'] = True
            elif not current.get('_ambiguousParent'):
                current['parentId'] = parent
            current['isSubagent'] = True
    for session in sessions.values():
        current = session
        seen = set()
        while current['isSubagent']:
            if current['id'] in seen or not current['parentId'] or current['parentId'] not in sessions:
                current = None
                session['_coverage']['unresolvedParent'] += 1
                break
            seen.add(current['id'])
            current = sessions[current['parentId']]
        session['rootSessionId'] = current['id'] if current else None
    for session in sessions.values():
        root = session['rootSessionId']
        if root and root != session['id'] and not session['isGuardian']:
            sessions[root]['agentIds'].append(session['id'])
        if '_calls' in session:  # Compatibility for parser callers and live mode.
            normalize_codex_evidence(session)
        events = list(session['_events'].values())
        # Per-hour buckets retain the last event timestamp. No future work leaks
        # into earlier playheads; a partial hour can conservatively undercount.
        buckets = {}
        for event in events:
            key = (event['at'][:13], event['kind'])
            bucket = buckets.setdefault(key, {'at': event['at'], 'kind': event['kind'], 'count': 0})
            bucket['count'] += event['count']
            bucket['at'] = max(bucket['at'], event['at'])
        session['activity'] = sorted(buckets.values(), key=lambda event: (event['at'], event['kind']))
        for file in session['_files'].values():
            file['events'] = sorted(file['events'].values(), key=lambda event: event['at'])
            session['files'].append(file)
        session['files'].sort(key=lambda file: file['path'])
        session['coverage'] = dict(session['_coverage'])
        session['coverage']['hasRollout'] = session['rolloutCount'] > 0
        for field in list(session):
            if field.startswith('_'):
                del session[field]


def normalized_session(sid, agent):
    """Create the adapter-neutral record described by SourceBatch."""
    session = empty_session(sid)
    session['agent'] = agent
    for key in ('_calls', '_outcomes', '_turns', '_fallbackTurns'):
        session.pop(key)
    return session


class SourceBatch:
    """Adapter seam: source-neutral records plus source statistics and lineage.

    An adapter implements read(cutoff) -> SourceBatch. Read sources without writes.
    cutoff is a UTC ISO timestamp; ignore later events. Records are dictionaries
    initialized with normalized_session(id, agent), using the adapter's name.
    IDs and parentId/forkedFromId references must be globally unique. Codex keeps
    its existing IDs; other agents should prefix native IDs (e.g. claude-code:).

    Required metadata: id, agent, title/titleSource (at most 120 characters), cwd,
    createdAt/updatedAt (UTC ISO or None), isSubagent/isGuardian, parentId,
    sourceIds, rolloutCount, gitContext, and defaults from empty_session().
    Adapter-private parsing fields must be removed before returning records.
    Shared internal evidence consists of:
      _events: stable unique evidence key -> {at, kind: tool|turn, count}.
      _files: stable path key -> {path, absolutePath, bytes, bytesObservedAt,
              bytesSource, events: {stable key: {at, kind, previousPath?}}}.
      _coverage: Counter of gaps/counts; ownershipBoundary may be a string.
      _metadataRank: deterministic metadata precedence key, newest wins.
    No messages, prompts, tool arguments, output, or file contents are allowed.
    Codex reconciles duplicate live/backup evidence before normalization.

    sources is a list of dictionaries: id (matching record.sourceIds), kind,
    path, exists/status, scope, sessions, rollouts, databaseSessions, records,
    errors, plus optional parser statistics. spawn_edges is a set of
    (parent_id, child_id) pairs. The shared pipeline merges records, resolves
    primary sessions, groups Git common directories, enriches files/commits,
    and assembles the unchanged version-one work-score contract and dataset.
    """

    def __init__(self, records, sources, spawn_edges=()):
        self.records = records
        self.sources = sources
        self.spawn_edges = set(spawn_edges)


class CodexAdapter:
    """Read live Codex and an optional backup as one source family."""

    def __init__(self, codex_home=None, backup_root=None):
        self.codex_home = Path(codex_home or default_codex_home()).expanduser().resolve()
        self.backup_root = Path(backup_root).expanduser().resolve() if backup_root else None

    def read(self, cutoff):
        live_root, backup_root = self.codex_home, self.backup_root
        specs = [
            ('backup-current', 'backup', backup_root / 'Codex/current', 'state_5-consistent-snapshot.sqlite', False, True),
            ('backup-migration', 'backup', backup_root / 'Codex/current/legacy-sqlite', 'state_5.sqlite', True, False),
            ('backup-legacy', 'backup', backup_root / 'Codex/legacy-clicky', 'state_5.sqlite', True, True),
        ] if backup_root else []
        specs.append(('live', 'live', live_root, 'state_5.sqlite', False, True))
        sessions, sources, edges = {}, [], set()
        for source_id, kind, root, db_name, recover_wal, scan_rollouts in specs:
            stats = Counter(records=0, errors=0, malformedRecords=0)
            stats['_rolloutIds'] = set()
            source = {'id': source_id, 'kind': 'codex-' + kind, 'path': str(root), 'sessions': 0,
                      'rollouts': 0, 'databaseSessions': 0, 'databaseStatus': 'missing',
                      'exists': root.is_dir(), 'status': 'available' if root.is_dir() else 'missing',
                      'scope': 'metadata-and-rollouts' if scan_rollouts else 'metadata-only'}
            database = root / db_name
            if not database.exists() and source_id == 'backup-current':
                database = root / 'state_5.sqlite'
            if database.exists():
                try:
                    rows, source_edges, status = database_rows(database, live=kind == 'live', recover_wal=recover_wal)
                    source['databaseStatus'] = status
                    source['databaseSessions'] = len(rows)
                    for row in rows:
                        created = stamp(row.get('created_at_ms') or row.get('created_at'))
                        if created and created > cutoff:
                            continue
                        sid = str(row['id'])
                        merge_metadata(sessions.setdefault(sid, empty_session(sid)), row, source_id, database=True)
                    for edge in source_edges:
                        if edge.get('parent_thread_id') and edge.get('child_thread_id'):
                            edges.add((str(edge['parent_thread_id']), str(edge['child_thread_id'])))
                except (sqlite3.Error, OSError) as error:
                    source['databaseStatus'] = 'error:' + type(error).__name__
                    stats['errors'] += 1
            for directory in ([root / 'sessions', root / 'archived_sessions'] if scan_rollouts else []):
                if not directory.is_dir():
                    continue
                for path in sorted(directory.rglob('*.jsonl')):
                    source['rollouts'] += 1
                    parse_rollout(path, sessions, source_id, cutoff, stats)
            source['rolloutSessions'] = len(stats.pop('_rolloutIds'))
            source.update(dict(stats))
            sources.append(source)
        for session in sessions.values():
            normalize_codex_evidence(session)
        return SourceBatch(list(sessions.values()), sources, edges)


def merge_session_records(sessions, record):
    """Merge normalized copies by ID, preserving unique evidence and lineage."""
    import copy
    sid = record['id']
    if sid not in sessions:
        sessions[sid] = copy.deepcopy(record)
        return
    current = sessions[sid]
    if current['agent'] != record['agent']:
        raise ValueError('Session IDs must be namespaced across different agents')
    if record['_metadataRank'] >= current['_metadataRank']:
        for key in ('title', 'titleSource', 'cwd', 'nickname', 'role', 'model',
                    'reasoningEffort', 'tokensUsed', 'agentPath', 'forkedFromId'):
            if record.get(key) is not None:
                current[key] = record[key]
        current['gitContext'].update(record['gitContext'])
        current['_metadataRank'] = record['_metadataRank']
    for key, choose in (('createdAt', min), ('updatedAt', max)):
        values = [value for value in (current[key], record[key]) if value]
        current[key] = choose(values) if values else None
    for key in ('isSubagent', 'isGuardian'):
        current[key] |= record[key]
    if current['parentId'] and record['parentId'] and current['parentId'] != record['parentId']:
        current['parentId'] = None
        current['_ambiguousParent'] = True
        current['_coverage']['conflictingParentEdges'] += 1
    elif not current.get('_ambiguousParent'):
        current['parentId'] = current['parentId'] or record['parentId']
    current['sourceIds'].extend(source for source in record['sourceIds'] if source not in current['sourceIds'])
    current['rolloutCount'] += record['rolloutCount']
    for key, value in record['_coverage'].items():
        if isinstance(value, int):
            current['_coverage'][key] += value
        else:
            current['_coverage'].setdefault(key, value)
    for key, event in record['_events'].items():
        put_unique(current['_events'], key, copy.deepcopy(event), current['_coverage'])
    for key, file in record['_files'].items():
        if key not in current['_files']:
            current['_files'][key] = copy.deepcopy(file)
        else:
            for event_key, event in file['events'].items():
                put_unique(current['_files'][key]['events'], event_key, copy.deepcopy(event), current['_coverage'])


def build_dataset(codex_home=None, backup_root=None, *, enrich_git=True,
                  adapters=None, cutoff=None):
    """Run the shared pipeline; pass adapters to add another history source."""
    cutoff = stamp(cutoff or datetime.now(timezone.utc).isoformat())
    if cutoff is None:
        raise ValueError('Invalid source cutoff timestamp')
    adapters = [CodexAdapter(codex_home, backup_root)] if adapters is None else adapters
    sessions, sources, edges = {}, [], set()
    for adapter in adapters:
        batch = adapter.read(cutoff)
        for record in batch.records:
            merge_session_records(sessions, record)
        sources.extend(batch.sources)
        edges.update(batch.spawn_edges)
    if not sessions:
        raise ValueError('No sessions found in the configured local sources')
    finalize_sessions(sessions, edges)
    session_list = sorted(sessions.values(), key=lambda value: (value['createdAt'] or '', value['id']))
    for session in session_list:
        if session['updatedAt'] and session['updatedAt'] > cutoff:
            session['updatedAt'] = cutoff
    for source in sources:
        source['sessions'] = sum(source['id'] in session['sourceIds'] for session in session_list)
    start = min((session['createdAt'] for session in session_list if session['createdAt']), default=cutoff)
    if enrich_git:
        observation_at = stamp(datetime.now(timezone.utc).isoformat())
        enriched = enrich_projects(session_list, observation_at, start_at=start, end_at=cutoff)
    else:
        enriched = {'projects': [], 'commits': [], 'coverage': {'gitSkipped': True}}
    for project in enriched['projects']:
        project.setdefault('git', {'available': project.get('gitAvailable', False),
                                  'reason': None if project.get('gitAvailable') else 'Repository unavailable at import'})
    for commit in enriched['commits']:
        commit.setdefault('parents', commit.get('parentShas', []))
        commit.setdefault('ownerSessionId', commit.get('sessionId'))
    coverage = {
        'sessionCount': len(session_list),
        'primarySessionCount': sum(not session['isSubagent'] for session in session_list),
        'subagentCount': sum(session['isSubagent'] for session in session_list),
        'unresolvedSubagents': sum(session['isSubagent'] and not session['rootSessionId'] for session in session_list),
        'sessionsWithoutRollouts': sum(not session['rolloutCount'] for session in session_list),
        'sessionsWithUnresolvedInheritance': sum(session['coverage'].get('ownershipBoundary') == 'unresolved' for session in session_list),
        'mergedSessionCopies': sum(max(0, len(session['sourceIds']) - 1) for session in session_list),
        'recordedToolOperations': sum(event['count'] for session in session_list for event in session['activity'] if event['kind'] == 'tool'),
        'recordedTurns': sum(event['count'] for session in session_list for event in session['activity'] if event['kind'] == 'turn'),
        'successfulFileEvents': sum(len(file['events']) for session in session_list for file in session['files']),
        'sourceErrors': sum(source.get('errors', 0) for source in sources),
        'malformedRecords': sum(source.get('malformedRecords', 0) for source in sources),
        'limits': [
            'File activity includes explicit successful Codex patch outcomes, not every shell or editor write.',
            'File bytes are current observations. Historical byte sizes are unknown.',
            'Git commits have unknown session ownership; metadata Git SHAs are context only.',
            'Legacy inherited history without an ownership boundary is excluded.',
            'Tool work combines completed operations and unmatched direct invocations; wrapper replacement can undercount opaque operations.',
            'Activity uses hourly buckets timestamped at the last event; partial hours can undercount.',
            'Token usage is omitted because overlapping report formats require separate reconciliation.',
            'Missing source folders and repositories remain visible as coverage gaps.',
        ],
    }
    aggregate = Counter()
    for session in session_list:
        aggregate.update({key: value for key, value in session['coverage'].items() if isinstance(value, int) and not isinstance(value, bool)})
    coverage['parser'] = dict(aggregate)
    coverage['git'] = enriched['coverage']
    generated_at = stamp(datetime.now(timezone.utc).isoformat())
    return {'schemaVersion': 1, 'generator': {'name': 'agent-garden-export', 'version': EXPORTER_VERSION},
            'redacted': False, 'generatedAt': generated_at, 'sourceCutoffAt': cutoff, 'sources': sources,
            'coverage': coverage, 'timeRange': {'start': start, 'end': generated_at},
            'projects': enriched['projects'], 'sessions': session_list,
            'commits': enriched['commits'], 'workScore': {
                'version': 1,
                'formula': 'log1p(toolCount + 2*turnCount + 3*distinctFiles + 4*agentCount + 5*ownedCommits)',
                'weights': {'tool': 1, 'turn': 2, 'distinctFile': 3, 'agent': 4, 'ownedCommit': 5},
                'descendants': 'Included once in the root session at their actual event times',
                'meaning': 'Recorded activity proxy, not elapsed time or code quality',
            }}


def write_dataset(dataset, output):
    output = Path(output)
    output.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(prefix='.' + output.name + '-', suffix='.tmp', dir=output.parent)
    try:
        with os.fdopen(descriptor, 'w', encoding='utf-8') as stream:
            json.dump(dataset, stream, ensure_ascii=False, separators=(',', ':'))
            stream.write('\n')
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, output)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--codex-home', type=Path, default=default_codex_home(),
                        help='Codex history directory (default: CODEX_HOME or ~/.codex)')
    parser.add_argument('--live-root', dest='codex_home', type=Path, help=argparse.SUPPRESS)
    parser.add_argument('--backup-root', type=Path, help='Optional Codex backup directory')
    parser.add_argument('--output', type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument('--skip-git', action='store_true', help='Parser-only diagnostics; omit repository enrichment')
    args = parser.parse_args(argv)
    try:
        dataset = build_dataset(args.codex_home, args.backup_root, enrich_git=not args.skip_git)
        write_dataset(dataset, args.output)
    except (ValueError, OSError) as error:
        parser.exit(1, f'Export failed: {error}\n')
    print(f"Exported {len(dataset['sessions'])} sessions, {len(dataset['projects'])} projects, "
          f"{len(dataset['commits'])} commits.\n"
          f"Output: {args.output.resolve()} ({args.output.stat().st_size:,} bytes)")


if __name__ == '__main__':
    main()
