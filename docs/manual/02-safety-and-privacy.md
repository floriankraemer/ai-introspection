# Safety and privacy notes

Introspect cannot injure a person.
It can send data to another company and it can write to your git repos.
This page lists both, and what you can do about each.
Read it before the first start.

## What leaves your machine

> **NOTICE: Session content is sent to Anthropic.**
> Hazard: the judge and the improver send redacted parts of your sessions to the Anthropic API, or through the `claude` command in the container.
> A session can contain source code, file names, commands, and what you and the agent wrote.
> Consequence: that content is processed under your Anthropic terms.
> To avoid this: do not complete step 2 of the setup wizard (the **Skip** button), and do not use the **Grade selected** or **Run improver now** buttons.
> Without a judge, Introspect still imports and shows your sessions, but it grades nothing.

What is sent, and when:

| What | Sent to | When |
|---|---|---|
| The redacted trace of one session, and the text of one rubric | Anthropic, as a grading request | A session is graded |
| Judge reasons, instruction files from the target repo (redacted) and a list of failing sessions | Anthropic, as an improver request | The improver runs |
| A pull request and a branch | GitHub | You accept a proposal in pull request mode |

Nothing else leaves your machine, unless you push sessions to another server (see [Sharing sessions](20-sharing-sessions.md) and the section below).
Introspect does not send usage data of its own.
The container's `claude` command runs with telemetry, error reporting and auto-update switched off.
Network access from the container stays open on purpose, because the judge, the improver and `gh` need it.

## Redaction and its limits

Introspect masks secrets before it stores a session.
It looks for API keys, tokens, private keys, JWTs, `KEY=value` pairs with high randomness, and the content of files such as `.env*`, `*.pem` and `id_*`.
A masked value becomes `[REDACTED:<rule>:<id>]`.
You can add your own patterns in Settings (**Extra redaction patterns**).

> **NOTICE: Redaction is pattern matching and misses some secrets.**
> Hazard: a secret in an unusual format, a password in plain prose, or personal data is not recognised.
> Consequence: it is stored in your local database and can be sent to Anthropic.
> To avoid this: add a pattern for every secret format you use, and check a few traces yourself on the [Session detail](07-screen-session-detail.md) screen.
> Redaction also does not remove source code or business content.

Two more rules protect you:

- If redaction is off, or the stored session used older rules, Introspect never sends that session to a judge.
  The Sessions screen then shows "redaction is off" or "not redacted with current rules".
- When Introspect improves its rules, it rebuilds older sessions from their log files.

## Sharing sessions: raw and redacted pushes

The intake lets other people send their sessions to a server (see [Sharing sessions](20-sharing-sessions.md)).
It is off for the app on port 7317, and listens on a second port, 7318, on `127.0.0.1` until the admin changes `INTROSPECT_INTAKE_BIND`.

> **NOTICE: A raw push sends unredacted logs over the network, and the server stores them.**
> Hazard: `introspect push` without `--redact`, and the `curl` command, send the log file as it is.
> The server redacts when it ingests the file, but it keeps the raw file in its data folder (`intake/`, file mode 0600).
> Consequence: a secret that the patterns miss is in the stored file, and on the network if the connection is not encrypted.
> To avoid this: push with `--redact`, so the secrets are masked on your computer first, and let the server mask again.
> The admin must put TLS (`https://`) in front of the intake port before any other computer can reach it.
> `introspect push` refuses plain `http://` to another computer.

Facts to know:

- With `--redact`, the server still applies its own rules and your admin's extra patterns to what it receives.
  Your computer applies the default rules and your own extra patterns.
  If your own patterns cannot be read, nothing is pushed.
- A token belongs to one person.
  Whoever holds it can push sessions as that person, so keep it like a password.
  Pass it as `INTROSPECT_PUSH_TOKEN`, not as `--token`.
  The server shows a token only once and stores only a hash.
- The admin revokes a token with `introspect intake-token revoke`.
  This is the control that stops a person.
  Disabling the person's source in Settings does not stop uploads.
  Give tokens an expiry with `--expires`.
