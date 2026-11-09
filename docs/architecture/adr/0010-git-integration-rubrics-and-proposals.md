# 0010. Git CLI with worktrees for rubrics and for proposed changes in global and project skill repositories

## Status

Accepted (2026-11-08)

## Context

The plan treats rubrics as code: markdown files in a git repository, versioned next to the skills, and every grade records the rubric version (git SHA).
The improver "only writes branches/patches"; the human accepts or rejects in the inbox; accepted changes become change events.
Team mode turns proposals into pull requests on a shared skills repository with CODEOWNERS review.
The Rubrics screen saves edits "as v4 (commit)"; the Proposals screen shows a branch name (`introspect/e2e-port-discovery`), a diff, and "Accept and merge", "Edit first", "Reject with reason".
Instructions live in two places: a global skills repository, and per-project `.claude/` folders (plus `CLAUDE.md`/`AGENTS.md`) inside the repositories where sessions run.
The improver must change the file the failure came from, in whichever of these repositories it lives.
These repositories may have uncommitted work; Introspect must never damage it.

## Considered options

1. The `git` CLI via child processes, with worktrees for improver runs; Octokit for pull requests in team mode.
2. isomorphic-git (pure JavaScript).
3. libgit2 bindings (nodegit).
4. Rubrics and patches stored in the database only, exported to git on demand.

## Decision table

| Option | Pros | Cons |
|---|---|---|
| git CLI + worktrees | Exact behaviour of the user's git (config, hooks, credentials, signing). Worktrees give the improver an isolated checkout without touching the user's working tree. | Requires `git` on PATH; output parsing must use porcelain formats. |
| isomorphic-git | No external binary. | No worktree support, limited merge; diverges from the user's git config and credential helpers. |
| nodegit | In-process speed. | Native addon with a weak maintenance record and platform build problems. |
| DB-only | Simple storage. | Violates "rubrics as code"; no review in the user's normal tools; export drift. |

## Evaluation matrix

| Quality attribute | Weight | git CLI (child process) + worktrees; Octokit for team PRs | isomorphic-git (pure JS) | libgit2 bindings (nodegit) | Rubrics/patches in DB only, export to git |
|---|---:|---:|---:|---:|---:|
| Portability / run-everywhere | 20% | 4 | 5 | 2 | 5 |
| Robustness / durability | 20% | 5 | 3 | 3 | 4 |
| Maintainability | 15% | 4 | 3 | 2 | 3 |
| Simplicity | 15% | 4 | 3 | 2 | 4 |
| Security / privacy | 10% | 4 | 4 | 3 | 4 |
| Ecosystem / LLM-SDK fit | 10% | 5 | 3 | 2 | 1 |
| Testability | 10% | 4 | 4 | 3 | 5 |
| **Weighted total (max 5.00)** | 100% | **4.30** | 3.60 | 2.40 | 3.85 |

Scores: 1 = poor, 3 = acceptable, 5 = excellent. Weighted total = sum(weight x score) / 100.

## Decision

General:

- Require `git` 2.30 or later on PATH (checked at startup with an actionable error).
  Use porcelain and `-z` output formats only.

Skill repositories (two kinds, both in v1):

- Global skills repository: one path in Settings ("Skills repo for patches").
  It holds shared skills and global instructions (for example the files behind `~/.claude/skills/` and `~/.claude/CLAUDE.md`), and `rubrics/`.
- Project repositories: the git repository a session ran in (`session.repo_root`), with its project instructions in `.claude/**`, `CLAUDE.md` and `AGENTS.md`.
  A project repository is registered automatically the first time the improver targets it, and can be disabled in Settings.
