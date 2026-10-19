import copy
import json
from pathlib import Path
import tempfile
import unittest

from agent_garden_export import collapse_worktree_projects, enrich_projects
from unittest.mock import patch
from local.live_garden import LiveGardenState


class WorktreeGroupingTest(unittest.TestCase):
    def fixture(self):
        return {
            'projects': [
                {'id': 'repo', 'name': 'canvas', 'root': '/repos/canvas',
                 'gitAvailable': True, 'sessionIds': ['main'], 'workspaces': ['/repos/canvas']},
                {'id': 'old', 'name': 'src', 'root': '/home/me/.codex/worktrees/123/canvas/src',
                 'gitAvailable': False, 'sessionIds': ['work'],
                 'workspaces': ['/home/me/.codex/worktrees/123/canvas/src']},
            ],
            'sessions': [{'id': 'main', 'projectId': 'repo'}, {'id': 'work', 'projectId': 'old'}],
        }

    def test_missing_managed_worktree_and_child_share_main_lot(self):
        data = self.fixture()
        collapse_worktree_projects(data['projects'], data['sessions'])
        self.assertEqual(len(data['projects']), 1)
        self.assertEqual(data['sessions'][1]['projectId'], 'repo')
        self.assertEqual(data['projects'][0]['sessionIds'], ['main', 'work'])
        self.assertEqual(len(data['projects'][0]['workspaces']), 2)
        before = copy.deepcopy(data)
        collapse_worktree_projects(data['projects'], data['sessions'])
        self.assertEqual(data, before)

    def test_unrelated_and_ambiguous_names_stay_separate(self):
        for root, duplicate in [('/other/canvas', False),
                                ('/home/me/.codex/worktrees/123/canvas', True)]:
            data = self.fixture()
            data['projects'][1]['root'] = root
            if duplicate:
                data['projects'].append(dict(data['projects'][0], id='other', root='/other/canvas'))
            before = copy.deepcopy(data)
            collapse_worktree_projects(data['projects'], data['sessions'])
            self.assertEqual(data, before)

    def test_live_load_normalizes_saved_projects(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            path = root / 'data.json'
            path.write_text(json.dumps(self.fixture()))
            state = LiveGardenState(root, path, initial_poll=False, backup_root=root)
            self.assertEqual(len(state.projects), 1)
            self.assertEqual(state.sessions['work']['projectId'], 'repo')
            session = {'id': 'new', 'cwd': '/home/me/.codex/worktrees/456/canvas'}
            state._project(session, set())
            self.assertEqual(session['projectId'], 'repo')
            self.assertEqual(len(state.projects), 1)

    def test_import_groups_before_git_collection(self):
        data = self.fixture()
        identities = {p['id']: dict(p, checkoutRoot=p['root']) for p in data['projects']}
        for session in data['sessions']:
            session['cwd'] = session['projectId']
        with patch('agent_garden_export.resolve_project', side_effect=lambda cwd, meta: identities[cwd]), \
             patch('agent_garden_export._read_commits', return_value=([], {})) as commits:
            result = enrich_projects(data['sessions'], '2026-09-24T00:00:00Z')
        self.assertEqual(len(result['projects']), 1)
        self.assertEqual(commits.call_count, 1)
        self.assertEqual(data['sessions'][1]['projectId'], 'repo')


if __name__ == '__main__':
    unittest.main()
