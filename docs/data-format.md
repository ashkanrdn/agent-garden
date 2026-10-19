# Export data format

`agent_garden_export.py` writes one UTF-8 JSON object. These fields come from the exporter code. Fields can be `null` when source evidence is absent.

## Top level

| Field | Meaning |
| --- | --- |
| `schemaVersion` | Integer `1`. |
| `generator` | Exporter name and release version. |
| `redacted` | Boolean; true only after `--redact`. |
| `generatedAt` | UTC time when dataset assembly finished. |
| `sourceCutoffAt` | UTC cutoff used while reading histories. |
| `sources` | Source records, including missing sources. |
| `coverage` | Counts and limits of available evidence. |
| `timeRange` | `start`: earliest session creation; `end`: dataset generation time. |
| `projects` | Project Plot records. |
| `sessions` | Primary and delegated session records. |
| `commits` | Locally reachable Git commit records. Empty with `--no-git`. |
| `workScore` | Formula version, weights, descendant rule, and meaning. |

In this release, `generator` is `{ "name": "agent-garden-export", "version": "0.1.0" }`. `coverage` includes session, tool, turn, file-event, parser-error, and missing-evidence counts. Its `git` object records Git inspection and current byte observations.

`workScore.version` is `1`. Its formula is `log1p(toolCount + 2*turnCount + 3*distinctFiles + 4*agentCount + 5*ownedCommits)`. Descendant work counts once in the root session at its event time. This score measures recorded activity, not quality or productivity.

## Source records

Each source has `id`, `kind`, `path`, `exists`, `status`, `scope`, `sessions`, `rollouts`, `databaseSessions`, `databaseStatus`, `records`, and `errors`. Parser counters such as `malformedRecords`, `rolloutSessions`, and `unresolvedSpawnLinks` appear when applicable. The kinds are `codex-live`, `codex-backup`, and `claude-code`. Redaction removes `path`.

## Project records

`id` links a project to sessions and commits. `name` is its display name. `root`, `workspaces`, and `gitCommonDir` describe recorded or current locations. `identityBasis`, `gitAvailable`, `gitUnavailableReason`, `git`, and `gitCoverage` explain grouping and Git access. `sessionIds` lists related sessions. Some location and reason fields depend on available evidence. Redaction removes location fields and replaces `name` with `project-N`.

## Session records

| Field group | Fields |
| --- | --- |
| Identity | `id`, `agent` (`codex` or `claude-code`), `projectId`, `sourceIds` |
| Display and location | `title`, `titleSource`, `cwd`, `gitContext` (`branch`, `sha` when known) |
| Time and evidence | `createdAt`, `updatedAt`, `rolloutCount`, `activity`, `files`, `commits`, `coverage` |
| Delegation | `isSubagent`, `isGuardian`, `parentId`, `rootSessionId`, `forkedFromId`, `agentIds`, `agentPath` |
| Optional agent metadata | `nickname`, `role`, `model`, `reasoningEffort`, `tokensUsed` |

An `activity` item has `at`, `kind` (`tool` or `turn`), and `count`. Events are grouped by hour and stamped with the last event time in that hour. A `files` item has `path`, `absolutePath`, `bytes`, `bytesSource`, `bytesObservedAt`, and `events`. When size is unavailable, it can have `bytesMissingReason`. A file event has `at`, `kind` (`add`, `update`, `delete`, or `rename`), and `previousPath` for a rename. Redaction removes titles, location and agent-description fields, and absolute paths. It replaces file path segments with stable hashes while keeping extensions.

## Commit records

Each commit has `id`, `projectId`, `sha`, `parentShas`, `parents`, `at`, `authoredAt`, `sessionId`, `ownerSessionId`, `ownership`, `branches`, `branchLabelBasis`, `branchLabelsObservedAt`, and `evidence`. Commit ownership is `unknown`; the session IDs are currently null. Branch labels describe current ref tips, not complete historical branch membership. `--redact` hashes SHA values and replaces branch labels.

## Version policy

The exporter writes `schemaVersion: 1`. The `generator.version` identifies the exporter release; it is not the schema version. New optional fields can be added within version 1. Readers should ignore unknown fields and handle missing optional fields. A future incompatible change must use a new `schemaVersion` and an explicit reader update. The existing `workScore.version` changes only if its formula contract changes.
