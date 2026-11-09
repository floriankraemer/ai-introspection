# Troubleshooting

Start with the Health check.
Run it in either of two ways:

- Open [Settings](11-screen-settings.md) and read **Health check**.
- Run `make doctor` in the project folder.

Both run the same checks.
Each line starts with a status: `ok`, `warn` or `FAIL` in the terminal, and **OK**, **Warning** or **Failing** on the screen.
A line that needs attention ends with a fix.
`make doctor` exits with an error code only when a check fails.
Warnings do not set it.

After you apply a fix, run the check again: **Run again** on the screen, or `make doctor`.

The sections below follow the check names.
Each entry has the symptom, the cause and the fix.

## Health check entries

### Data folder and database

**Symptom:** "/data is not writable".
**Cause:** The container runs as a user that does not own the data folder.
**Fix:** Set `UID` and `GID` in `.env` to your own ids (`id -u`, `id -g`), then run `make up`.

**Symptom:** "Database unusable: …".
**Cause:** The database could not be opened or migrated.
**Fix:** Run `make up` once, so that the server migrates the database.
If it keeps failing, check `DATABASE_URL` if you set it, and look at the log with `docker compose logs introspect`.

### Agent log sources

**Symptom:** Warning "No source is registered".
**Cause:** You skipped step 1 of the wizard, or removed all sources.
**Fix:** Finish step 1 of the [setup wizard](05-setup-wizard.md), or run `docker compose exec introspect introspect import`.

### Source Claude Code: … or Source Codex: …

**Symptom:** Failing "Folder is missing or not readable".
**Cause:** The folder is not mounted into the container, or its permissions block your user.
**Fix:** For the standard folders, check that `compose.yaml` still has the mount lines for `~/.claude/projects` and `~/.codex/sessions`, then run `make up`.
For a folder you added yourself, add a bind mount for it in `compose.yaml`, or correct the path in Settings.

### File watcher

This line is informational and has no fix.
"Polling" is normal in Docker.

### Global skills repository

**Symptom:** Warning "Not set".
**Cause:** No skills repo is registered.
**Fix:** Finish step 3 of the setup wizard.
Or set `INTROSPECT_SKILLS_REPO` in `.env` to your skills repo and run `make up`.

**Symptom:** Failing "… does not exist".
**Cause:** The mount for `/repos/skills` is missing.
**Fix:** Set `INTROSPECT_SKILLS_REPO` in `.env` to an existing folder, then run `make up`.

**Symptom:** Failing "… is not the root of a git work tree".
**Cause:** The folder is not a git repo, or it is a subfolder of one, or git does not trust the owner.
**Fix:** Run `git init` in the folder on your computer, or mount the root folder of the repo.
If the owner is wrong, see "File ownership" below.

**Symptom:** Failing "… is read-only".
**Cause:** The mount has `:ro`, or your `UID` and `GID` differ from the folder owner.
**Fix:** Mount the repo without `:ro`, and set `UID` and `GID` in `.env` to the owner of the folder.

**Symptom:** Warning "… has no rubrics/ folder".
**Cause:** The repo has no rubrics yet.
**Fix:** Open the setup wizard (**Run setup wizard** in Settings), go to step 3 and click **Copy 4 starter rubrics**.

### Git identity

**Symptom:** Warning "No git author is configured; commits fall back to "Introspect"".
**Cause:** The four `GIT_*` variables are not set.
**Fix:** Set `GIT_AUTHOR_NAME`, `GIT_AUTHOR_EMAIL`, `GIT_COMMITTER_NAME` and `GIT_COMMITTER_EMAIL` in `.env`, then run `make up`.
This check is optional.

### GitHub CLI (PR mode)

**Symptom:** Warning "gh is not authenticated" or "gh is not installed".
**Cause:** No GitHub token is set.
**Fix:** This is needed only for pull request mode.
Set `GH_TOKEN` in `.env` and run `make up`.
Use a fine-grained token limited to your skills and project repos.
If you only merge locally, ignore the warning.

### Judge (api), Judge (cli) or Judge (fake)

**Symptom:** Warning "No API key" under **Judge (api)**.
**Cause:** The judge runs through the Anthropic API and no key is stored.
**Fix:** Enter the key in Settings (**Anthropic API key**, then **Save key**) or in step 2 of the wizard.
Or switch **Runs via** to **Local claude CLI (headless)**.

**Symptom:** Warning "The judge has no Claude login of its own in …" under **Judge (cli)**.
Settings shows **Not logged in**.
**Cause:** You did not sign in the container's `claude` yet.
The judge never uses your host login.
**Fix:** Run `make claude-login`, open the address it prints, sign in, and paste the code back.
Then click **Check again** in Settings.
Without Docker, run `introspect judge-login`.

**Symptom:** Warning "The claude CLI is not installed".
**Cause:** You run Introspect outside the Docker image, and `claude` is not on your path.
**Fix:** Use the Docker image, which contains the CLI, or install `claude`, run `introspect judge-login`, or switch **Runs via** to the API.

**Symptom:** Failing with a message that the CLI home could be read as agent logs.
**Cause:** `INTROSPECT_CLAUDE_HOME` points into a folder that is also a log source.
**Fix:** Set `INTROSPECT_CLAUDE_HOME` to a folder outside every log source, or remove the variable.

**Symptom:** Warning under **Judge (fake)**.
**Cause:** `INTROSPECT_JUDGE=fake` is set.
It replaces the real judge with a test judge.
**Fix:** Remove the variable from `.env` and run `make up`.

### Redaction

