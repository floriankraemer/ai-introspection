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
- Default allow-lists: global `skills/**`, `CLAUDE.md`, `AGENTS.md`, `settings.json`; project `.claude/**`, `CLAUDE.md`, `AGENTS.md`.
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
