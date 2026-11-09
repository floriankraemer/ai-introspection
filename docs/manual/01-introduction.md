# Introduction and intended use

## What Introspect does

Introspect reads the session logs that your coding agents write.
It grades each finished session against rubrics you control.
It then proposes small changes to your agent instructions, so the same mistakes happen less often.
Later, it shows whether the changes helped.

The loop has five parts:

1. **Collect.**
   Introspect imports the session logs of Claude Code and Codex from your disk.
   It masks secrets before it stores anything.
2. **Grade.**
   A model, the judge, scores each session against every rubric.
   A rubric is a short Markdown file that says what a good session looks like.
3. **Improve.**
   The improver reads failing grades and drafts a proposal.
   A proposal is a change to a skill, an instruction file or a command, on its own git branch.
4. **Review.**
   You read each proposal and accept, edit or reject it.
   Nothing changes in your repos until you accept.
5. **Prove.**
   The Trends screen marks every change on a pass-rate chart and tells you whether the pass rate moved.

## Who this manual is for

This manual is for developers who use Claude Code or Codex every day and keep their own skills, commands or instruction files (`CLAUDE.md`, `AGENTS.md`) in git.
You need to be comfortable with a terminal, git and Docker.
You do not need to know how Introspect works inside.

## What Introspect is not

- It is not a cloud service.
  Introspect runs on your computer, and its database stays there.
- It is not a code reviewer.
  It grades how the agent worked, not whether your code is correct.
- It does not change your instructions by itself.
  It drafts proposals, and you decide.
- It does not edit hooks, settings files or scripts unless you opt in for a repo (see [Safety and privacy notes](02-safety-and-privacy.md)).
- It does not replace your judgement about the rubrics.
  A judge model can be wrong, which is why Introspect makes you check it against your own labels first (see [Writing and calibrating rubrics](12-writing-and-calibrating-rubrics.md)).
- It has no team mode yet.
  The Team mode card in Settings is a placeholder and does nothing.

## Intended use

Use Introspect to find repeated, avoidable problems in your own agent sessions, and to test whether a change to your instructions helped.
Use it with repos that you own.
Do not use it as an automatic quality gate for other people's work: the grades are only as good as your rubrics and labels.

## Where to go next

Read [Safety and privacy notes](02-safety-and-privacy.md), then follow the [Quick start](04-quick-start.md).
