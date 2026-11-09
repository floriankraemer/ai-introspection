# 0004. One deployable with configurable roles; npm package locally, OCI image in the cloud

## Status

Partially superseded by ADR-0011 (local runtime)

## Context

The same codebase must run on a laptop and as a team server, switched by configuration.
Local mode has four kinds of work: HTTP API plus UI, a file watcher, background jobs (grading, linking outcomes), and schedules (nightly improver).
Team mode adds webhook intake (GitHub App) and needs to scale API and job throughput independently, for about 50 users and 2,500 sessions per day.
The plan proposes OS cron (launchd/systemd) for local triggers; that would mean two scheduler integrations (launchd, systemd) plus a WSL2 special case, where systemd is not always enabled.
Laptops sleep, so a fixed-time trigger often fires while the machine is off.

## Considered options

1. One process with roles enabled by configuration (`api`, `watcher`, `worker`, `scheduler`); npm package locally, OCI image in the cloud.
2. Split services (api, worker, scheduler, ingest) in both modes.
3. Desktop app (Electron or Tauri) locally plus a server for teams.
4. Local OS services and OS cron jobs that invoke CLI commands.

## Decision table

| Option | Pros | Cons |
|---|---|---|
| One process, roles by config | One artefact, one start command locally (`introspect serve`). The cloud runs the same image with different role flags, so scaling out is a deployment change, not a code change. Scheduling and catch-up logic is written once. | All roles share one Node event loop locally; CPU-heavy ingest must yield (chunked parsing). Role isolation in the cloud depends on configuration discipline. |
| Split services everywhere | Strong isolation, independent scaling. | Local install needs a process supervisor for 3–4 processes; much heavier for a single user; more failure modes. |
| Desktop app | Tray icon, auto-start, native feel. | A second packaging stack (Electron ~150 MB, or Tauri with Rust); code signing for macOS and Windows; does not help the cloud mode. |
| OS services + cron | Uses the OS's own scheduling. | Platform-specific implementations (launchd, systemd, WSL2 without systemd); missed runs while asleep need custom handling anyway; hard to test in CI. |

## Evaluation matrix

| Quality attribute | Weight | One process, roles by config; npm locally, OCI image in cloud | Split services (api, worker, scheduler) in both modes | Desktop app (Electron/Tauri) locally + server for teams | OS services + OS cron (launchd/systemd/Task Scheduler) |
|---|---:|---:|---:|---:|---:|
| Portability / run-everywhere | 20% | 5 | 3 | 4 | 2 |
| Simplicity | 20% | 5 | 2 | 2 | 3 |
| Operability | 15% | 4 | 3 | 3 | 3 |
| Scalability (team mode) | 10% | 4 | 5 | 3 | 3 |
| Robustness / durability | 10% | 4 | 4 | 4 | 4 |
| Security / privacy | 10% | 4 | 4 | 4 | 4 |
| Distribution / install experience | 15% | 4 | 2 | 4 | 3 |
| **Weighted total (max 5.00)** | 100% | **4.40** | 3.05 | 3.35 | 3.00 |

Scores: 1 = poor, 3 = acceptable, 5 = excellent. Weighted total = sum(weight x score) / 100.

## Decision

Ship one deployable: the `introspect` package, whose `introspect serve` command starts the roles listed in configuration.

Configuration (environment variables override a `config.toml` in the data directory):

| Key | Local default | Team (cloud) value |
|---|---|---|
| `mode` | `local` | `team` |
| `roles` | `api,watcher,worker,scheduler` | `api` on web replicas; `worker,scheduler` on worker replicas |
| `database_url` | `sqlite:<data_dir>/introspect.db` | `postgres://…` |
| `bind` | `127.0.0.1:7317` | `0.0.0.0:8080` behind TLS-terminating proxy |
| `auth` | `local-token` | `oidc` (ADR-0008) |

Data directory: `~/Library/Application Support/introspect` on macOS, `$XDG_DATA_HOME/introspect` (default `~/.local/share/introspect`) on Linux and WSL2.
Native Windows is not supported in v1; Windows users run Introspect inside WSL2.

Local:

- Install with `npm install -g <package>`, run `introspect serve`, open the printed URL (`introspect open`).
- Autostart is optional; `introspect service install` is not in v1 (see revisit triggers).
  Missed schedules are caught up when the process starts (ADR-0005).
- WSL: run Introspect inside WSL. Sources inside the WSL filesystem are watched with inotify; sources under `/mnt/c/...` use polling mode because inotify does not see Windows-side writes.
- Team mode, client side: the local install keeps running in `local` mode and additionally ships redacted sessions to the server ("Share my sessions with the workspace"), so the local UI keeps working offline.

Cloud:

- One OCI image (Node 24 slim base, non-root user, read-only root filesystem), published per release with an SBOM.
- Minimum topology: one container with all server roles plus managed PostgreSQL.
  Scale-out topology: N `api` replicas and M `worker` replicas; the `scheduler` role is safe on several replicas because firing is guarded by a Postgres advisory lock.
- The watcher role is disabled in the cloud; sessions arrive through `POST /v1/sessions`.
- The platform choice (Kubernetes, a container service, or a VM with Docker Compose) is decided at Phase 5 with `devops-expert`; the image stays host-agnostic and needs only `DATABASE_URL`, OIDC settings, an Anthropic credential, and GitHub App credentials.
- Data residency assumption: EU-only.
  Containers, PostgreSQL and its backups run in an EU region; no other component stores team data.
  Judge and improver calls send redacted traces to Anthropic; whether Anthropic's regional processing options or contractual safeguards meet the EU-only requirement is a Phase 5 check, together with the data-protection review.

## Consequences

- Positive: local install is one global npm package and one command; no Docker, no OS scheduler, no extra services.
- Positive: cloud and local exercise the same code paths except for storage dialect, auth and ingest entry point.
- Negative: if the laptop is off or Introspect is not running, the nightly improver runs late; the UI shows "last run" and "next run" so this is visible.
- Negative: the user must keep `introspect serve` running for watch-mode ingest; `introspect import` covers anything missed (cursors make it idempotent).

## Revisit triggers

- Users report forgetting to start Introspect (or ask for it): add `introspect service install` that writes a launchd agent, or a systemd user unit that only runs `introspect serve` at login.
- Worker CPU in team mode exceeds 70 % sustained at the target load: split ingest normalisation into its own role.

## Related

- ADR-0001 (runtime and distribution), ADR-0003 (persistence), ADR-0005 (jobs), ADR-0008 (auth modes), overview "Deployment views".
