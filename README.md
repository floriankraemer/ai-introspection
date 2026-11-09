# Introspect

Local-first tool that grades your coding-agent sessions and proposes fixes to your skills and rubrics.

## Quick start

```sh
git clone <repo-url> && cd ai-introspection
make up      # builds and starts Introspect; creates the mounted folders as your user
make open    # prints the sign-in link; open it in your browser
```

Optional: `cp .env.example .env` first to set your git identity (`GIT_AUTHOR_NAME`, `GIT_AUTHOR_EMAIL`), the skills repository (`INTROSPECT_SKILLS_REPO`, mounted read-write at `/repos/skills`) and the folder with your project repositories (`INTROSPECT_PROJECTS_DIR`, mounted at `/repos/projects`).
Skills repository: point `INTROSPECT_SKILLS_REPO` at your existing skills repository, or leave it unset.
The default `~/.introspect/skills` starts empty, and step 3 of the setup wizard can create a git repository there with the starter rubrics.
Never point it at `~/.claude`: that folder holds your Claude credentials and transcripts, and the mount is read-write.
If something does not work, `make doctor` checks the setup and prints one fix per problem (see ADR-0011).

## Grading

Introspect grades ended sessions against the rubrics in `rubrics/` of your skills repository: sessions the signals flagged, plus a 20 % sample (Settings: sampling `every` grades all).
Grading starts by itself shortly after a session ends; `introspect grade --since 7d` (or `--session <id>`, `--all`) grades on demand and ignores the sampling rule (add `--policy` to keep it).
Run it in the stack with `docker compose exec introspect introspect grade --since 7d`.

Two ways to run the judge (Settings, "Runs via"):

- **Anthropic API**: paste a key in Settings. It is stored in `<data>/secrets` (mode 0600), never in the database. Default model `claude-sonnet-5-5`.
- **Local claude CLI**: uses your subscription. Run `make claude-login` once: it signs the container's own `claude` in (open the URL it prints, paste the code back). That login lives in the container's private home at `/data/claude-home`, so its sessions are never read as agent logs. Your host login (`~/.claude`) is never mounted or copied: a second client of the same login can rotate its refresh token and sign you out. Without Docker, run `introspect judge-login`; `INTROSPECT_CLAUDE_CREDENTIALS` opts in to a one-time copy of a login file, which shares your refresh token. `make doctor` says when the judge has no login.

A daily token budget (default 1,000,000) and an optional monthly dollar ceiling are set in Settings; work over budget waits for the next midnight or month (`GET /v1/budget`). The windows follow the time zone in `TZ` (UTC when unset). A call is reserved on the ledger before it runs, so parallel grades cannot overspend; a call estimated above the whole limit fails with a reason instead of waiting.

Sessions stored while redaction was off, or with older redaction rules, are never sent to a judge. They show "redaction is off" or "not redacted with current rules — re-import pending"; turning redaction on rebuilds them from their log files.
A rubric counts as trusted once the judge agrees with at least 8 of your 10 hand labels (Rubrics screen); untrusted rubrics are graded but marked.

`INTROSPECT_JUDGE=fake` (environment only) swaps in a deterministic judge for tests and demos.

## Development

Everything runs in Docker; the host needs only Docker with Compose.

- `make dev` starts the server (7317) and Vite (5173) with live reload.
- `make test` runs the unit tests; `make test-pg` runs the Postgres tests.
- `make lint`, `make build`, `make shell`, `make down` do what they say.
- `make doctor` runs `introspect doctor` in the running stack; the same report is at `GET /v1/doctor`.

Architecture: [docs/architecture/architecture-overview.md](docs/architecture/architecture-overview.md).