- Both kinds are rows in `skill_repo` (owned by the improvement module): `kind` (global / project), local path, remote URL, default branch, allow-list, accept-mode override, enabled.
- Default allow-lists (narrowed after the Phase 3 review, see "Review decisions" below): global `skills/**`, `commands/**`, `agents/**`, `CLAUDE.md`, `AGENTS.md`; project `.claude/skills/**`, `.claude/commands/**`, `.claude/agents/**`, `CLAUDE.md`, `AGENTS.md`.
  Source code in project repositories is never in the allow-list.

Rubrics:

- Rubrics live in `rubrics/` in the global skills repository.
- Rubric versions: `rubric.version` is the git blob SHA of the file content (content-addressed, stable across rebases); the UI shows an ordinal ("v3") counted from the file's commit history.
  Grades reference the blob SHA.
- Saving a rubric in the UI writes the file and runs `git commit -- <path>` with a generated message, committing only that path even if other changes are staged.
- `rubrics/**` is denied for the improver in every repository, so the improver cannot change its own grader.

Target resolution (the improver changes the file the failure came from):

1. For each failing session, collect the instruction files involved: skill and instruction files loaded in the session (`skill` events and instruction-file reads), resolved with `realpath`.
2. A file whose real path lies inside the global skills repository maps to the global target; a file inside the session's `repo_root` maps to that project target.
3. If no instruction file is involved (a missing instruction rather than a wrong one): when all sessions of the cluster come from one project repository, target that project; otherwise target the global repository.
4. Clustering groups failures by target first, so every cluster, and every proposal, has exactly one target repository.

Improver runs:

- For each cluster, create a worktree of the target repository under `<data_dir>/worktrees/<run_id>/<slug>` on a new branch `introspect/<slug>` from the target's default branch.
  The improver adapter edits files only inside it (ADR-0006).
- After the run, Introspect validates the diff against the target's allow-list, at most 5 files and 300 changed lines.
  A diff that fails validation is discarded with a logged reason.
  Valid diffs are committed on the branch; the proposal stores `target_repo_id`, target path, branch, base SHA, head SHA and diff.
- "Edit first": the user edits the file in the UI; Introspect commits the edit on the proposal branch.

Accept:

- Accept mode is a setting, `proposals.accept_mode` = `merge` (default) or `pr`, with an optional per-repository override in `skill_repo`.
- `merge`: requires that the target repository has its default branch checked out and a clean working tree; Introspect runs `git merge --no-ff introspect/<slug>` there.
  A dirty tree, another checked-out branch, or a conflict returns a clear error, and the proposal stays open (`conflict` status on conflict).
  The error suggests `pr` mode for repositories that usually have work in progress.
- `pr`: Introspect pushes the branch and runs `gh pr create`; the proposal becomes `accepted`, and the change event is recorded, when the PR is merged (polled with `gh` every 10 minutes).
- Team mode always uses PRs through the GitHub App (Octokit), on the shared global repository or on the project repository.
  If the App is not installed on the target repository, accept is disabled with an explanation.
- Reject: delete the worktree and branch, keep the proposal row with the reason.

Change detection and housekeeping:

- Manual edits ("CLAUDE.md: prefer e2e over unit tests" in the Trends mockup): any commit on a registered repository's default branch that touches allow-listed paths and did not come from a proposal is recorded as a `manual_edit` change event by a periodic scan (every 10 minutes and on improver runs).
  Change events carry the repository, so trends can show project-specific markers.
- Worktrees older than 14 days without an open proposal are pruned.

## Consequences

- Positive: fixes land where the failing instruction lives, so a project-specific problem does not pollute global skills, and the reverse.
- Positive: the user's working trees are never modified except by an explicit accept or rubric save, which only touch the named files.
- Positive: rubric history, proposal history and blame live in normal git tooling.
- Negative: the improver now writes branches in project repositories, not only in the skills repository; the narrow project allow-list (instructions only, never source code) and human accept contain this.
- Negative: target resolution depends on the adapters recording loaded instruction files; when they cannot, rule 3 falls back to a heuristic.
- Negative: users need git installed (every target user already has it), and `gh` for `pr` mode.
- Negative: merges in the user's repositories can conflict; Introspect reports instead of resolving.

