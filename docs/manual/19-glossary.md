# Glossary

| Term | Meaning |
|---|---|
| Accept | Apply a proposal to your repo. Either **Merge into main** (a local merge) or **Open pull request**. |
| Accept mode | The way you accept proposals: **Merging locally** or **Opening a pull request**. Set it in Settings, globally or for each repo. |
| Agent | The coding tool that wrote a session log: Claude Code or Codex. |
| Baseline reset | A point on the Trends chart where a rubric or the judge model changed. Pass rates before and after it are not like-for-like. |
| Budget | The limit for judge and improver calls: tokens per day, a monthly dollar ceiling, or both. |
| Calibration | Comparing the judge's verdicts with your own labels for one rubric. |
| Calibration gate | The rule that makes a rubric trusted: the judge agrees with at least 8 of 10 of your labels. |
| Change log | The table on the Trends screen, **Did the fix help?**, with one row for each change and a verdict. |
| Cluster | A group of failing grades that share a repo, a rubric and similar reasons. The improver drafts one proposal for a cluster. |
| Doctor | The health checks: `introspect doctor`, and the **Health check** card in Settings. |
| Evidence | The events of a session that the judge cited as the reason for a grade. |
| Global skills repo | The git repo that holds your rubrics and your global skills, commands, agents and instruction files. |
| Grade | The verdict of the judge on one session for one rubric: a score, **Pass** or **Fail**, and a reason. |
| Health check | The list of checks in Settings. See [Troubleshooting](16-troubleshooting.md). |
| Improver | The model that reads failing grades and drafts proposals. |
| Ingest | Reading a session log, masking secrets and storing it. |
| Judge | The model that grades sessions. It runs through an Anthropic API key or through the `claude` command. |
| Label | Your own verdict, **Pass** or **Fail**, on one session for one rubric. |
| Merge into main | The accept button in local mode. It merges the proposal's branch into the repo's default branch. |
| Payload | The input and output of an event. Introspect removes payloads after the retention period. |
| Pin | Protect a session from the retention purge. Sessions in the reference set, and sessions with a label, are pinned. |
| Project repo | A git repo of one of your projects. The improver may change only `.claude/**`, `CLAUDE.md` and `AGENTS.md` in it. |
| Proposal | A drafted change to your instruction files, on its own git branch. You accept, edit or reject it. |
| Redaction | Masking secrets in a session before it is stored. |
| Reference set | Up to 20 pinned sessions that Introspect grades again after every rubric or judge change. |
| Retention | How long Introspect keeps event payloads. The default is 90 days. |
| Rubric | A Markdown file in `rubrics/` that tells the judge what a good session looks like. |
| Score | The number the judge gives on a rubric's scale. A score at or above the pass threshold is a pass. |
| Session | One run of a coding agent, from the first prompt to the end, as written in its log file. |
| Skills repo | Short name for the global skills repo, as on the screens. |
| Source | A folder with session logs that Introspect reads. |
| Superseded | A proposal that a newer proposal replaced. It appears under **Rejected**. |
| Trusted | A rubric that passed the calibration gate. Only trusted rubrics feed the improver. |
| Untrusted / uncalibrated | A rubric that has not passed the calibration gate. It still grades, but the improver ignores it. |
| Verdict | On Trends: **Improved**, **Worse**, **No change** or **Too early** for a change. For grades, see Grade. |
