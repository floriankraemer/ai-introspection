# 0012. Session intake from other people, and S3 sources

## Status

Accepted (2026-11-10)

Amends ADR-0007 and ADR-0008 for one case: in raw mode (opt-in per pusher), the server receives unredacted session logs.
Everything else in those two ADRs stays in force.

## Context

Introspect reads agent logs from local folders only (ADR-0007).
Two requests change that:

1. Other people must be able to send their sessions to one Introspect server, without giving them the UI or the full API.
2. Introspect must read session logs from an S3 bucket.

ADR-0007 and ADR-0008 sketched a team path: a client redacts, then calls `POST /v1/sessions` on a team server, which "never receives unredacted data".
That path depends on team mode (PostgreSQL, OIDC), which does not exist yet (ADR-0003, ADR-0008).

Forces in tension:

- The main API is loopback-only and trusts the local admin token (ADR-0008, ADR-0011).
  Exposing it to a network would expose the UI, the settings and the git operations.
- Redaction rules improve over time.
  The pipeline rebuilds old sessions from their log files when `REDACTION_VERSION` or an adapter version changes (ADR-0007).
  A session that arrives already redacted cannot be rebuilt that way.
- Some people will not send raw logs, because a log can hold secrets the patterns miss.
  Others cannot run a client that parses logs.
- Raw logs (intake, S3) fit the existing pipeline unchanged: files in a folder, a cursor, re-ingest on version changes, finalize, the raw-log link.

Three decisions follow, and each gets its own matrix.

## Considered options

Decision 1, how other people reach the server:

1. A separate intake listener on its own port, with personal tokens and intake routes only.
2. The main port, with intake routes next to the full API.
3. Wait for team mode and use `POST /v1/sessions` behind OIDC.

Decision 2, what a person sends:

1. Both: raw JSONL (the server redacts) and client-redacted traces (the server redacts again).
2. Raw JSONL only.
3. Client-redacted traces only.

Decision 3, how S3 logs enter the pipeline:

1. A cached folder source: a job mirrors the bucket into a folder under the data directory, and the folder is an ordinary source.
2. A direct adapter that streams objects from S3 into the pipeline.
3. No S3 code: the user mirrors the bucket into a mounted folder with `aws s3 sync` or `rclone`.

## Decision table

Decision 1, listener:

| Option | Pros | Cons |
|---|---|---|
| Separate intake port | The UI and the full API stay on loopback. The intake serves only health, its contract and two PUT routes, with no SPA and no cookies. The admin token never works there, and intake tokens never work on the main API. One compose line decides exposure (`INTROSPECT_INTAKE_BIND`). | A second listener to configure, document and put TLS in front of. |
| Same port | One port. | Exposing the intake exposes the UI, the settings and the admin surface. The loopback rule (ADR-0008) would need exceptions per route. A mistake in the guard is a full compromise. |
| Team mode | Real identity (OIDC), several replicas. | Does not exist yet. Needs PostgreSQL and an identity provider for what is one shared folder of logs. |

Decision 2, payload:

| Option | Pros | Cons |
|---|---|---|
| Both modes | Each person chooses: raw is a one-line `curl` and rebuilds on rule changes; client-redacted keeps secrets on the person's machine. | Two write paths: a file pipeline and a trace upsert. A session belongs to the path that created it. |
| Raw only | One write path. No client-side parser. | Everyone must trust the server with unredacted logs. |
| Client-redacted only | Secrets never leave the person's machine. | Needs the `introspect` CLI on every machine. Old sessions cannot be rebuilt on the server when rules improve. A second copy of the pipeline runs on every client. |

Decision 3, S3:

| Option | Pros | Cons |
|---|---|---|
| Cached folder source | Cursors, watcher, re-ingest, finalize and the raw-log link work unchanged. The adapter code does not know about S3. Deleted objects keep their local copy, so stored sessions stay explainable. | A local copy of every log under `<data>/s3/<sourceId>`, and a sync delay of up to a minute. |
| Direct adapter | No local copy. | Cursors are byte offsets in local files; they would need a second implementation for ranged reads. Re-ingest after a version change re-downloads. |
| External sync | No dependency, no credentials in Introspect. | Every user builds and runs the sync. Introspect cannot check it in the Health check. |

## Evaluation matrix

Decision 1, listener:

