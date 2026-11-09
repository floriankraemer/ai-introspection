# 0006. LLM judge and improver behind narrow domain ports, with API and Claude CLI transports

## Status

Accepted (2026-11-08)

## Context

Two LLM workloads exist, with different shapes:

- Judge: for one session and one rubric, return a score from the rubric's scale, a one-paragraph reason, and evidence event IDs. Input is a redacted, condensed trace (up to about 50,000 tokens) plus a rubric body. No tools are needed. Volume: about 30 graded sessions per user per week, 4 rubrics each.
- Improver: once per night, cluster the last 24 hours of failing grades, then for the top clusters edit files in the skills repository (skills, `CLAUDE.md`, settings) and explain why. This needs file read and edit tools inside a repository checkout.

The Settings mockup offers "Runs via: Local claude CLI (headless) | Anthropic API key", so both transports are a requirement, not an option.
The plan requires `judge_model` on every grade (drift tracking), a fixed judge prompt where only the rubric body changes, and a daily token budget.
Current models (Anthropic model list, cached 2026-10-06): Claude Opus 5.5 `claude-opus-5-5` ($4 / $20 per million input/output tokens), Claude Sonnet 5.5 `claude-sonnet-5-5` ($2 / $10), Claude Haiku 5.5 `claude-haiku-5-5` ($0.10 / $0.50).

The architectural question is where the abstraction boundary sits.

## Considered options

1. Narrow domain ports (`Judge.grade`, `Improver.propose`) owned by the grading and improvement modules, with one adapter per transport.
2. Direct SDK calls inside the grading and improvement modules.
3. A generic, provider-neutral LLM gateway port (chat-completion style, for example via a multi-provider SDK).
4. The Claude Agent SDK for everything, including the judge.

## Decision table

| Option | Pros | Cons |
|---|---|---|
| Narrow domain ports + transport adapters | Ports speak the domain (`GradeRequest` → `GradeResult`), so each adapter can use its transport's best features: structured outputs and prompt caching on the API; the Agent SDK's file tools for the improver; `claude -p` for subscription users. Deterministic fake adapters make grading and improvement fully testable offline. Redaction and budget checks sit at one choke point. | Two adapters per port to maintain; the CLI adapter depends on CLI output format stability. |
| Direct SDK calls | Least code. | Cannot satisfy the "Runs via" switch without branching inside domain code; hard to test; budget and redaction checks scattered. |
| Generic LLM gateway | Provider portability. | Lowest common denominator: loses structured outputs, prompt caching control, and Agent SDK tools; adds a dependency; no requirement for other providers. |
| Agent SDK for everything | One integration. | The judge needs no tools; an agent loop adds latency, cost and nondeterminism; a judge with file tools could read unredacted files from disk. |

## Evaluation matrix

| Quality attribute | Weight | Narrow domain ports (Judge, Improver) + transport adapters | Direct SDK calls inside modules | Generic provider-neutral LLM gateway | Agent SDK for everything (judge too) |
|---|---:|---:|---:|---:|---:|
| Simplicity | 15% | 4 | 5 | 2 | 4 |
| Maintainability | 20% | 5 | 2 | 3 | 4 |
| Testability | 15% | 5 | 2 | 4 | 3 |
| Robustness / durability | 15% | 4 | 4 | 3 | 3 |
| Security / privacy | 10% | 5 | 3 | 4 | 3 |
| Requirement fit (Settings: both 'Runs via' options) | 15% | 5 | 2 | 3 | 3 |
| Portability / run-everywhere | 10% | 5 | 4 | 5 | 4 |
| **Weighted total (max 5.00)** | 100% | **4.70** | 3.05 | 3.30 | 3.45 |

Scores: 1 = poor, 3 = acceptable, 5 = excellent. Weighted total = sum(weight x score) / 100.

## Decision

Ports (TypeScript interfaces in the owning modules):

- `Judge.grade(req: GradeRequest): Promise<GradeResult>` in the grading module. `GradeRequest` holds the rubric (name, version, scale, body) and a `RedactedTrace`. `GradeResult` holds `score`, `reason`, `evidenceEventIds`, `modelUsed`, and token usage.
- `Improver.cluster(failures)` and `Improver.propose(cluster, worktreePath)` in the improvement module.
- Inputs are branded types (`RedactedTrace`, `RedactedText`) that only the ingest module's read API can construct, so unredacted data cannot reach an adapter by construction.

Adapters:

| Port | `anthropic-api` transport | `claude-cli` transport |
|---|---|---|
| Judge | `@anthropic-ai/sdk` Messages API with structured outputs (`output_config.format` JSON schema), adaptive thinking, prompt caching | `claude -p` with JSON output, tools disabled, response validated with the same zod schema |
| Improver | `@anthropic-ai/claude-agent-sdk` `query()` with `cwd` = a git worktree, tools limited to read, search and edit inside it, no shell, no network | `claude -p` in the worktree with the same tool restrictions |