## Revisit triggers

- More than 20 % of accepted proposals are re-targeted by hand (user edits a different file than proposed): improve target resolution, for example with an explicit "instructions involved" step in the clustering prompt.
- Teams use a forge other than GitHub: add a forge port with GitLab support.

## Related

- ADR-0006 (improver adapters), ADR-0009 (rubrics and improvement modules), overview "Runtime flows".

## Implementation notes (Phase 3, WP7)

- The improver port is `propose(request) -> whole-file edits | none`, not `cluster` plus `propose`.
  Clustering is deterministic code (target repository and rubric, then word overlap of the judge's reasons, at least 25 %), so no `cluster` call exists yet.
  The adapters get a read-only snapshot of the target's allowed files (at most 60 files, 64 KiB each, 200 KiB in all) and return the complete new content of each file they change.
  Introspect writes the files into the worktree and derives the unified diff with `git diff --binary`, so the adapter has no write or shell tool and the diff always applies to the base commit.
  The API adapter is a manual tool loop (`list_files`, `read_file`, `submit_proposal`, `decline`, at most 10 turns) on `claude-opus-5-5`; the CLI adapter inlines the files and runs `claude -p` with no tools, in the judge's private home.
- Paths under `rubrics/` and `.git/` are denied in every repository, case-insensitively.
  The allow-lists are the ones in "Review decisions" below (the first implementation allowed `**` in the global repository and `.claude/**` in projects).
  A diff is refused for: a path with `..`, an absolute path, a backslash, `//` or a quoted name; a binary change; a symlink or submodule; more than 5 files or 300 changed lines; an added line that the redaction rules (built-in and custom) would change.
  A refused diff is stored as a proposal with status `failed` and the reason in `decision_note`; its branch is deleted.
- Target resolution uses rule 2 and 3 only: the registered project repository the session ran in, else the global one.
  A session records its host path, so a project matches by registered path or, inside the container, by the repository's folder name.
  Rule 1 (instruction files loaded in the session) is not used yet.
- The 'one proposal per cluster' dedupe: a cluster whose sessions are all evidence of an open proposal on the same repository is skipped.
- Accept in `merge` mode: default branch checked out and clean tree, else 409 with `fix`; a conflicting merge is aborted, the proposal gets status `conflict`.
  Automated commits and merges ignore the user's hooks and signing (`core.hooksPath=/dev/null`, `commit.gpgsign=false`).
  The merge commit SHA and a `proposal_merged` change event (files, rubric names) are written in one transaction.
  In `pr` mode the proposal stays `open` with `pr_url`; a job every 10 minutes polls `gh pr view`, and a merged PR becomes `accepted` with the change event at the merge time, a closed one `rejected`.
- Budget: one reservation per proposal, settled with the real usage of all turns.
  `GET /v1/budget` reports the improver's share in `improver`.
  The reservation is a full 16,000-token answer plus four times the estimated input (a tool loop re-sends the context each turn).
  It is also the loop's token cap: the API adapter stops with a `budget` decline before a turn that could push its total past it.
  A stale reservation (a process that died) stops counting after 3 hours, longer than any call can run.

## Review decisions (Phase 3 review)

An improver can write text that the agent reads as instructions, and a human who clicks Accept in a hurry reviews a diff, not its effects.
These rules shrink what a proposal can contain, and make git, not our parsing of text, the authority.

Why the allow-lists are narrow:

- `settings*.json`, `hooks/**` and scripts (`*.sh`, `*.py`, `*.js` and similar) are code: Claude Code runs hooks on every tool call, and a settings file can add them, change permissions or point at an MCP server.
  A model that read a poisoned session could write one, and the diff would look like configuration.
  Files with mode 100755 and symlinks are denied for the same reason (a symlink can point out of the repository or into `rubrics/`).
- The global allow-list was `**`, which included all of that plus `rubrics/`-adjacent files and any dotfile.
  It is now `skills/**`, `commands/**`, `agents/**`, `CLAUDE.md`, `AGENTS.md`, the files an agent reads as instructions.
  Projects get the same under `.claude/`.
- A repository can set `allowExecutable` (`PATCH /v1/skill-repos/{id}`, default false).
  The allow-list then also holds `hooks/**` and `settings*.json` (`.claude/hooks/**`, `.claude/settings*.json` in projects), scripts and mode 100755 pass, and every proposal that changes one carries `validation.warnings`: "changes a hook/settings file that Claude Code executes".
  Symlinks and submodules stay denied.
- An added line may not contain control characters (except tab, and a carriage return at the end of a line), zero-width characters, bidi overrides or isolates, or Unicode tag characters (U+E0000 to U+E007F): a reviewer cannot see them, a model obeys them.
  The same applies to the title and rationale, which are also bounded (120 and 4000 characters) and scanned for secrets.
  Zero-width joiners in emoji sequences are refused as a side effect; that is accepted.
- Repository files are redacted before they are sent to the model; a file that is more than half redacted is left out.
  A diff refused because of a secret is never stored (only the reason).

Why git is the authority:

- The text of a diff can name one file in its `diff --git` header and another in its `---`/`+++` lines; a regular expression that splits the header on `" b/"` can be tricked (`a/x b/rubrics/y b/z`), and git applies the file the other lines name.
  `inspectDiff` therefore parses names from the `---`/`+++` and rename lines, requires the header to split in exactly one way, and rejects any disagreement.
  It is only the first filter.
- After a diff is applied and committed on a scratch branch (improver and "Edit first" alike), Introspect validates `git diff --raw -z --no-renames` and `--numstat -z` of `base..head`: every path, both modes, binary changes and the size limits.
  The text checks run again on git's own diff, and both views must list the same files.
- "Edit first" works on a temporary branch from the base commit; the proposal branch moves (compare-and-swap) only after every check passed.
  A failure leaves the proposal branch and `head_sha` as they were.

Concurrency and side effects:

- All mutating git operations on a repository (accept merge, PR push, edit, worktree add and remove, branch delete) take a per-repository in-process lock.
  Accept and reject re-read the proposal under the lock and update it conditionally (status `open` or `conflict`), so an accept racing a reject has exactly one winner.
- A merge is a conflict only when git exits 1 and `MERGE_HEAD` exists; the merge is then aborted and the proposal gets status `conflict`.
  Any other failure is reported as an error, with the proposal still open.
  A merge already in progress before accepting is never touched: the accept answers 409.
- Rejecting a proposal that has a pull request closes it with `gh pr close --delete-branch`; if that fails, the proposal stays open and the answer carries the command to run by hand.
  The poller only looks at open proposals.
- Every automated git call runs with `-c core.hooksPath=/dev/null -c commit.gpgsign=false -c core.fsmonitor=false` and a minimal environment (PATH, HOME, LANG, `GIT_AUTHOR_*`/`GIT_COMMITTER_*`; `GH_TOKEN` and the SSH agent only for push and `gh`); pushes also pass `--no-verify`.
  A repository's hooks and `core.fsmonitor` are commands its author chose, and would otherwise run in our process with our secrets.

Cost and housekeeping:

- A cluster that the improver declined, or failed on after a billed response, is recorded with a hash of its session ids and not billed again for 7 days unless its set of sessions changed.
- At startup Introspect removes every folder in `<data_dir>/worktrees`, runs `git worktree prune` in each registered repository, and deletes `introspect/*` and `introspect-tmp/*` branches that no open or conflicting proposal owns.
- A scheduled run looks back to the start of the last successful run (at most 14 days) when that is longer than one period.
- The cached default branch is refreshed on every accept and run.
- A session whose repository folder name matches more than one registered project is skipped with a reason, never guessed.
