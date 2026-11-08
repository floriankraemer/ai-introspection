# Agent Self-Improvement Loop — Build Plan

Source: Claude Docs page [Agent Self-Improvement Loop — Build Plan](https://claude.ai/artifact/2HT4vTXUjfzCVySoUeXgTB), as of 2026-11-08.
Wireframes: [design canvas](https://claude.ai/artifact/WQZFNrZo82q9FDV3BusKJ3), copied to [`../mockups/`](../mockups/).

Build a local tool that collects your coding-agent sessions, grades them against your own rubrics, and proposes fixes to your skills and config, with a dashboard proving whether each fix helped.
Store and API are designed so a team server can replace the local file later without rewriting the app.

## What the talk proposes

Source: [Your AI Agent Is Hiding Its Mistakes From You — Ben Holmes, Warp (AI Engineer)](https://www.youtube.com/watch?v=pz74r-4dGfQ).

- **Core problem:** agents silently work around broken instructions (e.g. stale skill docs → agent probes port numbers until something runs) and report success. You only notice runs got slower.
- **Loop:** collect all conversations → score each with LLM-as-judge rubrics → daily agent clusters the failures → opens PRs against skills/config → keep scoring to see if it helped.
- **Capture three things per session:** the transcript, every tool/MCP/file-system call (incl. failures), and the output (diff or merged PR).
- **Example rubrics:** redundant tests, verbosity (chat and code comments), efficiency (progress vs. spinning wheels).
- **Rubric format:** a markdown skill with a short definition, labelled score levels, and a pass/fail line.
- **Grading:** one judge run per session (or batched for tokens), random sampling allowed, triggered on PR merge; each grade stores a reason.
- **Daily improver:** take the last 24 h, filter failures, give the reasons plus repo access to an agent, get proposed changes.
- **Trends:** chart scores over time and mark when a fix merged.
- **Reference tools:** Warp's Skill Doctor (one-off grading of local Claude Code/Codex history) and Warp Factories (continuous, team-wide).

## Goals and principles

V1 runs on one laptop with no server; every choice keeps a clean seam for a team backend.

- **Local-first:** one SQLite file, one CLI, one local web UI on localhost. Nothing leaves the machine except calls to the judge model.
- **Agent-agnostic ingest:** adapters per source (Claude Code first, Codex second) map into one normalized trace schema.
- **Rubrics as code:** markdown files in a git repo, versioned next to your skills. A grade always records which rubric version produced it.
- **Cheap before smart:** deterministic signals (failed tool calls, retries, duration, token count) flag sessions before any LLM grading.
- **Human merges, agent proposes:** the improver only writes branches/patches; you accept or reject in an inbox.
- **Every fix is an event:** accepted changes are logged so the trend chart can show before/after.
- **Team-ready seams:** all IDs are UUIDs, every row carries `workspace_id` and `user_id`, storage sits behind a repository interface, and the UI talks to a local HTTP API rather than the database.

## Architecture (as sketched)

Agent sessions (Claude Code, Codex JSONL logs) → Collector (normalize + redact, cheap signals) → Trace store (SQLite; Postgres for teams) ⇄ Grader (LLM judge × rubrics, on session end).
Store → Improver (daily: cluster fails, draft patches) → Review inbox (you accept or reject each patch) → Skills and config (CLAUDE.md, skills/, versioned in git) → loaded by agents.
Store → Trend dashboard (scores over time + fix markers).

## Data model

| Table | Key fields | Notes |
| --- | --- | --- |
| session | id, workspace_id, user_id, agent, repo, branch, started_at, duration_s, tokens_in/out, cost, outcome_ref | One row per agent conversation |
| event | id, session_id, seq, kind (user / assistant / tool_call / tool_result / file_op / mcp), name, input, output, is_error, ms | Full trace; payloads redacted at ingest |
| signal | session_id, failed_tool_calls, retries, repeated_commands, files_touched, tests_run | Deterministic, computed at ingest |
| rubric | id, name, version (git sha), scale, pass_threshold, body_md | Mirrors files in rubrics/ |
| grade | id, session_id, rubric_id, rubric_version, score, passed, reason, evidence_event_ids, judge_model, graded_at | One per session × rubric |
| proposal | id, created_at, target_path, diff, rationale, evidence_session_ids, status | Output of the daily improver |
| change_event | id, at, proposal_id?, description, files | Drawn as markers on trends |

Sources: `~/.claude/projects/**/*.jsonl` (Claude Code) and `~/.codex/sessions/**` (Codex).
Link a session to its outcome by matching repo + branch to the commit or merged PR (via `gh`).

## Rubrics

| Rubric | Fails when | Uses |
| --- | --- | --- |
| efficiency | Agent spins: repeated probing, retries, back-and-forth | Tool-call trace + signals |
| redundant-tests | Tests duplicate coverage or ignore the test-pyramid rule | Diff + test commands |
| verbosity | Long summaries, noisy code comments | Assistant turns + diff |
| silent-workaround | A tool or instruction failed, the agent routed around it, and the final report does not mention it | Error events vs. final message |

Rubric file format (`rubrics/efficiency.md`):

```markdown
---
name: efficiency
scale: [0.0, 0.2, 0.4, 0.6, 0.8, 1.0]
pass_threshold: 0.6
applies_to: all
---
Did the agent work toward the result, or waste effort on redundant steps
and back-and-forth?

- 1.0  Direct path; information gathering proportional to the task
- 0.6  Some detours, recovered quickly
- 0.2  Repeated failed calls or environment probing a skill should cover

Return: score, one-paragraph reason, ids of the events that justify it.
```

The judge prompt is fixed; only the rubric body changes.
Calibrate each rubric on 10 hand-labelled sessions before trusting it.

## Screens

| # | Screen | Answers | Key elements | Mockup |
| --- | --- | --- | --- | --- |
| 1 | Sessions | Which runs went badly? | Pass-rate cards per rubric, filters, table with tool-error count and a chip per rubric | [Main](../mockups/Main.dc.html) |
| 2 | Session detail | Why did it fail? | Trace timeline with errors highlighted, per-rubric grade + reason + evidence, "judge was wrong" | [Session](../mockups/Session.dc.html) |
| 3 | Rubrics | Is the judge trustworthy? | Markdown editor, threshold, dry-run, calibration table with the 8/10 gate | [Rubrics](../mockups/Rubrics.dc.html) |
| 4 | Proposals | What should change? | Inbox of drafted fixes, rationale, evidence, diff, accept / edit / reject | [Proposals](../mockups/Proposals.dc.html) |
| 5 | Trends | Did the fix help? | Weekly pass rate per rubric, merge markers, change log with before → after | [Trends](../mockups/Trends.dc.html) |
| 6 | Settings | What runs when? | Source folders, redaction, judge + sampling, schedule, skills repo, disabled team-mode panel | [Settings](../mockups/Settings.dc.html) |

The mockups are Claude Design `.dc.html` artboards; they need the canvas runtime to render, so view them on the design canvas link above.

## Phased roadmap

1. **Collect** (week 1): Claude Code + Codex adapters, redaction, signals, session browser. Gate: a week of sessions browsable.
2. **Grade** (weeks 2–3): 4 rubric files, LLM judge + CLI, flagged + sampled, grade on finish. Gate: judge matches you on 8 of 10 labels.
3. **Improve** (week 4): nightly improver, patch on a branch, review inbox. Gate: first patch accepted.
4. **Prove** (week 5): trend charts, change markers, re-grade reference set. Gate: one fix visibly moves a score.
5. **Team** (later): Postgres + API, log shipper, GitHub App, SSO, privacy controls.

## Path to team mode

| Area | Local (v1) | Team |
| --- | --- | --- |
| Storage | SQLite file | Postgres (same schema, row-level security on workspace_id) |
| Ingest | Watcher reads local folders | Same watcher as a shipper: pushes redacted traces to `POST /v1/sessions`; or cloud sandboxes report directly |
| Triggers | File watcher + cron (launchd/systemd) | GitHub App webhook on PR merge + server scheduler |
| Proposals | Local git branch + patch | Pull request on the shared skills repo, CODEOWNERS review |
| Identity | Single user, no auth | SSO/OIDC, roles: member, rubric owner, admin |
| New | — | Per-user privacy opt-out, token budget per workspace, team leaderboard of rubric pass rates (not per-person ranking) |

Keep the API contract (`/v1/sessions`, `/v1/grades`, `/v1/proposals`, `/v1/trends`) identical in both modes so the switch is a config change.

## Risks and open questions

- **Secrets in traces:** redact at ingest (gitleaks-style patterns) before anything is stored or sent to a judge.
- **Judge cost:** grade only flagged sessions plus a 20 % random sample; batch small sessions.
- **Judge drift:** store judge_model on every grade and re-grade a fixed 20-session reference set after any change.
- **Rubric overfitting:** keep a quality guardrail rubric and always human-review proposals.
- **Team trust:** scores must describe the setup, not rank people.

Open:

- [ ] Judge model: Claude API key, or headless `claude -p` on your subscription?
- [ ] Stack: TypeScript (Node + Hono + React) or Python (FastAPI + HTMX)?
- [ ] Where do skills live today: one repo, or per project `.claude/` folders?
