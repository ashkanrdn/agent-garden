# Privacy and exports

The exporter reads local Codex and Claude Code history. It writes metadata and counts to `agent-garden.json` in the current directory by default. Use `--output` to choose another path. The exporter does not send data to a server.

The file can reveal project names, paths, session titles, Git branches, commit IDs, timing, file extensions, and current file sizes. A title can include a short excerpt from the first user prompt. The export also records source availability and parser gaps. It does not write full message bodies, full prompts, tool arguments, tool output, or file contents.

The hosted site reads a selected or dropped file with the browser File API. It parses and displays the data in memory. It does not upload the file, persist it in browser storage, or send it to an API. The static site has no upload endpoint. The included demo dataset is synthetic.

Use `python3 agent_garden_export.py --redact` when you plan to share an export. Redaction replaces project names with `project-N`, branch names with `branch-N`, and linked IDs with stable replacements. It removes titles, workspace paths, source paths, and optional descriptive agent fields. Changed-file path segments become stable hashes. File extensions and directory depth remain, so the file view still works. Commit IDs and parent references are hashed consistently. Counts, timestamps, sizes, project membership, and session lineage remain.

Redaction preserves some information that can still identify work, such as dates, activity patterns, file types, folder depth, and sizes. Review a redacted JSON file before sharing it. Keep an unredacted file on a device you trust. The exporter uses atomic replacement when it writes the output path.

Codex live history and an optional backup can overlap; the exporter reconciles duplicate evidence. Claude Code transcripts live under `~/.claude/projects` by default. Claude Code deletes transcripts older than 30 days by default through `cleanupPeriodDays`. Deleted sessions cannot be reconstructed by this exporter.

Git inspection reads local refs and available objects. It does not fetch remote history. The exporter cannot prove session ownership of commits. Bash writes are not counted as file changes. File byte sizes are current observations, not historical measurements. `--no-git` skips Git inspection and commit history, but still records workspace projects and current file sizes.
