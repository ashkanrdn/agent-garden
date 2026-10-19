"""Local, content-free fixtures for repository identity and evidence semantics."""

from pathlib import Path
import subprocess
import tempfile
import unittest

from agent_garden_export import enrich_projects, resolve_project


class GitEvidenceTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.base = Path(self.temp.name)
        self.repo = self.base / "project"
        self.repo.mkdir()
        self.git("init", "-q")
        self.git("config", "user.name", "Fixture")
        self.git("config", "user.email", "fixture.invalid")
        (self.repo / "sample.txt").write_text("abc")
        self.git("add", "sample.txt")
        self.git("commit", "-qm", "first")
        self.first = self.git("rev-parse", "HEAD")
        (self.repo / "sample.txt").write_text("abcdef")
        self.git("commit", "-qam", "second")
        self.second = self.git("rev-parse", "HEAD")

    def tearDown(self):
        self.temp.cleanup()

    def git(self, *args):
        return subprocess.check_output(["git", "-C", str(self.repo), *args], text=True).strip()

    def session(self, cwd=None):
        return {"id": "session-one", "cwd": str(cwd or self.repo),
                "createdAt": "2000-01-01T00:00:00Z", "updatedAt": "2099-01-01T00:00:00Z",
                "gitContext": {"sha": self.first, "branch": "main"},
                "files": [{"path": "sample.txt"}, {"path": "deleted.txt"}]}

    def test_common_directory_groups_worktree_and_missing_child(self):
        worktree = self.base / "different-worktree-name"
        self.git("worktree", "add", "-qb", "topic", str(worktree))
        root = resolve_project(str(self.repo))
        linked = resolve_project(str(worktree))
        missing_child = resolve_project(str(worktree / "removed" / "nested"))
        self.assertEqual(root["id"], linked["id"])
        self.assertEqual(root["id"], missing_child["id"])
        self.assertEqual(root["root"], linked["root"])

    def test_same_basename_missing_directories_do_not_merge(self):
        one = resolve_project(str(self.base / "missing-one" / "same"))
        two = resolve_project(str(self.base / "missing-two" / "same"))
        self.assertNotEqual(one["id"], two["id"])
        self.assertFalse(one["gitAvailable"])

    def test_nonlocal_working_directory_never_resolves_against_importer(self):
        for cwd in ("tools", "C:\\workspace\\project", "ssh://example.invalid/repo", "~/project", None):
            identity = resolve_project(cwd)
            self.assertFalse(identity["gitAvailable"])
            self.assertEqual(identity["root"], cwd)
            self.assertIsNone(identity["checkoutRoot"])
            self.assertEqual(identity["gitUnavailableReason"], "working-directory-not-local-absolute")

    def test_actual_ancestry_does_not_claim_session_ownership(self):
        session = self.session()
        result = enrich_projects([session], "2099-01-01T00:00:00Z")
        commits = {c["sha"]: c for c in result["commits"]}
        self.assertEqual(set(commits), {self.first, self.second})
        self.assertEqual(commits[self.second]["parentShas"], [self.first])
        self.assertIsNone(commits[self.first]["sessionId"])
        self.assertEqual(commits[self.first]["ownership"], "unknown")
        self.assertFalse(result["coverage"]["gitProjects"][0]["truncated"])

    def test_current_bytes_unknown_deleted_and_outside_paths(self):
        session = self.session()
        outside = self.base / "outside.txt"
        outside.write_text("x")
        session["files"].append({"absolutePath": str(outside), "path": "wrong.txt"})
        enrich_projects([session], "2099-01-01T00:00:00Z")
        current, deleted, external = session["files"]
        self.assertEqual(current["bytes"], 6)
        self.assertEqual(current["bytesSource"], "current-file-stat")
        self.assertEqual(current["bytesObservedAt"], "2099-01-01T00:00:00Z")
        self.assertEqual(current["path"], "sample.txt")
        self.assertIsNone(deleted["bytes"])
        self.assertIsNone(deleted["bytesObservedAt"])
        self.assertEqual(external["path"], str(outside))

    def test_commit_limit_is_explicit(self):
        result = enrich_projects([self.session()], "2099-01-01T00:00:00Z", max_commits_per_project=1)
        self.assertEqual(len(result["commits"]), 1)
        self.assertTrue(result["coverage"]["gitProjects"][0]["truncated"])


if __name__ == "__main__":
    unittest.main()