The exact CLI flags are pinned in the adapter and covered by a contract test that runs against the installed `claude` version; the adapter refuses CLI versions outside the tested range.

Transport selection: one setting, `llm.transport` = `anthropic-api` (default) or `claude-cli`, applies to judge and improver and is user-selectable in Settings ("Runs via").
The API transport reads the key from `ANTHROPIC_API_KEY` or the Anthropic credential profile; the key is never stored in the database.
The CLI transport uses the user's logged-in `claude` installation (subscription); it is available in local mode only, and the team server always uses the API transport.

Judge call design:

- One request per (session, rubric). The fixed judge instructions, the condensed trace and the outcome diff form a cached prefix; the rubric body comes after the cache breakpoint. Four rubrics therefore pay the trace once at cache-write price and three times at cache-read price.
- Trace condensation: one line per event with its ID (`[e123] 13:02 bash ✕ curl localhost:3000/health → connection refused`); tool outputs truncated to the first 2,000 and last 1,000 characters; total input capped at 50,000 tokens by dropping middle successful events first, never error events or the final assistant message.
- The schema restricts `score` to the rubric's scale values. `passed` is computed by the application as `score >= pass_threshold`, never by the model.
- Evidence IDs not present in the trace are dropped and logged; a result with zero valid evidence IDs for a failing score is marked `invalid` and retried once.
- `stop_reason: "refusal"` produces a grade with `status = refused`, which is excluded from pass rates. On API transport, server-side refusal fallback is enabled, and `judge_model` records the model that actually answered.

Defaults (all configurable in Settings):

| Role | Default model | Effort | Rationale |
|---|---|---|---|
| Judge | `claude-sonnet-5-5` | `medium` | Classification-like task with a short output; cost about half of Opus. The calibration gate (8/10 per rubric) is the acceptance test; if Sonnet fails it for a rubric, switch that rubric's judge to `claude-opus-5-5`. |
| Improver (cluster + propose) | `claude-opus-5-5` | `high` | Runs once a night, edits instructions that shape every future session; quality matters more than cost. |
| Haiku 5.5 | not used in v1 | — | Candidate for cheaper judging only if calibration on Haiku reaches 8/10. |

Cost estimate (API transport, to be verified in Phase 2): about $0.22 per graded session (50k-token prefix written once, read 3 times, about 1,500 output tokens per rubric), so about $7 per user per week at 30 graded sessions.

Every LLM call writes one `llm_call` ledger row (purpose, transport, model, input, cache-read and output tokens, cost estimate, reference ID).
The budget limits (ADR-0005) are sums over this ledger.
For the CLI transport the dollar figure is an estimate at API list prices, so a monthly dollar ceiling stays meaningful even on a subscription.

Self-ingest guard: judge and improver CLI or Agent SDK runs start with `cwd` under `<data_dir>/runs/`, and the ingest module ignores sessions whose working directory is under the data directory, so Introspect never grades its own LLM calls.

## Consequences

- Positive: both "Runs via" choices work with the same grading and improvement logic; switching is a setting.
- Positive: grading and improvement tests use a fake judge and a fake improver; only a small contract suite calls real models (opt-in in CI with a secret).
- Positive: model choice per role is data, and every grade records the model and transport that produced it.
- Negative: the CLI transport cannot use prompt caching or structured outputs as directly, so it is slower and validated after the fact.
- Negative: CLI and Agent SDK behaviour can change with their releases; pinned version ranges and contract tests are the mitigation.

## Revisit triggers

- Judge cost per user exceeds $15 per week at default sampling: test `claude-haiku-5-5` on the calibration sets, and Message Batches (50 % price) for non-urgent grading.
- Judge agreement drops below 8/10 on a re-run of the reference set after a model update.
- The CLI transport breaks twice in a quarter due to CLI changes.

## Related

- ADR-0005 (budget, jobs), ADR-0007 (redaction), ADR-0010 (worktrees and proposals), overview "Runtime flows".

## Implementation notes (Phase 2, WP5)

- The transport setting is `judge.transport` (`api` or `cli`), as shipped in Phase 1.
- CLI transport: `claude -p --output-format json --no-session-persistence --tools "" --setting-sources "" --system-prompt <judge prompt> --json-schema <verdict schema>`, prompt on stdin, in a private HOME (`INTROSPECT_CLAUDE_HOME`, default `<data>/claude-home`).
  Measured on the host: with the real home a trivial request cost 214,000 cache-write tokens (user memory, skills, MCP); with the private home it costs about 850.
  The adapter refuses to run when the private home overlaps a registered agent-log source, and `introspect doctor` reports the same.
  The adapter accepts CLI major version 2 only.