- An intake token works only on the intake port.
  The admin token of the app does not work there.
- The server limits upload size and each person's stored raw logs.
  It does not limit how often a token pushes, so put rate limiting in the reverse proxy.
- Intake and S3 copies older than the retention period are deleted, except those of pinned sessions.
- `introspect push` never follows a redirect, so your token and logs go only to the address you gave.
- The intake port accepts uploads only.
  It serves no screens and none of the app's settings or git functions.

S3 sources read logs from a bucket with the credentials in the server's environment.
Introspect never stores them.
It copies the log files to its data folder, so the bucket's logs also exist on the server disk.
The S3 endpoint must use https, unless it is on your own computer.

## The container has its own Claude login

If you choose **Local claude CLI** as the judge, you sign in to Claude once inside the container with `make claude-login`.
That login lives in the container's private data folder, not in your `~/.claude` folder.
Introspect never mounts or copies your own Claude login, because a second program using the same login can sign you out.
Anyone who can read the Docker volume `introspect_data` can use that login, so treat the volume like a credential.

If you choose **Anthropic API key** instead, the key is stored in the data volume with file mode 0600.
It is never stored in the database or in your skills repo.

## Mounted repos are writable and trusted

> **NOTICE: Introspect writes to the repos you mount, and runs git in them.**
> Hazard: the skills repo and the projects folder are mounted read-write.
> Introspect commits rubric edits, creates branches and merges proposals there.
> Git runs any hook in a repo's `.git/hooks` folder when Introspect commits.
> Consequence: a malicious or broken hook in a mounted repo runs with your user rights.
> To avoid this: mount only repos you own and trust.
> Never point `INTROSPECT_SKILLS_REPO` at `~/.claude`.

The session log folders (`~/.claude/projects` and `~/.codex/sessions`) are mounted read-only.

## Executable changes are off by default

Claude Code runs hooks, `settings*.json` files and scripts.
For that reason the improver may not touch them.
It also refuses symlinks, executable files and binaries.
In a repo, the setting **Allow hooks, settings and scripts** lifts this rule.

> **NOTICE: Turning on Allow hooks, settings and scripts lets proposals change files that Claude Code executes.**
> Consequence: a proposal can add a command that runs the next time you use Claude Code.
> To avoid this: leave the setting off.
> If you turn it on, Introspect flags every such proposal and requires you to tick **I reviewed the executable change** before you accept.
> Read the diff before you tick it.

## Budget

Each judge and improver call costs tokens.
With an API key, tokens cost money.
Introspect keeps a ledger and stops when a limit is reached.

- The default limit is 1,000,000 tokens per day.
- You can add a monthly dollar ceiling in Settings.
- Work over the limit waits for the next midnight or month.
- A request that is larger than the whole limit fails with a reason.

The limits count only what Introspect itself sends.
They are not a replacement for a spending limit in your Anthropic account.

## Retention

Introspect deletes the event payloads, the session title and the judge's reasons of sessions older than 90 days.
Change this with **Keep event payloads for (days)** in Settings; the minimum is 7.
Sessions you pinned are never deleted.
A session is pinned when it is in the reference set or has a calibration label.

## Sign-in and network access

- The server listens on `127.0.0.1` only.
  Other computers cannot reach it.
- `make open` prints a link with a token.
  The browser keeps a sign-in cookie for 30 days.
- `docker compose exec introspect introspect rotate-token` signs out every browser that used the old token.
- Use a fine-grained GitHub token for pull request mode, limited to your skills and project repos (Contents and Pull requests: read and write).
  Do not use a classic token.

## Deleting your data

If you find a secret in a stored trace, add a redaction pattern for it, then delete the stored data.
`docker compose down -v` removes the Docker volume with the database, the sign-in token, the API key and the container's Claude login.
Your session log files, your skills repo and your project repos are not touched.
After the next `make up`, Introspect imports your sessions again with the current redaction rules.