| Quality attribute | Weight | Separate port | Same port | Team mode |
|---|---:|---:|---:|---:|
| Security / privacy | 30% | 5 | 2 | 4 |
| Simplicity | 20% | 4 | 4 | 2 |
| Operability | 15% | 4 | 3 | 3 |
| Scalability | 15% | 3 | 3 | 5 |
| Maintainability | 20% | 4 | 3 | 3 |
| **Weighted total (max 5.00)** | 100% | **4.15** | 2.90 | 3.40 |

Decision 2, payload:

| Quality attribute | Weight | Both | Raw only | Client-redacted only |
|---|---:|---:|---:|---:|
| Security / privacy | 35% | 4 | 2 | 5 |
| Robustness (rule changes, rebuilds) | 20% | 5 | 5 | 2 |
| Simplicity | 15% | 3 | 5 | 2 |
| Ease of use for the pusher | 15% | 5 | 5 | 2 |
| Maintainability | 15% | 3 | 5 | 3 |
| **Weighted total (max 5.00)** | 100% | **4.05** | 3.95 | 3.20 |

Decision 3, S3:

| Quality attribute | Weight | Cached folder | Direct adapter | External sync |
|---|---:|---:|---:|---:|
| Simplicity | 25% | 4 | 2 | 5 |
| Robustness | 25% | 5 | 3 | 3 |
| Security / privacy | 20% | 4 | 4 | 3 |
| Operability | 15% | 4 | 3 | 2 |
| Maintainability | 15% | 4 | 2 | 5 |
| **Weighted total (max 5.00)** | 100% | **4.25** | 2.80 | 3.65 |

Scores: 1 = poor, 3 = acceptable, 5 = excellent. Weighted total = sum(weight x score) / 100.
In decision 2 the margin between both modes and raw only is small.
The tie-break is the weight on privacy: a person who does not trust the server with raw logs needs an alternative.

## Decision

### Intake listener

- A second listener, started only when `INTROSPECT_INTAKE_PORT` is set.
  It must differ from `INTROSPECT_PORT`.
  `compose.yaml` sets it to 7318 and publishes it as `${INTROSPECT_INTAKE_BIND:-127.0.0.1}:7318:7318`.
  Exposing it is an explicit edit of `.env`.
- `INTROSPECT_INTAKE_HOST` defaults to `0.0.0.0` in a container and `127.0.0.1` on a native install.
  `INTROSPECT_INTAKE_MAX_MB` caps the decompressed body and the size of an S3 object (default 64).
  `INTROSPECT_INTAKE_QUOTA_MB` caps the raw logs one person may keep (default 2048); beyond it the upload is refused with 507.
- Routes: `GET /v1/health` (open), `GET /v1/openapi.json`, `PUT /v1/intake/logs/{agent}/{path}` and `PUT /v1/intake/sessions/{id}`.
  The contract is checked in as `docs/api/intake-openapi.json`.
- Authentication: `Authorization: Bearer <intake token>`.
  Tokens are per person: `introspect intake-token create <name> [--expires 90d] [--same-person]`, `list`, `revoke <name|id>`.
  An existing name is refused without `--same-person`, and a token never attaches to the admin.
  The token is 32 random bytes in hex, shown once, and stored as a hash in `api_token`.
  Each person is an `app_user` (role `member`) and owns the sessions they push.
- Bodies may be `gzip`.
  They are decompressed while streaming and counted, so a small compressed body cannot expand past the cap (413).
- Fixed limits protect the host: a session body of at most 32 MiB and 50,000 events, two session bodies parsed at once (a third gets 503 with `Retry-After: 5`), and a disk reserve of 1 GiB (507 when free space is below the cap plus the reserve).
  Stale `.part` files are deleted after one hour.
- The listener sets a restrictive CSP and serves nothing of the main API.
- Revoking a token is the control that stops a person.
  Disabling the person's intake source does not stop uploads.
  Rate limiting belongs in the reverse proxy.
- TLS is not terminated by Introspect.
  The manual requires a reverse proxy with TLS before the intake leaves loopback, and `introspect push` refuses plain `http` to any host but loopback unless `--insecure` is passed.

### Payload modes

- Raw mode: the file is stored under `<data>/intake/<person-id>/<agent>/<path>` (folders 0700, files 0600), registered as a source of kind `intake`, and ingested by the normal pipeline.
  The path is validated (agent log layout, safe characters, `.jsonl`) and checked against symlinks.
  Uploading a grown file ingests only the new lines.
  Redaction happens on the server, as for a local folder.
  Retention deletes intake and S3 copies older than `retention.days`, except for pinned and reference sessions.
