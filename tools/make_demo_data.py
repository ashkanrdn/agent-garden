#!/usr/bin/env python3
"""Build the checked-in synthetic garden used by the hosted demo."""

from __future__ import annotations

import argparse
from datetime import datetime, timedelta, timezone
import hashlib
import random
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import agent_garden_export as exporter


VERSION = "1.0.0"
SEED = 20261019
PRIMARY_COUNT = 148
SUBAGENT_COUNT = 92
START = datetime(2026, 7, 27, tzinfo=timezone.utc)
END = datetime(2026, 10, 19, 23, 59, tzinfo=timezone.utc)
PROJECTS = [
    "tidepool-api", "lantern-cli", "moss-docs", "cinder-ui", "orbit-cache",
    "willow-search", "papertrail-sync", "ember-metrics", "harbor-auth",
]
TITLE_CHOICES = [
    "Fix flaky retry test", "Add CSV export", "Update setup guide", "Refine cache keys",
    "Handle empty response", "Add request tracing", "Simplify config loading",
    "Improve search ranking", "Fix pagination edge case", "Add migration check",
    "Document local setup", "Reduce duplicate queries", "Add validation rules",
    "Tune refresh interval", "Fix keyboard navigation", "Add archive command",
]
FILE_CHOICES = [
    ("src", "client", "request", ".py"), ("src", "commands", "export", ".ts"),
    ("src", "components", "panel", ".tsx"), ("src", "core", "config", ".go"),
    ("src", "search", "ranking", ".rs"), ("src", "sync", "worker", ".js"),
    ("tests", "unit", "retry", ".py"), ("tests", "integration", "api", ".ts"),
    ("docs", "guides", "setup", ".md"), ("docs", "reference", "options", ".md"),
    ("scripts", "release", "check", ".sh"), ("config", "defaults", "service", ".yaml"),
    ("web", "styles", "tokens", ".css"), ("web", "views", "history", ".html"),
    ("migrations", "2026", "add_index", ".sql"), ("examples", "basic", "usage", ".json"),
]
SOURCES = {
    "codex": {"id": "demo-codex", "kind": "codex-live", "path": "/home/dev/.codex"},
    "claude-code": {"id": "demo-claude", "kind": "claude-code", "path": "/home/dev/.claude/projects"},
}


def stamp(value: datetime) -> str:
    return value.isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _session_dates(rng: random.Random, count: int) -> list[datetime]:
    dates = []
    burst_days = (12, 31, 52, 83)
    for _ in range(count - len(burst_days) * 4):
        day = rng.choices(range(84), weights=[1.7 if n % 7 < 5 else 0.65 for n in range(84)])[0]
        dates.append(START + timedelta(days=day, hours=rng.choices(range(8, 20), weights=[1, 2, 3, 4, 5, 5, 4, 3, 3, 2, 2, 1])[0]))
    # Add a few busy days so the history has visible bursts.
    for day in burst_days:
        dates.extend(START + timedelta(days=day, hours=10 + index % 8) for index in range(4))
    dates.sort()
    return dates


def _project_agents(project: str, index: int) -> tuple[str, ...]:
    if index == 1:
        return ("codex",)
    if index == 4:
        return ("claude-code",)
    return ("codex", "claude-code")


