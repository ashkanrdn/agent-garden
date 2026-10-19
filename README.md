# Agent Garden

Agent Garden shows local Codex and Claude Code sessions as a browser garden with projects, commits, and changed files.

<!-- SITE_URL -->

![Agent Garden screenshot](docs/screenshot.png)

## Quick start

1. Run the exporter with Python 3.9 or newer. Set `SITE_URL` to the hosted site URL after publication. Choose either method:

   ```sh
   curl -fsSL "$SITE_URL/agent_garden_export.py" | python3 -
   ```

   Or download the script, read it, then run it:

   ```sh
   curl -fsSLo agent_garden_export.py "$SITE_URL/agent_garden_export.py"
   python3 agent_garden_export.py
   ```

   The default output is `agent-garden.json` in the current directory. A successful run ends with lines like these:

   ```text
   Exported 7 sessions, 1 projects, 0 commits.
   Output: /path/to/agent-garden.json (11,277 bytes)
   ```

2. Open the hosted site at `SITE_URL`. You can also use **Try the demo garden** without an export.
3. Drop `agent-garden.json` on the page, or choose it with the file picker.

The exporter uses only the Python standard library. Read [privacy details](docs/privacy.md) before sharing an export.

## What's in the file and privacy

The JSON contains source counts, timestamps, project and session metadata, short titles, paths, file events, current sizes, and local Git commits. It can include project names, workspace paths, branch names, file paths, and session titles.

It does not contain full message bodies, full prompts, tool arguments, tool output, or file contents. A title may contain a short prompt excerpt. The hosted page reads the selected file through the browser File API. It keeps the data in memory and never uploads it. The hosted site has no data upload endpoint, account, or upload analytics.

Use `--redact` before sharing the JSON. It replaces names, paths, titles, branches, and linked identifiers while preserving counts, timestamps, file extensions, sizes, and relationships. Review any file before publishing it.

## Exporter options

These are the options printed by `python3 agent_garden_export.py --help`:

| Option | Use |
| --- | --- |
| `--source {all,codex,claude-code}` | Select history. Default: `all`. |
| `--codex-home CODEX_HOME` | Set the Codex history directory. Default: `CODEX_HOME` or `~/.codex`. |
| `--claude-home CLAUDE_HOME` | Set the Claude directory. Default: `CLAUDE_CONFIG_DIR` or `~/.claude`. |
| `--backup-root BACKUP_ROOT` | Add an optional Codex backup directory. |
| `--output OUTPUT` | Set the output path. Default: `./agent-garden.json`. |
| `--no-git` | Skip Git inspection and commit history. |
| `--redact` | Replace private labels and paths for sharing. |
| `-h, --help` | Show help and exit. |

Exact help output:

```text
usage: agent_garden_export.py [-h] [--source {all,codex,claude-code}]
                              [--codex-home CODEX_HOME]
                              [--claude-home CLAUDE_HOME]
                              [--backup-root BACKUP_ROOT] [--output OUTPUT]
                              [--no-git] [--redact]

Export local Codex and Claude Code session metadata, counts, and changed
paths. No message text, prompts, tool output, or file contents are written.
Short titles are included; --redact removes them and replaces names and paths.

options:
  -h, --help            show this help message and exit
  --source {all,codex,claude-code}
                        History to read (default: all)
  --codex-home CODEX_HOME
                        Codex history directory (default: CODEX_HOME or
                        ~/.codex)
  --claude-home CLAUDE_HOME
                        Claude directory (default: CLAUDE_CONFIG_DIR or
                        ~/.claude)
  --backup-root BACKUP_ROOT
                        Optional Codex backup directory
  --output OUTPUT       Output file (default: ./agent-garden.json)
  --no-git              Skip Git inspection and commit history
  --redact              Replace private labels and paths for sharing
```

## Sources and limits

Codex reads its live history from `CODEX_HOME` or `~/.codex`. Supply `--backup-root` to include an optional backup. Claude Code reads JSONL transcripts under `~/.claude/projects` or `CLAUDE_CONFIG_DIR/projects`.

Claude Code deletes transcripts older than 30 days by default. Its `cleanupPeriodDays` setting controls that period. Older sessions cannot appear if their transcripts were deleted.

File change counts include supported successful edit tools. Bash writes are not counted. The exporter cannot establish which session owns a Git commit. File sizes describe files at export time, not their historical sizes. Missing histories and Git data appear as coverage gaps. See the [data format](docs/data-format.md) for the fields.

## How to read the garden

| Term | Meaning |
| --- | --- |
| Project Plot | A region for one repository or recorded workspace. |
| Session Tree | A primary coding session and its recorded work, including delegated work. |
| Agent Flock | Birds that represent delegated agents. |
| Fruit | A visible Git commit. Unknown session ownership leaves fruit with its project. |
| File Tile | A changed file; area shows current byte size, color shows type, and glow shows activity. |
| Playhead | The selected moment in recorded history. |
| Arrival Weather | Decorative clouds, rain, and lightning when a session tree arrives. |

## Run locally and Live Mode

Clone the repo and run `python3 local/start_garden.py`. The launcher starts a local server and opens the garden. Use **Refresh local data** to import the latest records. **Live Mode** follows current Codex session and delegated-agent activity. Claude Code appears in exports but is not a Live Mode source.

## Development

| Path | Contents |
| --- | --- |
| `agent_garden_export.py` | Standalone exporter. |
| `web/` | Static garden, bundled dependencies, and synthetic demo data. |
| `local/` | Local server, launcher, and Live Mode. |
| `tests/web/`, `tests/python/`, `tests/fixtures/` | Tests and synthetic inputs. |
| `tools/make_demo_data.py` | Deterministic demo generator. |

Run the test suites from the repository root:

```sh
npm test
python3 -m unittest discover -s tests/python
```

Regenerate `web/demo/agent-garden-demo.json` with:

```sh
python3 tools/make_demo_data.py
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for contribution steps.

## License and notices

Agent Garden uses the [MIT license](LICENSE). Bundled p5.brush has its own [license](web/vendor/p5-brush-2.2.2/LICENSE.md). Its [dependency notices](web/vendor/p5-brush-2.2.2/THIRD-PARTY-NOTICES.md) cover simplex-noise and spectral.js. The procedural film code has a separate [license notice](web/third-party/procedural-film-LICENSE.txt).
