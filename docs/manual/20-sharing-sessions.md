# Sharing sessions

By default Introspect reads the session logs on your own computer.
With the intake, other people can send their sessions to your Introspect server.
Two roles are involved: the admin who runs the server, and each person who pushes sessions.

Read the [safety notes](02-safety-and-privacy.md) first.
One of the two ways to push sends unredacted logs over the network.

## How it works

The server listens on a second port, the **intake port** (7318).
The Introspect screens and the full API stay on port 7317, on your computer only.
The intake port accepts uploads and nothing else.

Each person gets a personal **intake token**.
Sessions a person pushes belong to that person.

There are two ways to push:

| Way | What leaves the person's computer | Who redacts | Needs |
|---|---|---|---|
| Raw log (`curl`, or `introspect push`) | The log file, unredacted | The server, when it ingests the file | `curl`, or the `introspect` command |
| Redacted session (`introspect push --redact`) | The session, redacted on the person's computer | The person's computer, then the server again | The `introspect` command |

The server keeps a raw log under `intake/` in its data folder, so it can rebuild the session when its redaction rules improve.
It keeps no log for a redacted session.
Then the person has to push again after a rule change, and `introspect push` does that by itself.

## For the admin: set up the intake

1. Decide who may reach the server.

   The intake port is bound to `127.0.0.1` by default.
   Only your own computer can use it.

2. Put TLS in front of the port before you expose it.

   Run a reverse proxy (for example Caddy or nginx) that serves `https://` and forwards to port 7318.
   Do not publish the port to a network without TLS.
   Tokens and raw logs would travel in clear text.

3. Open the port to your network.

   Add this line to `.env`:

   ```sh
   INTROSPECT_INTAKE_BIND=0.0.0.0
   ```

   Then run `make up`.
   The port 7318 is now reachable from other computers, and the reverse proxy can forward to it.
   If the proxy runs on the same computer, keep the default `127.0.0.1` and let only the proxy reach the port.

4. Create a token for each person.

   You can do this in **Settings**, card **People who push**, with **+ Add person**.
   Or use the command line:

   ```sh
   docker compose exec introspect introspect intake-token create alice --expires 90d
   ```

   The command prints the token once.
   Send it to Alice over a safe channel.
   You cannot show it again.
   If it is lost, revoke it and create a new one.
   Without `--expires` the token never expires.
   A name that already has a token is refused.
   To give the same person a second token, add `--same-person`.
   A token never works as the admin.

5. Check the tokens.

   The **People who push** card lists them with their status.
   On the command line:

   ```sh
   docker compose exec introspect introspect intake-token list
   ```

   Each line shows the name, the person, the creation date, the expiry and whether it is revoked.

6. Revoke a token when a person leaves, or when a token leaks.

   Click **Revoke** on the **People who push** card, or use the command line:

   ```sh
   docker compose exec introspect introspect intake-token revoke alice
   ```

   The next push with that token answers 401.
   Revoking is the control that stops a person.
   A pushed source cannot be disabled, because that would not stop their uploads.
   Sessions already pushed stay.

The upload limit is 64 MB per file after decompression, and each person may keep 2048 MB of raw logs.
Change them with `INTROSPECT_INTAKE_MAX_MB` and `INTROSPECT_INTAKE_QUOTA_MB` in `.env`.
The server also stops taking logs when less than 1 GiB of disk would remain, and parses at most two redacted sessions at once.
Intake copies older than the retention period (90 days by default) are deleted, except those of pinned sessions.
The Health check has a line **Session intake**.
It shows whether the intake is on, its port and address, and the number of active tokens.
It warns when other computers can reach the port, as a reminder to set up TLS.
See the [configuration reference](15-configuration-reference.md).

Put rate limiting in the reverse proxy.
Introspect limits sizes and storage, but it does not limit how often a token may push.

> **NOTICE: Raw logs are stored on the server.**
> Hazard: a raw log can hold secrets that redaction does not find.
> Consequence: the server's data volume holds the unredacted logs of everyone who pushes raw.
> To avoid this: ask people to push with `--redact`, protect the volume like a credential, and revoke tokens you no longer need.

## For each person: push your sessions

You need the server address (for example `https://introspect.example.com`) and your token from the admin.

### With the `introspect` command

`introspect push` needs the `introspect` command on your computer.
See [Running without Docker](17-running-without-docker.md) to install it.
Run it on the computer where Claude Code or Codex writes its logs.

