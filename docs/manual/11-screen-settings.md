# Settings and Health check

The Settings screen holds every option, and the **Health check**.
Open it with **Settings** in the left menu.

![The Settings screen starts with the Health check, followed by cards for sources, judge, schedule and trends.](images/settings-overview.png)

Most settings save by themselves.
A checkbox or a list saves when you change it.
A number saves when you leave the field.
The line "All changes saved." confirms it.
If a value is not valid, the field shows a hint in red and nothing is saved.

**Run setup wizard** at the top opens the [setup wizard](05-setup-wizard.md) again.

The full list of settings with their defaults is in the [configuration reference](15-configuration-reference.md).

## Health check

The Health check runs the same checks as `introspect doctor` (see [Troubleshooting](16-troubleshooting.md)).
The heading shows "Everything works." or, for example, "3 need attention".

![The Health check lists each check with OK or Warning, the detail and a fix.](images/settings-health-check.png)

Each line has a status chip:

| Chip | Meaning |
|---|---|
| **OK** | The check passed. |
| **Warning** | Something is missing, but Introspect still works. Often the item is optional. |
| **Failing** | Something is broken and a function does not work. |

Lines that need attention show the detail and a line "Fix: …" with the command to run.
Click **Run again** after you fix something.

> **NOTICE: This screenshot comes from a demo setup.**
> It shows warnings for "Judge (fake)" and "Clock" because the demo runs a test judge and a fixed date.
> A normal setup does not show these two.

## Sources

The **Sources** card lists the session log folders with a status chip: **Watching**, **Polling**, **Disabled** or **Not found**.
In Docker the chip is **Polling**, because Introspect checks the folders at intervals instead of waiting for file events.
**+ Add source folder** adds a folder: choose the agent, enter the **Folder path** and click **Add folder**.
Folders must be readable inside the container, so a new folder also needs a mount.

![The Sources card lists the folders and holds the redaction and retention options.](images/settings-sources.png)

The same card holds:

- **Redact secrets at ingest (tokens, keys, .env values)**: on by default.
  Turn it off only for tests.
  Sessions stored while it is off are never sent to a judge.
- **Extra redaction patterns**: one regular expression per line, up to 50.
- **Keep event payloads for (days)**: default 90, minimum 7.

## Judge and sampling

![The Judge and sampling card holds the transport, the API key, the sampling rule and the budget.](images/settings-judge.png)

| Field | Meaning |
|---|---|
| **Runs via** | **Anthropic API key** or **Local claude CLI (headless)** |
| **Anthropic API key** | Paste a key and click **Save key**. The hint says whether a key is already saved. |
| **Claude login in the container** | Shown for the CLI. The chip says **Logged in** or **Not logged in**. If it says **Not logged in**, run `make claude-login`, then click **Check again**. |
| **Test connection** | Checks that the judge works |
| **Grade** | **Flagged sessions + 20% random sample**, or **Every session** |
| **Budget** | **Tokens per day**, **Tokens per day + monthly dollar ceiling**, or **Monthly dollar ceiling only** |
| **Daily token budget** | Default 1000000 |
| **Monthly ceiling (USD)** | Only for the dollar modes |

Below the budget, a line shows the use so far, for example "Used 25k of 1M tokens today."
If the limit is reached, it also says that grading waits until midnight, or until next month.
The time zone for these windows comes from `TZ` in `.env`.

## Schedule

![The Schedule card sets when grading and the improver run, and how proposals are accepted.](images/settings-schedule.png)

| Field | Meaning |
|---|---|
| **Grade sessions** | **When a session ends**, or **When its PR merges** |
| **Run improver** | **Daily at 06:00**, **Weekly, Monday 06:00**, or **Manually**. A run missed while the computer was off runs once at the next start. |
| **Skills repo for patches** | The global skills repo. If it is not set, use the wizard. |
| **Accept a proposal by** | **Merging locally** or **Opening a pull request** |

The list of repos under **Accept a proposal by** has one line for each repo.
For each repo:

- **Accept by** overrides the default: **Default**, **Merging locally** or **Opening a pull request**.
- **Allow hooks, settings and scripts** is off by default.
  Read the [safety notes](02-safety-and-privacy.md) before you turn it on.
  A confirmation box asks you to click **Allow**.

**Project repo path** with **Add project repo** registers a project repo.
The path must be inside the mounted projects folder, for example `/repos/projects/web-app`, and the folder name must match the repo's folder name.
The improver changes only `.claude/**`, `CLAUDE.md` and `AGENTS.md` in project repos.

## Trends

![The Trends card sets the comparison window and the minimum sample size.](images/settings-trends.png)

- **Compare windows of (days)**: 1 to 60, default 7.
- **Minimum graded sessions per side**: default 10.
  With fewer sessions the verdict is "too early".

See [Reading trends](14-reading-trends.md).

## Team mode

The **Team mode** card is a placeholder for a later phase.
Its fields are disabled.
