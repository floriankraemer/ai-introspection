# Architecture Decision Records

Decisions for Introspect (CLI `introspect`), the agent self-improvement loop.
Requirements source: [build plan](../../product/build-plan.md); system view: [architecture overview](../architecture-overview.md).

Format: MADR-style, one decision per file (two tightly coupled sub-decisions are bundled where they cannot be made separately, and each gets its own matrix).
Every ADR has context, considered options, a decision table with pros and cons, a weighted evaluation matrix against quality attributes, the decision, consequences, and revisit triggers.

Scoring convention: 1 = poor, 3 = acceptable, 5 = excellent; weights sum to 100 %; weighted total = sum(weight × score) / 100, maximum 5.00.
Development cost is deliberately not a criterion (project principle: weigh quality, simplicity, robustness, scalability and maintainability over development cost).

Status lifecycle: Proposed → Accepted → Deprecated or Superseded by ADR-NNNN.
Accepted ADRs are not edited; a change of mind is a new ADR that supersedes the old one.
ADR-0001 to ADR-0010 were revised with the user's answers to the open questions and then accepted on 2026-11-08 (see the overview, section 13 "Resolved decisions"); no answer changed a chosen option, so no evaluation matrix was re-scored.

| ADR | Title | Status | Chosen option |
|---|---|---|---|
| [0001](0001-runtime-and-backend-framework.md) | Runtime and backend framework | Accepted 2026-11-08 | TypeScript on Node.js 24 LTS, Hono 4; npm package locally; macOS, Linux, WSL2 |
| [0002](0002-frontend-approach.md) | Frontend approach | Accepted 2026-11-08 | React 19 SPA (Vite), served as static assets by the backend |
| [0003](0003-persistence-and-data-access.md) | Persistence and data access | Accepted 2026-11-08 | SQLite (WAL) locally, PostgreSQL for teams, one schema through Kysely; 90-day payload retention |
| [0004](0004-deployment-topology-and-packaging.md) | Deployment topology and packaging | Partially superseded by ADR-0011 (local runtime) | One deployable with roles by config; npm locally, OCI image in the cloud |
| [0005](0005-background-job-execution.md) | Background job execution | Accepted 2026-11-08 | Durable job table in the app DB; in-process worker, scheduler and watcher; token/day and/or monthly dollar budget |
| [0006](0006-llm-judge-and-improver-integration.md) | LLM judge and improver integration | Accepted 2026-11-08 | Narrow domain ports with `anthropic-api` (default) and `claude-cli` adapters, user-selectable; judge Sonnet 5.5, improver Opus 5.5 |
| [0007](0007-ingest-adapters-trace-schema-redaction.md) | Ingest adapters, trace schema, redaction | Accepted 2026-11-08 | Per-agent adapters into one normalized schema; redact before persistence |
| [0008](0008-api-contract-and-authentication.md) | API contract and authentication | Accepted 2026-11-08 | REST/JSON `/v1` with OpenAPI 3.1 from zod; loopback token locally, OIDC for teams |
| [0009](0009-module-decomposition.md) | Module decomposition | Accepted 2026-11-08 | Modular monolith: ingest, rubrics, grading, improvement, trends, settings |
| [0010](0010-git-integration-rubrics-and-proposals.md) | Git integration for rubrics and proposals (global and project repos) | Accepted 2026-11-08 | git CLI with worktrees; targets global skills repo or the session's project `.claude/`; accept by local merge (default) or PR |
| [0011](0011-docker-runtime-and-dev-environment.md) | Docker Compose as the primary local runtime and development environment | Accepted 2026-11-09 | Compose first (non-root, read-only image, host UID, polling watcher, read-only log mounts); npm package still supported |
| [0012](0012-session-intake-and-s3-sources.md) | Session intake from other people, and S3 sources | Accepted 2026-11-10 | Separate intake port with per-person tokens; raw and client-redacted pushes (amends ADR-0007/0008 for raw mode); S3 as a cached folder source |
