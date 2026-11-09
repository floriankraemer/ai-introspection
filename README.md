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

## Improving

The improver turns failing grades into proposals: small changes to your instruction files, each on its own git branch.
It runs every day at 06:00 (Settings: `schedule.improver` = daily, weekly or manual; a night missed while the machine slept runs once at the next start).
`introspect improve --now [--since 24h]` runs it in the foreground; without `--now` it queues a job for the running server.
Run it in the stack with `docker compose exec introspect introspect improve --now`.

- It looks only at failing grades of **trusted** rubrics (see above).
  Failures of untrusted rubrics are left out and listed in the run summary (`GET /v1/improver/runs`).
- Failures are clustered by target repository and rubric, then by word overlap of the judge's reasons.
  The clustering is deliberately simple: a cause that the judge describes in different words ends up in separate clusters.
  The top three clusters of a run get a proposal.
- Each cluster targets one repository: a **project repository** the session ran in (only `.claude/skills/**`, `.claude/commands/**`, `.claude/agents/**`, `CLAUDE.md` and `AGENTS.md`), if you registered it under the projects mount (`POST /v1/skill-repos/projects`, the folder `/repos/projects/<name>` must match the repository's folder name; if two registered projects share a folder name the session is skipped, with the reason in the run summary); otherwise the **global skills repository** (`skills/**`, `commands/**`, `agents/**`, `CLAUDE.md`, `AGENTS.md`).
  The improver never edits `rubrics/`, in any repository.
  Hooks, `settings*.json`, scripts (`*.sh`, `*.py`, `*.js`), executable files and symlinks are denied by default, because Claude Code or a shell runs them.
  A repository can opt in (`PATCH /v1/skill-repos/{id}` with `allowExecutable: true`); every such proposal then carries `validation.warnings`.
- The improver works in a git worktree under `/data/worktrees` on a branch `introspect/<slug>`; your working tree is never touched until you accept.
  A diff is refused when it leaves the allowed paths, contains `..` or a binary, changes more than 5 files or 300 lines, adds an invisible character (control, zero-width, bidi or Unicode tag), or adds anything the redaction rules would replace.
  After any diff is applied, Introspect checks git's own list of changed files and modes (`git diff --raw`), not the text of the diff.
  Title (120 characters) and rationale (4000) are bounded and scanned for secrets too.
  Files are redacted before they are sent to the model.
  A cluster the improver declined, or failed on, is not billed again for 7 days unless new failing sessions join it.
  Automated git calls ignore the repository's hooks and signing and get a minimal environment.
  Accepts, rejects and edits on one repository run one at a time.
- **Accept** merges the branch with `git merge --no-ff` into the default branch (`proposals.accept_mode` = `merge`, the default), which needs that branch checked out with a clean tree; otherwise Introspect answers with the reason and a fix, and the proposal stays open.
  In `pr` mode it pushes the branch and runs `gh pr create`; set `GH_TOKEN` in `.env` (`make doctor` checks it).
  A repository can override the mode (`PATCH /v1/skill-repos/{id}` with `acceptMode`).
  Rejecting a proposal with an open pull request closes it (`gh pr close --delete-branch`); if that fails you get the command to run by hand.
  A merge that fails for a reason other than a conflict is reported as an error and leaves the proposal open.
  An accepted proposal writes a change event that the Trends screen marks.
- **Trends** (`GET /v1/trends`, `/v1/trends/changes`): pass rate per rubric per day or ISO week, with a marker for every accepted proposal, every manual edit of instruction files in a registered repository (found by a scan every 15 minutes; Introspect's own merges are skipped) and every rubric change.
  A rubric or judge-model change is a baseline reset.
  The change log compares the 7 days (`trends.window_days`) before and after each change and gives a verdict: a two-proportion z-test at 90%, `too_early` below `trends.min_graded` (10) sessions.
- **Reference set**: up to 20 pinned sessions (`POST` or `DELETE /v1/sessions/{id}/reference`) that are re-graded after a rubric or judge change, or on `POST /v1/trends/reference-regrade`.
- The improver's calls are on the same budget ledger as grading; `GET /v1/budget` reports its share in `improver`.
- `INTROSPECT_IMPROVER=fake` (environment only) swaps in a deterministic improver for tests and demos.

## Development

Everything runs in Docker; the host needs only Docker with Compose.

- `make dev` starts the server (7317) and Vite (5173) with live reload.
- `make test` runs the unit tests; `make test-pg` runs the Postgres tests.
- `make lint`, `make build`, `make shell`, `make down` do what they say.
- `make doctor` runs `introspect doctor` in the running stack; the same report is at `GET /v1/doctor`.

Architecture: [docs/architecture/architecture-overview.md](docs/architecture/architecture-overview.md).
