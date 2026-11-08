# 0003. SQLite locally, PostgreSQL for teams, one schema through Kysely

## Status

Accepted (2026-11-08)

## Context

The plan requires one local file with no server, and a team backend with "the same schema" and row-level security on `workspace_id`.
The data is relational: sessions, events, signals, rubrics, grades, proposals, change events, jobs (overview, data model).
Volumes are modest: about 50 sessions per week per user, about 200 events per session, about 25 MB of redacted payloads per user per week.
Event payloads are retained for 90 days by default (decided retention, see Decision), so the local store levels off at about 0.3–0.5 GB plus a few MB per year of metadata, grades and signals.
Team mode targets 50 users and 2,500 sessions per day.
Several processes may touch the local store at once: the long-running server, and CLI commands such as `introspect import` or `introspect grade`.
Trend queries aggregate grades by week and rubric; at the stated volumes these are small aggregations (≤ 1 million grade rows).

Two decisions are bundled because they cannot be made independently: the engine pair and the data-access layer that must target it.

## Considered options

Engine:

1. SQLite (WAL mode) locally, PostgreSQL for teams.
2. PostgreSQL everywhere, using PGlite (Postgres compiled to WASM) locally.
3. libSQL/Turso in both modes.
4. DuckDB locally, PostgreSQL for teams.
5. A real PostgreSQL server required locally (for example via Docker).

Data-access layer and migrations:

1. Kysely query builder with Kysely's Migrator and dialect-neutral schema builder.
2. Drizzle ORM with drizzle-kit.
3. Prisma.
4. Raw SQL with the drivers.

## Decision table (engine)

| Option | Pros | Cons |
|---|---|---|
| SQLite local + Postgres team | Zero-install, single file, decades of durability record. Multiple processes can read and write safely (WAL, one writer at a time). Postgres for teams gives RLS, concurrent writers, managed hosting everywhere. | Two dialects to test. Small type differences (UUID, JSON, timestamps) must be handled in one place. |
| Postgres everywhere (PGlite) | One dialect; RLS testable locally. | PGlite is single-connection and in-process: the CLI cannot open the store while the server runs. Younger durability record than SQLite; WASM performance overhead. |
| libSQL / Turso | SQLite-compatible, embedded replicas. | No RLS; team mode tied to one vendor's server or service; smaller ecosystem than Postgres for managed hosting. |
| DuckDB + Postgres | Excellent analytical queries. | Built for analytics, not for many small transactional writes from watcher and jobs; two very different engines; analytical speed is not needed at these volumes. |
| Postgres server locally | One dialect, full features. | Breaks "no server, one file"; Docker on Windows/WSL is a heavy prerequisite. |

## Evaluation matrix (engine)

| Quality attribute | Weight | SQLite local + Postgres team | Postgres everywhere (PGlite local) | libSQL / Turso both modes | DuckDB local + Postgres team | Postgres server required locally |
|---|---:|---:|---:|---:|---:|---:|
| Portability / run-everywhere | 20% | 5 | 4 | 4 | 5 | 2 |
| Simplicity | 10% | 4 | 4 | 4 | 2 | 2 |
| Maintainability | 10% | 4 | 5 | 3 | 2 | 5 |
| Performance | 5% | 5 | 3 | 5 | 4 | 5 |
| Scalability (team mode) | 10% | 4 | 4 | 3 | 3 | 5 |
| Security / privacy | 10% | 5 | 4 | 3 | 4 | 4 |
| Operability | 10% | 4 | 3 | 3 | 3 | 2 |
| Testability | 10% | 3 | 5 | 4 | 2 | 5 |
| Robustness / durability | 10% | 5 | 3 | 4 | 4 | 5 |
| Distribution / install experience | 5% | 5 | 4 | 4 | 4 | 1 |
| **Weighted total (max 5.00)** | 100% | **4.40** | 3.95 | 3.65 | 3.40 | 3.50 |

Scores: 1 = poor, 3 = acceptable, 5 = excellent. Weighted total = sum(weight x score) / 100.

## Decision table (data-access layer)

| Option | Pros | Cons |
|---|---|---|
| Kysely | Type-safe SQL builder with first-class SQLite and Postgres dialects; the same query code runs on both. The Migrator and schema builder are dialect-neutral. No code generation step; types are a hand-written `Database` interface checked by a schema test. | Not an ORM: no entity tracking (not wanted). Migration helpers for type differences must be written once. |
| Drizzle | Good TypeScript ergonomics, fast. | Tables are declared per dialect (`sqliteTable` vs `pgTable`), so "one schema" becomes two schema files that can drift. |
| Prisma | Single schema file, mature migrations. | The datasource provider is fixed per schema, so two generated clients are needed; query engine adds weight to the npm package; less control over SQL for aggregations. |
| Raw SQL | Full control. | No type safety at boundaries; dialect differences scattered across the code. |