1. Put the address and the token in your environment.

   ```sh
   export INTROSPECT_PUSH_URL=https://introspect.example.com
   export INTROSPECT_PUSH_TOKEN=<your token>
   ```

   Do not use `--token`.
   It lands in your shell history and in the process list.

2. See what would be sent.

   ```sh
   introspect push --dry-run
   ```

   The command lists each file as "would push", and ends with a line like `would push 12, unchanged 0, failed 0`.
   Nothing is sent.

3. Push the sessions.

   ```sh
   introspect push --redact
   ```

   With `--redact`, the command applies the custom redaction patterns of your own Introspect, if you run one, and the default rules.
   If it cannot read your local database, it pushes nothing and says why.
   If you have no local database, it says that it uses the default rules only.
   It prints "pushed" for each file and ends with `pushed 12, unchanged 0, failed 0`.
   Leave out `--redact` to send raw logs.

By default `introspect push` looks in `~/.claude/projects` and `~/.codex/sessions`.
Use `--dir claude_code=<folder>` or `--dir codex=<folder>` for other folders.
You can repeat `--dir`.
Use `--since 7d` (or `12h`, `2w`) to skip older files.

The command remembers what it sent in `~/.introspect/push-state.json`, per server address.
A second run sends only files that changed.
It also sends a session once more when the session has been quiet for 10 minutes, so the server can close it.
It exits with code 1 when a file fails, and prints the reason.
It never follows a redirect, so a misplaced address cannot hand your token to another host.
When the server answers 503, wait the seconds in `Retry-After` and run it again.

> **NOTICE: `introspect push` refuses plain `http://` to another computer.**
> Raw logs hold secrets, so the command wants TLS.
> `http://localhost` works.
> `--insecure` allows plain `http://` to any host.
> Use it only on a network you control.

### Run it on a schedule

Add a line to your crontab (`crontab -e`) to push every 15 minutes:

```cron
INTROSPECT_PUSH_URL=https://introspect.example.com
INTROSPECT_PUSH_TOKEN=<your token>
*/15 * * * * introspect push --redact >> ~/.introspect/push.log 2>&1
```

Cron does not read your shell profile, so the two variables go in the crontab itself.
Make the crontab readable only by you, as it is by default.
If cron cannot find `introspect`, write its full path.

### With `curl`

Use this to push one raw log without the `introspect` command.
The path after `/logs/` is the log's path below the agent's log folder:
`<project>/<session>.jsonl` for Claude Code, below `~/.claude/projects`, and `YYYY/MM/DD/rollout-….jsonl` for Codex, below `~/.codex/sessions`.

1. Set the token.

   ```sh
   export INTROSPECT_PUSH_TOKEN=<your token>
   ```

2. Send the file.

   ```sh
   gzip -c ~/.claude/projects/my-proj/1234.jsonl | curl -fsS -X PUT \
     -H "Authorization: Bearer $INTROSPECT_PUSH_TOKEN" \
     -H "Content-Type: application/x-ndjson" -H "Content-Encoding: gzip" \
     --data-binary @- "https://introspect.example.com/v1/intake/logs/claude_code/my-proj/1234.jsonl"
   ```

   The server answers with the session id and `"jobQueued"`, for example `{"sessionId":"…","jobQueued":true}`.
   The session appears on the Sessions screen shortly after.

Optional: add `-H "X-Introspect-Mtime: <epoch milliseconds>"` with the file's last-write time.
Without it, the server uses the time of the upload.
Send the same file again after it grew: the server reads only the new lines.
Send the same bytes again: nothing changes.

The path may use letters, digits, `.`, `_` and `-`, and must end in `.jsonl`.
Other paths are refused with 422.
The full contract is in `docs/api/intake-openapi.json`, and the server serves it at `/v1/openapi.json` on the intake port.

## Where the sessions appear

Pushed sessions show up on the [Sessions](06-screen-sessions.md) screen like any other session, and the judge grades them by the same rules.
In [Settings](11-screen-settings.md), the **Sources** card lists the folder of each pusher with the chip **Pushed** and the text "Pushed by <name>".
Once sessions of more than one person exist, the Sessions screen gets a **Person** column and a **Person** filter, and Session detail shows "Pushed by <name>".

A session keeps the way it first arrived.
The server refuses a raw log for a session that was pushed with `--redact`, and a redacted push for a session it reads from a raw log (409).
It also refuses a session that another person pushed (409), and it stores nothing in either case.
`introspect push` reports such a file as failed and says why.
Use one way per session.

If a push fails, see [Troubleshooting](16-troubleshooting.md).