def _new_record(rng: random.Random, sid: str, agent: str, project: str,
                created: datetime, *, parent: str | None = None, title: str | None = None) -> dict:
    record = exporter.normalized_session(sid, agent)
    record.update({
        "title": title or rng.choice(TITLE_CHOICES), "titleSource": "demo",
        "cwd": f"/home/dev/projects/{project}", "createdAt": stamp(created),
        "updatedAt": stamp(created + timedelta(minutes=rng.randint(20, 210))),
        "isSubagent": parent is not None, "parentId": parent,
        "sourceIds": [SOURCES[agent]["id"]], "rolloutCount": 1,
        "model": "synthetic-model", "reasoningEffort": rng.choice(["low", "medium", "high"]),
    })
    event_count = rng.randint(4, 10)
    duration = max(1, min(5, (datetime.fromisoformat(record["updatedAt"].replace("Z", "+00:00")) - created).seconds // 3600 + 1))
    for index in range(event_count):
        at = stamp(created + timedelta(minutes=rng.randint(0, max(1, duration * 60))))
        kind = "tool" if index % 3 else "turn"
        record["_events"][f"{sid}:{index:02d}"] = {"at": at, "kind": kind, "count": rng.randint(1, 4) if kind == "tool" else 1}
    file_count = rng.choices([1, 2, 3, 5, 8, 13], weights=[15, 24, 26, 20, 11, 4])[0]
    chosen = rng.sample(FILE_CHOICES, min(file_count, len(FILE_CHOICES)))
    for index, pieces in enumerate(chosen):
        folder, section, stem, extension = pieces
        path = f"{folder}/{section}/{stem}_{rng.randint(1, 18)}{extension}"
        absolute = record["cwd"] + "/" + path
        at = stamp(created + timedelta(minutes=rng.randint(0, max(1, duration * 60))))
        record["_files"][path] = {
            "path": path, "absolutePath": absolute, "bytes": rng.choices(
                [0, rng.randint(80, 1800), rng.randint(1801, 24000), rng.randint(24001, 180000)],
                weights=[1, 6, 4, 1])[0],
            "bytesObservedAt": stamp(END), "bytesSource": "synthetic-observation",
            "events": {f"{sid}:file:{index}": {"at": at}},
        }
    return record


class DemoAdapter:
    def __init__(self, records: list[dict]):
        self.records = records
        self.sources = []
        for agent, spec in SOURCES.items():
            count = sum(record["agent"] == agent for record in records)
            self.sources.append({
                **spec, "exists": True, "status": "available", "scope": "synthetic-demo",
                "sessions": count, "rollouts": count, "databaseSessions": 0,
                "records": count, "errors": 0, "malformedRecords": 0,
            })

    def read(self, cutoff: str) -> exporter.SourceBatch:
        return exporter.SourceBatch(self.records, self.sources)


def make_dataset() -> dict:
    rng = random.Random(SEED)
    dates = _session_dates(rng, PRIMARY_COUNT)
    records = []
    roots_by_project: dict[str, list[dict]] = {name: [] for name in PROJECTS}
    for index, created in enumerate(dates):
        project_index = index % len(PROJECTS)
        project = PROJECTS[project_index]
        allowed = _project_agents(project, project_index)
        agent = allowed[index % len(allowed)]
        sid = f"demo-session-{index + 1:04d}"
        record = _new_record(rng, sid, agent, project, created)
        records.append(record)
        roots_by_project[project].append(record)

    for index in range(SUBAGENT_COUNT):
        root = rng.choice(roots_by_project[PROJECTS[index % len(PROJECTS)]])
        created = datetime.fromisoformat(root["createdAt"].replace("Z", "+00:00")) + timedelta(minutes=rng.randint(10, 95))
        root_project_index = PROJECTS.index(root["cwd"].rsplit("/", 1)[-1])
        agent = root["agent"] if root_project_index in (1, 4) else (
            "claude-code" if root["agent"] == "codex" else "codex")
        sid = f"demo-agent-{index + 1:04d}"
        records.append(_new_record(rng, sid, agent, root["cwd"].rsplit("/", 1)[-1], created,
                                   parent=root["id"], title=rng.choice(TITLE_CHOICES)))

    cutoff = stamp(END)
    data = exporter.build_dataset(adapters=[DemoAdapter(records)], cutoff=cutoff, enrich_git=False)
    grouped: dict[str, dict] = {}
    for session in data["sessions"]:
        cwd = session["cwd"]
        project_id = "workspace-" + hashlib.sha256(cwd.encode("utf-8")).hexdigest()[:20]
        session["projectId"] = project_id
        project = grouped.setdefault(project_id, {
            "id": project_id, "name": cwd.rsplit("/", 1)[-1], "root": cwd,
            "gitCommonDir": None, "gitAvailable": False,
            "identityBasis": "recorded-working-directory",
            "gitUnavailableReason": "no-readable-git-repository",
            "workspaces": [cwd], "sessionIds": [],
        })
        project["sessionIds"].append(session["id"])
    data["projects"] = sorted(grouped.values(), key=lambda item: (item["name"].lower(), item["id"]))
    for project in data["projects"]:
        coverage = {
            "projectId": project["id"], "status": "unavailable", "count": 0,
            "truncated": False, "limit": 10000, "startAt": data["timeRange"]["start"],
            "endAt": cutoff, "scope": "locally-reachable-refs", "ownership": "unknown",
        }
        project["gitCoverage"] = coverage
        project["git"] = {"available": False, "reason": "Repository unavailable at import"}
    data["coverage"]["git"] = {"gitProjects": [p["gitCoverage"] for p in data["projects"]],
                                "gitLimitations": ["Synthetic demo commits illustrate Git ancestry."]}
    for session in data["sessions"]:
        source_record = next(item for item in records if item["id"] == session["id"])
        synthetic_by_absolute = {
            item["absolutePath"]: item for item in source_record["_files"].values()
        }
        for file in session["files"]:
            synthetic_file = synthetic_by_absolute[file["absolutePath"]]
            file["bytes"] = synthetic_file["bytes"]
            file["bytesSource"] = "synthetic-demo"
            file["bytesObservedAt"] = cutoff
            file.pop("bytesMissingReason", None)
    project_sessions = {
        project["id"]: [session for session in data["sessions"] if session["projectId"] == project["id"] and not session["isSubagent"]]
        for project in data["projects"]
    }
    commits = []
    for project_index, project in enumerate(data["projects"]):
        sessions = project_sessions[project["id"]]
        count = 3 + (project_index * 5 % 14)
        parents = []
        for commit_index in range(count):
            at = START + timedelta(days=(project_index * 9 + commit_index * 5) % 84,
                                   hours=9 + (commit_index * 3) % 10)
            sha = f"demo-{project_index + 1:02d}-{commit_index + 1:03d}"
            owned = commit_index % 4 != 0
            owner = rng.choice(sessions) if owned else None
            commit = {
                "id": f"{project['id']}:{sha}", "projectId": project["id"], "sha": sha,
                "parentShas": parents[-2:] if commit_index % 9 == 8 else parents[-1:],
                "parents": parents[-2:] if commit_index % 9 == 8 else parents[-1:],
                "at": stamp(at), "authoredAt": stamp(at - timedelta(minutes=4)),
                "sessionId": owner["id"] if owner else None,
                "ownerSessionId": owner["id"] if owner else None,
                "ownership": "verified" if owner else "unknown",
                "branches": ["main"], "branchLabelBasis": "synthetic-demo",
                "evidence": "synthetic-demo",
            }
            commits.append(commit)
            parents.append(sha)
    data["commits"] = sorted(commits, key=lambda item: (item["at"], item["sha"]))
    commit_counts = {project["id"]: 0 for project in data["projects"]}
    for commit in data["commits"]:
        commit_counts[commit["projectId"]] += 1
    for project in data["projects"]:
        project["gitCoverage"].update(status="synthetic-demo", count=commit_counts[project["id"]])
    data["generator"] = {"name": "agent-garden-demo", "version": VERSION}
    data["generatedAt"] = cutoff
    data["sourceCutoffAt"] = cutoff
    data["timeRange"] = {"start": min(item["createdAt"] for item in data["sessions"]), "end": cutoff}
    data["redacted"] = False
    # The work-score definition is authored by the exporter and carried through unchanged.
    data["coverage"]["sessionCount"] = len(data["sessions"])
    data["coverage"]["primarySessionCount"] = PRIMARY_COUNT
    data["coverage"]["subagentCount"] = SUBAGENT_COUNT
    data["coverage"]["unresolvedSubagents"] = sum(
        session["isSubagent"] and not session["rootSessionId"] for session in data["sessions"])
    for source in data["sources"]:
        source["sessions"] = sum(source["id"] in session["sourceIds"] for session in data["sessions"])
    return data


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=Path("web/demo/agent-garden-demo.json"))
    args = parser.parse_args(argv)
    exporter.write_dataset(make_dataset(), args.output)
    print(f"Wrote {args.output} ({args.output.stat().st_size:,} bytes)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