## Evaluation matrix (data-access layer)

| Quality attribute | Weight | Kysely (query builder + Migrator) | Drizzle ORM + drizzle-kit | Prisma | Raw SQL + drivers |
|---|---:|---:|---:|---:|---:|
| Maintainability | 30% | 4 | 4 | 3 | 2 |
| Testability | 20% | 5 | 4 | 3 | 3 |
| Dialect portability (SQLite + Postgres) | 25% | 5 | 2 | 3 | 2 |
| Simplicity | 15% | 4 | 4 | 3 | 3 |
| Performance | 10% | 5 | 5 | 3 | 5 |
| **Weighted total (max 5.00)** | 100% | **4.55** | 3.60 | 3.00 | 2.65 |

Scores: 1 = poor, 3 = acceptable, 5 = excellent. Weighted total = sum(weight x score) / 100.

## Decision

- Local mode stores data in one SQLite file through `better-sqlite3` 12, with `journal_mode=WAL`, `synchronous=NORMAL`, `foreign_keys=ON` and `busy_timeout=5000`.
- Team mode stores data in PostgreSQL 16 or later (18 recommended) through `pg` (node-postgres), with row-level security policies on `workspace_id`.
- All queries go through Kysely 0.28 or later; each module owns repository functions over its own tables (ADR-0009).
- Migrations are Kysely migrations written with the schema builder; one migration set runs on both dialects.
- One `columns.ts` helper maps logical types to physical ones:

| Logical type | SQLite | PostgreSQL |
|---|---|---|
| `id` (UUID) | `TEXT` (canonical lowercase) | `uuid` |
| `json` | `TEXT` (JSON, validated by zod on read) | `jsonb` |
| `timestamp` | `TEXT` ISO-8601 UTC with milliseconds | `timestamptz` |
| `bool` | `INTEGER` 0/1 | `boolean` |

- IDs: sessions use UUIDv5 derived from `(agent, native session id)` so that re-imports and team shipping de-duplicate; all other rows use UUIDv7 (time-ordered, index-friendly).
- Every table except pure join tables carries `workspace_id`; user-owned rows carry `user_id`. Local mode uses one fixed workspace and one fixed user.
- CI runs the full repository test suite against both SQLite and PostgreSQL (Testcontainers) from Phase 1, so the team seam cannot rot.
- Retention: a daily `purge_payloads` job sets `event.input` and `event.output` to NULL (and stamps `payload_purged_at`) for events older than 90 days (setting `retention.payload_days`, minimum 7).
  Event rows themselves (kind, name, error flag, duration), sessions, signals, grades, proposals and change events are kept forever.
  Sessions with `pinned = true` (any session in a calibration set or the reference set) are never purged.
  SQLite runs with `auto_vacuum = INCREMENTAL` and the job calls `PRAGMA incremental_vacuum` afterwards, so the file actually shrinks.
- `introspect backup <path>` uses SQLite's online backup API; team mode relies on the managed Postgres backups.

## Consequences

- Positive: the local store is a single file the user can copy, back up, or delete; it is reconstructible from the agent logs except for human decisions (labels, accept/reject), which `introspect backup` protects.
- Positive: switching to team mode is a connection-string change plus `introspect migrate`.
- Negative: every query must work on both dialects; dialect-specific SQL (for example week bucketing) lives in a small, tested `sqlDialect` helper.
- Negative: SQLite allows one writer at a time; the local worker serialises writes in short transactions (≤ 50 ms each) to keep the UI responsive.
- Negative: sessions older than 90 days (unless pinned) cannot be re-graded or used in dry-runs, because their payloads are gone; the UI shows "payload purged" on their timeline.
- Negative: full-text search is not used in v1 (Sessions search uses `LIKE` on title and repo).

## Revisit triggers

- A local store exceeds 2 GB despite retention, or the Sessions list p95 exceeds 200 ms at the user's volume: move payloads to compressed side files.
- Search needs grow beyond title/repo: add SQLite FTS5 and Postgres `tsvector` behind the same repository function.
- PGlite gains safe multi-process access and a durability track record: reconsider single-dialect.

## Related

- ADR-0004 (deployment), ADR-0005 (job table), ADR-0009 (module ownership of tables), overview "Data model".