- The CLI judge has its own Claude login, made inside the private home with `claude auth login` (`introspect judge-login`, `make claude-login` in Docker).
  The host's `~/.claude/.credentials.json` is never mounted or copied by default.
  Reason: an OAuth login holds a rotating refresh token.
  A second client that refreshes it can invalidate the copy the user's own `claude` holds, and the user is signed out.
  The container's login is a separate grant with its own refresh token, so neither side can invalidate the other.
  A native run may opt in to a one-time copy of a login file (`INTROSPECT_CLAUDE_CREDENTIALS`, copied only when the private home has no login); the copy shares the refresh token, and the docs say so.
  `claude setup-token` (a long-lived token passed by environment) was not chosen: the token would have to live in `.env` or in the process environment, and the CLI does not store it.
- Token budget counts fresh input, cache writes and output tokens; cache reads are excluded (they cost about a tenth).
  Pre-call estimates use 3 characters per token, which errs high.
- Evidence labels in the prompt are `e<seq>` (the stable event sequence number), mapped to event ids after the call.
- Re-ingest on an adapter or redaction version change keeps an event's id when the same source record yields it again.
  Each event stores `source_key`: a hash of its source line plus its index within the line, so the key survives shifts of position.
  Equal keys (a repeated line) pair in order.
  Rows stored before migration 0005 pair by position only when kind and time also agree.
  Events without a match get new ids.
  A grade whose evidence ids no longer all resolve is marked `stale`: it stays visible, has no verdict in session lists, is left out of pass rates, and the sweep queues it again.
  A rebuild never restores a payload that retention purged.
  The rebuilt event set is held in memory while the file is parsed and swapped in with one short transaction (the old design kept one transaction open for the whole parse, which blocks the only SQLite connection).
  The 60 s reconcile scan (ADR-0005) remains the safety net.

## Implementation notes (Phase 2 review fixes)

- Redaction guard: a session whose `redaction_version` is `off` or differs from the current version is never sent to a judge.
  `ingest.sessions.traceFor` throws `UnredactedSessionError`, so the sweep, batches, `introspect grade`, the re-grade API and dry runs all pass the same check.
  The reason is "redaction is off" or "not redacted with current rules — re-import pending"; it shows as `notGradedReason`, and a dry run lists the session under `skipped`.
  `introspect doctor` warns while redaction is off.
- Every response that was paid for reaches the ledger.
  Judges throw `JudgeCallError` (usage and answering model attached) for a response that is not a verdict.
  An unusable answer (cut off, not JSON, off schema) counts as one of the grader's own two attempts; after the second the grade is stored as `invalid`, and the job queue never retries a paid call.
  An error that is not an unusable answer (the CLI reports `is_error`) is recorded and then raised.
  A call with no response at all leaves no row.
- Prompt layout: the rubric is in the system prompt, before the trace.
  The trace sits alone in the user message between `<trace-TOKEN>` tags, where TOKEN is 96 random bits chosen per request and stated in the system prompt.
  Text in the trace that matches the token, `<trace` or `<rubric` is neutralised (`<` becomes `&lt;`).
  Every score needs evidence labels, passing ones too, unless the session has fewer than 3 events.
  Because the token changes per request, no part of the user message is cacheable; the earlier cache breakpoint after the trace is gone, and the rubrics of one session each pay for the trace.
  This trades cost for isolation; Message Batches (see the revisit triggers) is the lever for cost.
- Budget: `reserve` checks the limits and inserts a ledger row with the estimate (`status = 'reserved'`) in one transaction, with a row lock on the workspace so parallel grades on Postgres serialise; SQLite has one writer.
  `settle` replaces the estimate with the real usage (`ok` or `error`), `release` drops a reservation whose call got no response.
  Every attempt reserves again.
  An estimate larger than the whole limit fails the grade with the reason (HTTP 422 for a dry run) instead of deferring it for ever.
  A reservation older than 30 minutes (a crashed process) stops counting.
  The overspend is at most one call's gap between estimate and actual usage.
- Budget windows (day and month) follow the time zone in env `TZ`, UTC when unset.
- `grade.judge_model` is the model asked for and keys the uniqueness and skip checks; `grade.answered_model` is the model that answered (a fallback may differ).
  The ledger records the answering model, which is what is billed.
- `grade_batch` goes on after a failing session: the error is added to the job progress (`failed`, `errors`) and the batch continues.
  A budget deferral still pauses the whole batch.
- The grade sweep runs every 5 minutes, and rubric files are read from git at most every 5 minutes (a UI edit refreshes the cache at once).
- The condenser's last resort cuts the middle of the text, never the end, so the final assistant message stays.
  Only labels that appear in the text that is sent resolve to event ids.
