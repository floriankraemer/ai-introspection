# 0011. Docker Compose as the primary local runtime and development environment

## Status

Accepted (2026-11-09)

Partially supersedes ADR-0004 (local runtime and packaging).
The rest of ADR-0004 (one deployable, roles by configuration, cloud image) stays in force.

## Context

ADR-0004 chose the npm package as the local install and stated "no Docker locally".
Two requirements changed that:

1. Everything must run in Docker, and development must happen in Docker too.
2. Setup must be very short: a working dashboard within five minutes of `git clone`, using defaults only.

The same codebase must keep working on a laptop (macOS, Linux, WSL2) and as a team server.
ADR-0004 already ships one OCI image for the cloud, so a local Compose setup reuses the same image lineage.

Forces in tension:

- Files written into bind mounts (git worktrees, merges, `rubrics/` edits in later phases) must belong to the host user, not to root.
- inotify events are unreliable across WSL2 and Docker Desktop bind mounts, so the file watcher cannot depend on them.
- The Claude CLI transport (ADR-0006) needs the user's Claude login, which lives in `~/.claude`.
- Some users cannot or do not want to run Docker.

## Considered options

1. Docker Compose as the primary local runtime and development environment; the npm package stays supported.
2. npm package only, as in ADR-0004; Docker only in the cloud.
3. Docker only; drop the npm package.

## Decision table

| Option | Pros | Cons |
|---|---|---|
| Compose first, npm supported | `docker compose up` is the whole install. Dev, CI and production share one multi-stage Dockerfile (`dev`, `build`, `runtime`). The container is a hardening boundary (non-root, read-only root filesystem, dropped capabilities). The npm path still serves users without Docker. | Two supported run modes to test. Bind-mount ownership, polling and credential mounts need explicit handling. |
| npm only | One install path, no container layer, native file events on macOS and Linux. | Needs a matching Node version on the host. Dev, CI and runtime differ. No isolation of the process from the user's files. |
| Docker only | One run mode to support and test. | Excludes users without Docker, and anyone who prefers a plain process. Adds nothing for the cloud, which already uses the image. |

## Evaluation matrix

| Quality attribute | Weight | Compose first, npm supported | npm only | Docker only |
|---|---:|---:|---:|---:|
| Portability / run-everywhere | 20% | 5 | 4 | 5 |
| Simplicity | 20% | 4 | 5 | 3 |
| Operability | 15% | 4 | 4 | 4 |
| Security / privacy | 15% | 4 | 3 | 4 |
| Distribution / install experience | 15% | 5 | 3 | 4 |
| Dev, CI and production parity | 15% | 5 | 2 | 5 |
| **Weighted total (max 5.00)** | 100% | **4.50** | 3.60 | 4.15 |

Scores: 1 = poor, 3 = acceptable, 5 = excellent. Weighted total = sum(weight x score) / 100.

## Decision

Docker Compose is the primary way to run and to develop Introspect.
The npm package (ADR-0004) stays supported: same code, same `introspect serve`.
The manual documents Docker first.

Runtime (`compose.yaml`):

- One image `introspect` built from the `runtime` stage: `node:24-slim`, non-root, read-only root filesystem with a tmpfs `/tmp`, data directory `/data` on a named volume, all capabilities dropped, `no-new-privileges`.
- The port is published on `127.0.0.1:7317` only.
- Ownership: the container runs with `user: "${UID}:${GID}"`, the host user.
  Files in bind mounts are never owned by root.
  The Makefile exports the real `id -u` and `id -g`, so CI runners with other UIDs work too.
- File watching: chokidar polling is on by default in the container (`CHOKIDAR_USEPOLLING=1`), because inotify is unreliable on WSL2 and Docker Desktop bind mounts.
  The 60 s reconcile scan (ADR-0005) remains the safety net.
- Agent logs: `~/.claude/projects` and `~/.codex/sessions` are mounted read-only.
  Compose has no optional bind mounts, so a missing folder is created empty and startup does not fail.
  `make up` creates the folders as the host user first, because the Docker engine on Linux would create them owned by root.
