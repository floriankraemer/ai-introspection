# Settings and Health check

The Settings screen holds every option, and the **Health check**.
Below the Health check are eight cards: **Sources**, **People who push**, **Redaction and retention**, **Judge and budget**, **Schedule**, **Skills repositories**, **Trends** and **Team mode**.
Open it with **Settings** in the left menu.

![The Settings screen starts with the Health check, followed by eight cards.](images/settings-overview.png)

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

The **Sources** card lists the session log sources.
Each source has a kind chip next to the agent name, and a status chip: **Watching**, **Polling**, **Disabled** or **Not found**.
In Docker the status chip is **Polling**, because Introspect checks the folders at intervals instead of waiting for file events.

| Kind chip | Meaning |
|---|---|
| **Folder** | A folder on your computer. |
| **S3** | An S3 bucket. The row shows `s3://<bucket>/<prefix>`. |
| **Pushed** | The folder where the logs of one person who pushes to the [intake](20-sharing-sessions.md) are stored. The row says "Pushed by <name>". |

**+ Add source folder** adds a folder: choose the agent, enter the **Folder path** and click **Add folder**.
Folders must be readable inside the container, so a new folder also needs a mount.

**+ Add S3 bucket** adds a bucket:

1. Click **+ Add S3 bucket**.

   A form opens.

2. Choose the **Agent**, and enter the **Bucket**.

   Optional fields: **Prefix (optional)** to read one folder of the bucket, and **Region (optional)**.

3. For S3-compatible storage such as MinIO, enter the **Endpoint (optional)**.

   The checkbox **Use path-style addressing** appears.
   Tick it if the storage needs it.

4. Click **Add bucket**.

   Introspect lists the bucket once.
   The row appears with the chip **S3**.
   If the bucket cannot be read, a red message shows the error from S3 and nothing is added.

Do not enter credentials in this form.
They come from the server's environment: `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, and optionally `AWS_SESSION_TOKEN` and `AWS_REGION` in `.env`.
See the [configuration reference](15-configuration-reference.md).
The account needs the rights to list and read the bucket (`s3:ListBucket` and `s3:GetObject`).

Introspect copies the matching log files of a bucket to its data folder (`/data/s3/<source id>`) once a minute and imports them like any other folder.
A file you delete in the bucket stays in the copy, and its sessions stay in Introspect.
A new bucket is copied at once, and a history import copies the buckets first.
Objects larger than `INTROSPECT_INTAKE_MAX_MB` (default 64 MB) are skipped, and the Health check reports them.
Objects older than the retention period are not fetched.
The endpoint must use https, unless it is on your own computer.
The Health check reports whether the credentials are found and the bucket answers.

Every folder and S3 source has **Disable** (or **Enable** when it is disabled) and **Remove**.
A disabled source is not watched and not imported.
When you enable it again, Introspect imports what changed in the meantime.

**Remove** asks first: "Remove <location>? Its N sessions stay in Introspect."
For S3 and pushed sources the question adds: "The copied log files are deleted."
Removing a source keeps its sessions, grades and labels.
If you add the same folder again later, Introspect continues the same sessions without duplicates.

A **Pushed** source cannot be disabled, because that would not stop the person from uploading.
Revoke the person's token in **People who push** instead.
If you remove a pushed source, it comes back with that person's next push.

![The Sources card lists each source with its kind: Folder, S3 or Pushed.](images/settings-sources.png)

## People who push

The **People who push** card manages the [intake tokens](20-sharing-sessions.md) of the people who push sessions to this server.

![The People who push card lists each token with its status and a button to add a person.](images/settings-people.png)

If the intake is off, the card says "Session intake is off. Set `INTROSPECT_INTAKE_PORT` to let other people push."

Each token shows the person, when it was created, when it expires, and a status chip: **Active**, **Expired** or **Revoked**.
**Revoke** asks for confirmation.
After that, the next push with this token is refused.
Sessions already pushed stay.

To give a person a token:

1. Click **+ Add person**.
2. Enter the **Name**.
3. Choose **Expires**: 30, 90 or 365 days, or **Never**.
4. Click **Create token**.

   Introspect shows the token once, with the `introspect push` command and the curl command filled in.
   Copy it now and send it to the person over a safe channel.
   It is not shown again.

If the name already has a token, the card says so and offers **Create another token for <name>**.
The command `introspect intake-token` still works (see the [command reference](18-command-reference.md)).

## Redaction and retention

![The Redaction and retention card holds the redaction switch, the extra patterns and the retention period.](images/settings-redaction.png)

- **Redact secrets at ingest (tokens, keys, .env values)**: on by default.
  Turn it off only for tests.
  Sessions stored while it is off are never sent to a judge.
- **Extra redaction patterns**: one regular expression per line, up to 50.
  A pattern that is not valid shows a hint, and nothing is saved.
- **Keep event payloads for (days)**: default 90, minimum 7.

## Judge and budget

![The Judge and budget card holds the transport, the API key, the sampling rule and the budget.](images/settings-judge.png)


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
Schedules (grading and the improver) follow the same server time zone, default UTC.
The browser shows times in your local time.

## Schedule

![The Schedule card sets when grading and the improver run.](images/settings-schedule.png)

| Field | Meaning |
|---|---|
| **Grade sessions** | **When a session ends**, or **When its PR merges** |
| **Run improver** | **Daily at 06:00**, **Weekly, Monday 06:00**, or **Manually**. A run missed while the computer was off runs once at the next start. |

A line below the fields shows when the next run starts.

## Skills repositories

![The Skills repositories card sets how proposals are accepted and lists each repo.](images/settings-repos.png)

The card starts with one global default:

- **Accept proposals by**: **Merging locally** or **Opening a pull request**.

Below it, a list shows each repo once, the global skills repo first, then the project repos.
Each row has:

- The path, and a chip: **Global**, **Project** or **Disabled**.
- A list that overrides the default for this repo: **Use default (Merging locally)**, **Merging locally** or **Opening a pull request**.
  The first entry names the current default.
- **Allow hooks, settings and scripts**: off by default.
  Read the [safety notes](02-safety-and-privacy.md) before you turn it on.
  A confirmation box asks you to click **Allow**.
  **Cancel** leaves the option off.

If the global repo has no `rubrics/` folder, its row says so.
Run the [setup wizard](05-setup-wizard.md) to copy the starter rubrics.
If no global repo is set, the card tells you to use the Health check or the wizard.

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
