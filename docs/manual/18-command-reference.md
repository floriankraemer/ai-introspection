# Command reference

## `make` targets

Run these in the project folder.
All of them run in Docker, so the host needs only Docker with Compose and Make.

### For users

| Command | What it does |
|---|---|
| `make up` | Creates the mounted folders as your user, then builds and starts Introspect (`docker compose up -d --build --wait`). |
| `make open` | Prints the sign-in link: for the app, or for the development server on port 5173 while `make dev` runs. |
| `make doctor` | Runs the health checks and prints one fix line per problem. |
| `make claude-login` | Signs the container's `claude` in, once. It prints an address to open and asks for the code. |
| `make down` | Stops Introspect and the development stack. The data volume stays. |

To delete the stored data as well, run `docker compose down -v`.
This removes the database, the sign-in token, the API key and the container's Claude login.

### For development and documentation

| Command | What it does |
|---|---|
| `make dev` | Starts the server (port 7317) and the web build server (port 5173) with live reload. Stops the `make up` app first, because both use port 7317. |
| `make install` | Installs the dependencies in the development container. |
| `make lint` | Runs the linters, the formatter check, the type check and the dependency rules. |
| `make test` | Runs the unit tests. |
| `make test-pg` | Runs the tests against Postgres. |
| `make build` | Builds the server and the web interface. |
| `make shell` | Opens a shell in the development container. |
| `make e2e` | Runs the browser tests in Docker. |
| `make e2e-update` | Runs them and rewrites the visual baselines. |
| `make manual-screenshots` | Regenerates the screenshots of this manual in `docs/manual/images`. See [How to extend the manual](CONTRIBUTING.md). |

## The `introspect` command

In Docker, run it as `docker compose exec introspect introspect <command>`.
Without Docker, run `introspect <command>`.

| Command | What it does |
|---|---|
| `serve` | Starts the server. The Docker image runs this by default. |
| `open` | Prints the sign-in link. |
| `rotate-token` | Creates a new token and prints a new sign-in link. Every browser and script that used the old token is signed out. |
| `doctor` | Prints the health checks. Exit code 1 if any check fails. |
| `judge-login` | Signs the judge's `claude` in. Its login is kept apart from yours. |
| `import` | Imports the sessions from all registered sources. |
| `import --agent claude_code --path <folder>` | Imports one folder. `--agent` is `claude_code` or `codex`. |
| `grade --session <id>` | Grades one session. |
| `grade --since <time>` | Grades the sessions of a period. Use `12h`, `7d` or `2w`. |
| `grade --all` | Grades all sessions. |
| `improve` | Queues an improver run for the running server. |
| `improve --now` | Runs the improver here and prints a summary. |
| `improve --since <time>` | Looks at failing grades from this period. The default is `24h`. |
| `scan` | Queues a scan for manual edits in the registered repos. |

`grade` ignores the sampling rule, so it grades every session you name.
Add `--policy` to keep the rule.
It prints how many sessions it graded, skipped, deferred for budget and failed.
Exit code 1 if any grading failed.

`improve --now` prints, for example, "Improver run succeeded: 1 proposals from 2 clusters (15 failing grades)."
It lists excluded rubrics ("not calibrated yet"), skipped sessions and the outcome of each cluster.

### Examples

```sh
docker compose exec introspect introspect grade --since 7d
docker compose exec introspect introspect improve --now
docker compose exec introspect introspect scan
```