- Credentials:
  - The API key comes from `.env` or the setup UI and is stored in the data volume with file mode 0600.
  - `gh` authentication uses a read-only mount of `~/.config/gh`, or `GH_TOKEN`.
  - The CLI transport (`claude -p`, ADR-0006) needs the `claude` binary and a Claude login.
    The image installs the `claude` CLI.
    The container does not mount or copy the host's login, and `make up` creates nothing in `~/.claude` besides the read-only log folders.
    `make claude-login` runs `introspect judge-login` in the container: `claude auth login` with HOME set to `/data/claude-home` (on the data volume).
    The container therefore holds its own login with its own refresh token, and it can never rotate or invalidate the user's.
    `introspect doctor` reports a missing judge login and says why the host login is not used.
    Users of the API-key transport need none of this.
- Skills repository and project repositories are mounted read-write (ADR-0010):
  - `${INTROSPECT_SKILLS_REPO:-${HOME}/.introspect/skills}` at `/repos/skills`; the setup wizard proposes this path (`GET /v1/skill-repos/detected`).
    The default is a dedicated folder and never `~/.claude`.
    A read-write mount of `~/.claude` would expose `.credentials.json`, hooks and transcripts for writing and would defeat the read-only log mounts.
    Users point `INTROSPECT_SKILLS_REPO` at their existing skills repository, or let Introspect create one:
    `detected` reports an empty folder as `{isGitRepo: false, hasRubrics: false, isEmpty: true}`, and `POST /v1/skill-repos/global/init {path}` runs `git init` (branch `main`), copies the starter rubrics and makes the first commit.
    Init is allowed only for an empty or missing folder below a mounted root (`/repos`, or `~/.introspect` for a host install), so it never touches existing files.
  - `${INTROSPECT_PROJECTS_DIR:-${HOME}/.introspect/projects}` at `/repos/projects`, for project repositories.
  - `make up` creates both folders as the host user, for the same reason as the log folders.
- Git identity: `GIT_AUTHOR_NAME`, `GIT_AUTHOR_EMAIL`, `GIT_COMMITTER_NAME` and `GIT_COMMITTER_EMAIL` pass from `.env` to the container in pass-through form, so an unset variable stays unset (git rejects an empty name).
  Without them, Introspect commits as "Introspect".
- Diagnosis: `introspect doctor` (`make doctor`, and `GET /v1/doctor` for the Settings panel) checks the data folder, database, source mounts, skills repository, git identity, `gh`, the judge credential and bind-mount ownership, and prints one fix line per problem.
  It exits 1 when a check fails; warnings do not change the exit code.

Development (`compose.dev.yaml`, `.devcontainer/`, `Makefile`):

- A `dev` service uses the `dev` stage with the source bind-mounted, `node_modules` and the pnpm store in named volumes, Vite on 5173 and the server on 7317.
- A `postgres:16` service with a health check supports the Postgres tests from day one.
- Every script runs as `docker compose -f compose.dev.yaml run --rm dev pnpm <script>`, wrapped by `make install lint test test-pg build dev shell`.
- The dev container reuses the same compose file.
- CI calls the same make targets.

## Consequences

- Positive: setup is `docker compose up` and one URL; dev, CI and production share one image lineage.
- Positive: the process has no access to the host except the declared mounts.
- Negative: two run modes (Docker and npm) both need coverage in CI before release.
- Negative: the CLI transport needs one extra interactive step (`make claude-login`) per data volume; in return the container never sees the user's Claude credentials.
- Negative: bind-mount polling costs some CPU; the interval is tuned when real data volumes are measured.
- Negative: on Linux, `docker compose up` without `make up` creates missing source folders as root.

## Revisit triggers

- Polling CPU use is noticeable on a typical week of sessions: tune the interval, or fall back to inotify where it works.
- The CLI transport gets a token-based login: drop the `~/.claude` mount.
- Compose gains optional bind mounts: remove the `mkdir` step from `make up`.

## Related

- ADR-0004 (superseded for local runtime), ADR-0005 (watcher, reconcile), ADR-0006 (CLI transport), ADR-0010 (repositories and worktrees), overview section 8.1.
