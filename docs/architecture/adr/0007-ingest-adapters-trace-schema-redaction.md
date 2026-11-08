# 0007. Per-agent ingest adapters into one normalized trace schema, with redaction before persistence

## Status

Accepted (2026-11-08)

## Context

Sources are agent log files: Claude Code session JSONL under `~/.claude/projects/**`, and Codex rollout JSONL under `~/.codex/sessions/**`.
Their formats are undocumented, versioned by the agents, and change without notice.
Traces contain secrets (tokens, keys, `.env` values) in tool inputs, tool outputs and file contents.
The plan requires redaction before anything is stored or sent to a judge, deterministic signals at ingest, and the ability to import history and to watch live sessions.
The Session detail screen needs events with kind, name, input, output, error flag and duration, plus a link to the raw log.
Team mode ships the same normalized, redacted traces to `POST /v1/sessions`.

## Considered options

1. Per-agent adapters that map into one normalized trace schema; redaction runs in the collector before any write.
2. Store raw JSONL verbatim and normalize on read.
3. Adopt the OpenTelemetry GenAI semantic conventions as the storage schema and convert logs to OTLP.
4. Use agent hooks (for example Claude Code hooks) to push events instead of parsing logs.

## Decision table

| Option | Pros | Cons |
|---|---|---|
| Adapters + normalized schema, redact before persist | One schema for UI, signals, judge and shipping. Secrets never reach the store, the judge, or the team server. Adapters are small, versioned and testable with fixture files. | Format changes require adapter updates; lossy mapping (kept mitigated by an `unknown` kind and a raw-log link). |
| Raw JSONL, normalize on read | Lossless; re-normalisation is free. | Secrets at rest in the store and in team shipping; every read pays parsing cost; UI and judge depend on raw formats. |
| OpenTelemetry GenAI conventions | Industry vocabulary; potential interop. | The conventions for agent spans are still evolving; logs still need conversion; span model fits poorly with the plan's flat event sequence. |
| Agent hooks | Real-time, no parsing. | Requires per-agent hook installation; no history import; not all agents offer equivalent hooks; misses events when Introspect is down. |

## Evaluation matrix

| Quality attribute | Weight | Adapters -> normalized schema, redact before persist | Store raw JSONL, normalize on read | OpenTelemetry GenAI conventions as storage schema | Agent hooks push events (no log parsing) |
|---|---:|---:|---:|---:|---:|
| Robustness / durability | 15% | 4 | 5 | 4 | 3 |
| Security / privacy | 25% | 5 | 1 | 4 | 4 |
| Maintainability | 20% | 4 | 3 | 3 | 3 |
| Portability / run-everywhere | 10% | 5 | 5 | 4 | 3 |
| Performance | 10% | 4 | 3 | 4 | 5 |
| Testability | 15% | 5 | 3 | 3 | 3 |
| Simplicity | 5% | 4 | 4 | 2 | 3 |
| **Weighted total (max 5.00)** | 100% | **4.50** | 3.05 | 3.55 | 3.45 |

Scores: 1 = poor, 3 = acceptable, 5 = excellent. Weighted total = sum(weight x score) / 100.

## Decision

Adapter contract (ingest module):

```ts
interface SourceAdapter {
  agent: 'claude-code' | 'codex';
  version: string;                       // adapter version, stored on session
  matches(path: string): boolean;
  parse(lines: AsyncIterable<string>, cursor: Cursor): AsyncIterable<SessionMeta | RawEvent>;
}
```

Normalized event kinds: `user`, `assistant`, `tool_call`, `file_op`, `mcp`, `skill`, `system`, `unknown`.
A `tool_call` row holds both the call and its result (`input`, `output`, `is_error`, `ms`), which refines the plan's separate `tool_call`/`tool_result` kinds; the Session detail timeline shows them as one line.
`skill` marks skill loads (the mockup's "Loaded e2e-testing/SKILL.md"), which signals and the improver use as evidence.
Unrecognised records become `unknown` events with the record type in `name`, and increase `session.ingest_warnings`; an adapter never aborts a file.

Pipeline per file chunk: read from byte cursor → adapter parse → redact → normalise → write events and advance cursor in one transaction.

Redaction (`redaction_version` stored on every session):

- Rules: the gitleaks default rule set (MIT licence), vendored and compiled at build time, with keyword pre-filtering; a generic `KEY=value` high-entropy rule (Shannon entropy ≥ 4.0 over ≥ 20 characters); full redaction of contents read from files matching `.env*`, `*.pem`, `id_*`; user-defined patterns from Settings.
- Replacement: `[REDACTED:<rule_id>:<hmac8>]`, where `hmac8` is the first 8 hex characters of an HMAC-SHA256 with a per-install key, so identical secrets correlate without being revealed.
- Fail closed: if redaction of a field throws or exceeds 200 ms, the field is replaced with `[REDACTION_FAILED]` and the session gets an ingest warning.
- Team server re-applies its own rules on `POST /v1/sessions` (defence in depth); it never receives unredacted data.
- Raising `redaction_version` enqueues re-ingest of affected sessions from their source files where they still exist.

Retention: redacted event payloads are purged after 90 days by default (configurable); pinned sessions (calibration or reference set) are never purged; everything else about a session is kept forever (ADR-0003).
The `ingest` module owns the purge job and exposes `pinSession(id)`, which `rubrics` calls when a calibration label is added and `grading` calls when a session joins the reference set.
Pins are never removed automatically.

Payload limits: each `input`/`output` field is stored up to 64 KiB, with `truncated = true` beyond; "Open raw JSONL" opens the local source file (local mode only).

Signals (computed at session end, `signal_version` stored): `failed_tool_calls`; `retries` (same tool and same normalised input within 5 events after an error); `repeated_commands` (identical shell command run 3 or more times); `files_touched`; `tests_run` (commands matching configurable test-runner patterns).
Flagging (defaults, configurable): flagged if `failed_tool_calls >= 3` or `repeated_commands >= 1` or `retries >= 2`.
Sampling: a non-flagged session is sampled if `hash(session_id) mod 100 < 20`, so the sample is stable across re-runs.

Session identity: `session.id = UUIDv5(namespace, agent + ":" + native_session_id)`; `title` is the first user message, trimmed to 80 characters.
`repo_root` is the git top-level directory of the session's working directory; `skill` events and reads of `CLAUDE.md`, `AGENTS.md` or `.claude/**` files record the real path of the instruction file, so the improver can resolve the target repository (ADR-0010).
In team mode the shipper sends the repository's remote URL instead of local paths.
Outcome linking: after session end, a `link_outcome` job matches `repo` + `branch` to a commit or PR through `gh` (local) or the GitHub App (team) and sets `outcome_kind` and `outcome_ref`.

## Consequences

- Positive: the store, judge, team server and UI only ever see redacted data; this is testable with a seeded-secret corpus.
- Positive: adding an agent means adding one adapter and its fixtures.
- Negative: adapters lag behind agent format changes; mitigation is fixture files per observed agent version, `unknown` events, and an ingest-warnings counter visible in Settings.
- Negative: redaction can over-redact (false positives) and make some traces harder to read; the rule ID in the placeholder makes this diagnosable.

## Revisit triggers

- Ingest warnings exceed 1 % of events for an agent after an agent release: update the adapter (expected maintenance, not a design change).
- OpenTelemetry GenAI agent conventions become stable and an agent emits them natively: add an OTLP adapter as another source.
- A secret is found in the store or in a judge request: treat as an incident; add the pattern to the corpus.

## Related

- ADR-0005 (watcher and cursors), ADR-0006 (judge input), ADR-0008 (shipping endpoint), overview "Data model".