- Client-redacted mode (`introspect push --redact`): the client runs the real pipeline on an in-memory database, so redaction is the same code, with the pusher's own custom patterns from the local database (it refuses to push if that database cannot be read, and says so when it falls back to defaults).
  `push` never follows redirects.
  It sends the normalized session and events.
  The server redacts every text field again with its own rules (including custom patterns), refuses `redactionVersion: off` (422), and replaces the events in one transaction.
  Events keep their ids by `sourceKey`, so grades, pins and labels survive a re-push.
  A session that already comes from a log file on the server is refused (409).
  The reverse is refused too: a raw log for a session that a client-redacted push created, or that another person owns, gets 409 before anything is written.
  Both conflicts return the same message, so a pusher cannot probe which sessions exist.
- Sessions of both modes are finalized after 10 minutes without change.

### S3 sources

- `POST /v1/sources` accepts `{agent, s3: {bucket, prefix, region?, endpoint?, forcePathStyle?}}` next to `{agent, path}`.
  The server lists one key first and answers 422 with the AWS error when the bucket cannot be read.
  The endpoint must use https, unless it is this machine or `INTROSPECT_S3_ALLOW_HTTP=1` is set.
  A new source syncs at once, and a history import syncs S3 first.
- Credentials come only from the standard AWS chain in the server's environment.
  Introspect never stores them.
  Compose passes `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN` and `AWS_REGION`; it does not pass `AWS_PROFILE`, because `~/.aws` is not mounted.
- The job `s3_sync` runs every minute with concurrency 1.
  It lists the keys under the prefix, keeps those the agent adapter matches, and downloads an object when its size or last-modified time differs from the local copy.
  The cache is `<data>/s3/<sourceId>`.
  Objects larger than `INTROSPECT_INTAKE_MAX_MB` are skipped and reported, and objects older than the retention period are never fetched.
  A deleted object keeps its local copy.
- The Health check reports, per S3 source, whether credentials resolve and the bucket answers, and a check "Session intake" (off or on, port, address, active tokens) that warns when the intake is reachable from other machines.
- Settings shows a kind chip per source and the form **+ Add S3 bucket**.

## Consequences

- Positive: the UI and the admin API stay on loopback; the intake is a small, separately documented surface.
- Positive: raw logs and S3 reuse the pipeline, so rule and adapter upgrades rebuild those sessions.
- Positive: people who do not want to send raw logs have a path.
- Negative: raw mode stores unredacted logs on the server disk and sends them over the network.
  This amends the statement in ADR-0007 and ADR-0008 that the server never receives unredacted data.
  The amendment holds only for raw mode, which each person chooses by how they push.
  The intake needs TLS in front of any non-loopback bind, and the data directory is as sensitive as the logs themselves.
- Negative: a client-redacted session is not rebuilt on the server when the rules change; the person has to push again.
  `introspect push` does this by itself on the next run, because it compares the redaction version.
- Negative: two write paths (file pipeline and trace upsert) share one session table, with an ownership rule between them.
- Negative: S3 logs exist twice (bucket and cache), and a deleted object is not removed locally.
- Negative: the server holds logs of several people, so Sessions and Session detail show who pushed each session (`GET /v1/people`, `?person=` filter).
- Negative: the intake has quotas and limits but no rate limiting; that is left to the reverse proxy.
- Negative: a new dependency, `@aws-sdk/client-s3`.

## Revisit triggers

- Team mode ships: decide whether `POST /v1/sessions` with OIDC replaces per-person intake tokens.
- Anyone needs TLS or rate limiting inside Introspect instead of a reverse proxy.
- A bucket grows large enough that the cache or the one-minute list becomes a cost: move to ranged reads or an event feed.
- Raw mode is not used: remove it and keep client-redacted pushes only.

## Related

- ADR-0003 (persistence), ADR-0005 (jobs, reconcile), ADR-0007 (redaction; amended here for raw mode), ADR-0008 (authentication; amended here), ADR-0011 (compose ports, mounts).
- Manual: [Sharing sessions](../../manual/20-sharing-sessions.md), [Safety and privacy notes](../../manual/02-safety-and-privacy.md).
- Contract: [intake-openapi.json](../../api/intake-openapi.json).