**Symptom:** Warning "Redaction is off: new sessions are stored unredacted and are never sent to a judge".
**Cause:** **Redact secrets at ingest** is off.
**Fix:** Turn it on in Settings.
Introspect rebuilds sessions stored while it was off from their log files, and then they can be graded.

### Rubric files

**Symptom:** Warning "Rubric files" with a message about a file.
**Cause:** A rubric file in `rubrics/` has an invalid header.
**Fix:** Open the file and correct `name`, `scale` and `pass_threshold`.
The rules are in [Writing and calibrating rubrics](12-writing-and-calibrating-rubrics.md).

### Change tracking

**Symptom:** Warning "Change tracking" with a span of commits.
**Cause:** The scan for manual edits could not follow a repo, for example after a rewritten git history.
**Fix:** Edits in the named span do not appear in the Trends change log.
The warning disappears after the next scan that finds new commits.
If the repo seems damaged, run `git fsck` in it.

### File ownership

**Symptom:** Warning "Not owned by uid …".
**Cause:** A repo folder belongs to another user than the container user.
**Fix:** Set `UID` and `GID` in `.env` to the owner of the folders, or run `chown -R $(id -u):$(id -g) <folder>`, then run `make up`.

### Clock

**Symptom:** Warning "INTROSPECT_NOW=… is set".
**Cause:** A test setting fixes the app clock.
**Fix:** Remove `INTROSPECT_NOW` from `.env` and run `make up`.

## Common problems

### Port 7317 is already in use

**Symptom:** `make up` fails with "port is already allocated" or "address already in use".
**Cause:** Another program, or another copy of Introspect, uses port 7317.
**Fix:** Stop the other program, or run `make down` in the other copy.
To use another port, change `127.0.0.1:7317:7317` in `compose.yaml` to `127.0.0.1:<port>:7317`, run `make up`, and open `http://127.0.0.1:<port>`.

### Permission denied on a mounted folder

**Symptom:** The container fails to start, or the Health check reports a read-only or not writable folder.
Files in your repo belong to `root`.
**Cause:** Docker created the folder as root, or your user id differs from the container's user id.
**Fix:** Run `make up` instead of `docker compose up`, because it creates the folders as your user.
Set `UID` and `GID` in `.env`.
Repair files that already belong to root with `sudo chown -R $(id -u):$(id -g) <folder>`.

### The sessions list is empty

**Symptom:** The Sessions screen shows **No sessions collected yet**.
**Cause:** One of these:

- The source folders have no sessions yet.
- The folders are not mounted, or are disabled.
- You run Claude Code on Windows, and Introspect runs in WSL2 (or the reverse).

**Fix:**

1. Open Settings and read **Sources**.

   Each folder shows a status chip.
   **Not found** means the folder is missing in the container.

2. Check on your computer that `~/.claude/projects` contains `.jsonl` files.

   If it is empty, use Claude Code once and try again.

3. Click **Import history** on the Sessions screen.

   The note shows "Import finished."

The list can also be empty because of a filter.
Click **Clear filters**, or set **Result** to **All** and **Period** to **All time**.

### A session does not appear

**Cause:** Introspect finds a new file within about a minute through the folder watcher and a scan every 60 seconds.
**Fix:** Wait a minute, or click **Import history**.

### The browser says it is not signed in

**Symptom:** The page **Open Introspect with its link** appears.
**Cause:** The cookie expired after 30 days, you use another browser, or the token was rotated.
**Fix:** Run `make open` and open the new link.

### Grading does not start

**Symptom:** **Grade selected** gives "Grading failed: …", or sessions stay **Not graded**.
**Cause and fix:** Check these in order.

1. The Health check shows a warning under **Judge**.
   Follow its fix.
2. The budget is used up.
   Settings shows "Used 1M of 1M tokens today", and says that grading is deferred until the budget resets at midnight.
   Raise **Daily token budget**, or wait.
3. Hold the pointer over **Not graded** in the table, to read the reason.
   "redaction is off" or "not redacted with current rules" means the session is not sent to the judge until it is rebuilt.
4. **Grade sessions** is set to **When its PR merges**.
   Only sessions with a merged pull request are graded on their own.
   Select the sessions and click **Grade selected**, or change the setting.

### The judge is not logged in

See "Judge (cli)" above.
Run `make claude-login`.

### `gh` is not authenticated, and Open pull request fails

Set `GH_TOKEN` in `.env`, then run `make up`.
Check that the token covers the repo you accept into.
The proposal stays open, and the red box names the problem.
To avoid GitHub, set **Accept proposals by** to **Merging locally**.

### Merge into main is refused

**Symptom:** A red box with a reason and a "How to fix" line.
**Cause:** The default branch is not checked out in the repo, or the working tree has uncommitted changes.
**Fix:** In your repo, check out the default branch and commit or stash your changes.
Click **Merge into main** again.

### The disk is full

**Symptom:** Introspect fails to write, or Docker reports "no space left on device".
**Cause:** Docker images, volumes or the Introspect database fill the disk.
**Fix:**

1. Run `docker system df`.

   You see how much space images, containers and volumes use.

2. Run `docker image prune` to remove unused images.

   Docker reports the space it reclaimed.

3. Lower **Keep event payloads for (days)** in Settings.

   Introspect removes older payloads at its next purge.
   The minimum is 7.

### Introspect does not start after an update

Run `git pull`, then `make up`, which rebuilds the image.
If it still fails, run `docker compose logs introspect` and look at the last lines.

## Getting more information

- `docker compose logs introspect` prints the server log.
- `docker compose ps` shows whether the container is healthy.
- `docker compose exec introspect introspect doctor` is the same as `make doctor`.
