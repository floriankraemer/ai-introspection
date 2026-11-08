# 0005. Durable job table in the application database, executed by in-process worker and scheduler roles

## Status

Accepted (2026-11-08)

## Context

Background work in the plan:

- Ingest watcher: tail growing JSONL files, detect session end, compute signals.
- Grading: grade a session when it ends or when its PR merges, for flagged sessions plus a 20 % sample, within the configured budget (tokens per day and/or a monthly dollar ceiling).
- Outcome linking: match repo and branch to a commit or merged PR via `gh` (local) or the GitHub App (team).
- Nightly improver at 06:00 (or weekly, or manual).
- Re-grading the 20-session reference set after a judge or rubric change.
- Team mode: shipping sessions to the server.

Requirements: no work lost when the process is killed or the laptop sleeps; no duplicate grades or proposals after a retry; the same mechanism must work on SQLite (one process) and Postgres (several replicas); LLM jobs must stop when the budget is exhausted.

## Considered options

1. A durable job table in the application database, executed by in-process `worker` and `scheduler` roles, plus a file watcher with periodic reconciliation.
2. OS cron or timers that invoke CLI commands.
3. Redis with BullMQ.
4. A Postgres-native queue library (pg-boss or graphile-worker).
5. An in-memory queue (for example `p-queue`).

## Decision table

| Option | Pros | Cons |
|---|---|---|
| Job table in app DB | Works identically on SQLite and Postgres; job enqueue commits in the same transaction as the state change that caused it (no lost or phantom jobs). No extra infrastructure. Jobs are visible and inspectable with SQL and in the UI. | We own about 300 lines of queue code (claim, lease, retry, backoff); throughput is bounded by the database (far above our needs). |
| OS cron / timers | No long-running scheduler. | Platform-specific; no retries or leases; no transactional enqueue. |
| Redis + BullMQ | Proven, high throughput. | Extra service locally (breaks "no server"); enqueue not atomic with DB writes. |
| pg-boss / graphile-worker | Proven on Postgres, `SKIP LOCKED`. | Postgres only, so local mode would need a second implementation. |
| In-memory queue | Simplest. | Work lost on crash or restart; cannot coordinate several replicas. |

## Evaluation matrix

| Quality attribute | Weight | Durable job table in app DB + in-process worker/scheduler | OS cron / timers invoking the CLI | Redis + BullMQ | Postgres-native queue (pg-boss / graphile-worker) | In-memory queue (non-durable) |
|---|---:|---:|---:|---:|---:|---:|
| Portability / run-everywhere | 20% | 5 | 2 | 3 | 3 | 5 |
| Simplicity | 15% | 4 | 3 | 2 | 3 | 5 |
| Robustness / durability | 20% | 4 | 3 | 5 | 5 | 1 |
| Scalability (team mode) | 10% | 4 | 2 | 5 | 5 | 1 |
| Operability | 15% | 4 | 2 | 3 | 4 | 3 |
| Testability | 15% | 5 | 3 | 4 | 4 | 4 |
| Distribution / install experience | 5% | 5 | 2 | 2 | 3 | 5 |
| **Weighted total (max 5.00)** | 100% | **4.40** | 2.50 | 3.55 | 3.90 | 3.35 |

Scores: 1 = poor, 3 = acceptable, 5 = excellent. Weighted total = sum(weight x score) / 100.

## Decision

Jobs:

- Table `job(id, workspace_id, kind, payload, idempotency_key UNIQUE, status, priority, attempts, max_attempts, run_after, lease_until, locked_by, last_error, created_at, finished_at)`.
- Status values: `queued`, `running`, `succeeded`, `failed` (will retry), `dead` (gave up), `deferred` (waiting for budget).
- Claim: Postgres uses `SELECT … FOR UPDATE SKIP LOCKED`; SQLite uses one `UPDATE … RETURNING` in an immediate transaction (one worker process locally).
- Lease 5 minutes, heartbeat every 60 seconds; an expired lease returns the job to `queued`.
- Retry with exponential backoff `30 s × 2^attempt`, up to 5 attempts, then `dead`; dead jobs show in Settings with the last error and a "retry" action.
- Idempotency keys make retries and duplicate triggers harmless, for example `grade:<session_id>:<rubric_version>:<judge_model>` and `improve:<workspace_id>:<date>`.
- Concurrency per kind (local defaults): ingest 1, grade 2, improve 1, link-outcome 2. Team defaults are configurable per replica.
- Producers enqueue in the same database transaction as the state change (for example "session ended" and "enqueue grade" commit together). This is the in-process event mechanism between modules (ADR-0009).

Budget:

- The budget mode is user-selectable in Settings: (a) tokens per day, (b) tokens per day plus a monthly dollar ceiling, or (c) monthly dollar ceiling only. Default: (a) with 1,000,000 tokens per day and no dollar ceiling.
- Before an LLM job runs, the worker sums usage from the `llm_call` ledger: tokens since local midnight, and estimated dollars since the first day of the current month.
- If the next call would exceed the token limit, the job becomes `deferred` with `run_after` = next local midnight; if it would exceed the dollar ceiling, `run_after` = first day of next month, 00:00 local.
- The UI shows the deferred count, today's tokens and this month's estimated spend against the active limits.

Scheduler:

- Schedules are stored in settings (improver: daily 06:00, weekly Monday 06:00, or manual). The `scheduler` role evaluates them every 60 seconds with `croner` and enqueues a job with an idempotency key per period.
- Catch-up: on start, if the latest due period has no job, enqueue exactly one (no backfill of several missed nights).
- In Postgres, firing is guarded by `pg_try_advisory_lock` so several scheduler replicas are safe.

Watcher:

- `chokidar` watches source folders (inotify on Linux and WSL2, FSEvents on macOS); polling mode for network and `/mnt/c` paths.
- File events never carry state. They only enqueue an `ingest_file` job keyed by path. The job reads from the stored byte cursor to the end of file.
- A reconcile scan every 60 seconds compares size and mtime of all source files with the cursors, which catches missed events after sleep.
- A session is "ended" after 10 minutes without new bytes (configurable), or when the agent's log contains an explicit end record.

UI freshness: the UI polls (TanStack Query, 5 s on the Sessions list while jobs are running, otherwise 30 s). No WebSocket or SSE in v1.

## Consequences

- Positive: `kill -9` at any point loses no work; a restart resumes from cursors and leases.
- Positive: one mechanism for local and team; the team server scales by adding worker replicas.
- Negative: queue code is ours to maintain and test; it gets a dedicated test suite against both dialects, including lease expiry and duplicate-enqueue cases.
- Negative: polling adds up to 5 s latency to UI updates; acceptable for this tool.

## Revisit triggers

- Team job throughput exceeds 50 jobs per second sustained, or queue table bloat measurably slows Postgres: move to pg-boss on the team side behind the same `JobQueue` interface.
- Users ask for live progress during long imports: add SSE for job progress only.

## Related

- ADR-0003 (database), ADR-0004 (roles), ADR-0006 (LLM calls and budget ledger), ADR-0007 (ingest), ADR-0009 (modules communicate through jobs).
