"""Contract checks for the checked-in synthetic demo data."""

import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[2]
GENERATOR = ROOT / "tools" / "make_demo_data.py"
DATA_FILE = ROOT / "web" / "demo" / "agent-garden-demo.json"
DENYLIST = ("private-workspace-9f3a", "sample-user-token-7c2d", "session-transcript-marker")


def run_generator(output: Path) -> bytes:
    env = dict(os.environ, PYTHONDONTWRITEBYTECODE="1")
    subprocess.run([sys.executable, str(GENERATOR), "--output", str(output)], cwd=ROOT,
                   env=env, check=True, capture_output=True, text=True)
    return output.read_bytes()


class DemoDataTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.raw = DATA_FILE.read_bytes()
        cls.data = json.loads(cls.raw)

    def test_generator_is_deterministic_and_matches_checked_in_json(self):
        with tempfile.TemporaryDirectory() as directory:
            first = run_generator(Path(directory) / "first.json")
            second = run_generator(Path(directory) / "second.json")
        self.assertEqual(first, second)
        self.assertEqual(self.raw, first)

    def test_counts_and_relationships_resolve(self):
        data = self.data
        sessions = data["sessions"]
        projects = data["projects"]
        commits = data["commits"]
        session_by_id = {session["id"]: session for session in sessions}
        project_ids = {project["id"] for project in projects}
        source_ids = {source["id"] for source in data["sources"]}
        primary = [session for session in sessions if not session["isSubagent"]]
        subagents = [session for session in sessions if session["isSubagent"]]

        self.assertEqual(len(projects), 9)
        self.assertEqual(len(primary), 148)
        self.assertEqual(len(subagents), 92)
        self.assertEqual(data["coverage"]["primarySessionCount"], len(primary))
        self.assertEqual(data["coverage"]["subagentCount"], len(subagents))
        self.assertEqual(data["coverage"]["sessionCount"], len(sessions))
        self.assertLess(len(self.raw), 2_000_000)
        self.assertEqual(data["generator"]["name"], "agent-garden-demo")
        self.assertIs(data["redacted"], False)
        self.assertEqual(data["workScore"]["version"], 1)
        self.assertEqual({session["agent"] for session in sessions}, {"codex", "claude-code"})
        agents_by_project = {
            project_id: {session["agent"] for session in sessions if session["projectId"] == project_id}
            for project_id in project_ids
        }
        self.assertGreaterEqual(sum(len(agents) == 1 for agents in agents_by_project.values()), 2)
        self.assertGreaterEqual(sum(len(agents) == 2 for agents in agents_by_project.values()), 2)

        for session in sessions:
            self.assertIn(session["projectId"], project_ids)
            self.assertTrue(session["sourceIds"])
            self.assertTrue(set(session["sourceIds"]) <= source_ids)
            if session["parentId"]:
                self.assertIn(session["parentId"], session_by_id)
            if session["rootSessionId"]:
                self.assertIn(session["rootSessionId"], session_by_id)
            if session["isSubagent"]:
                self.assertIn(session["rootSessionId"], session_by_id)
            for agent_id in session["agentIds"]:
                self.assertIn(agent_id, session_by_id)
                self.assertEqual(session_by_id[agent_id]["rootSessionId"], session["id"])
            for file in session["files"]:
                self.assertTrue(file["path"])
                self.assertTrue(file["absolutePath"].startswith(session["cwd"] + "/"))
                self.assertIsInstance(file["bytes"], int)
        commit_shas = {commit["sha"] for commit in commits}
        for commit in commits:
            self.assertIn(commit["projectId"], project_ids)
            self.assertTrue(set(commit["parentShas"]) <= commit_shas)
            if commit["sessionId"]:
                self.assertIn(commit["sessionId"], session_by_id)
                self.assertEqual(session_by_id[commit["sessionId"]]["projectId"], commit["projectId"])

    def test_privacy_scan(self):
        text = self.raw.decode("utf-8")
        self.assertNotIn("/Users/", text)
        self.assertNotIn("@", text)
        for token in DENYLIST:
            self.assertNotIn(token, text)


if __name__ == "__main__":
    unittest.main()
