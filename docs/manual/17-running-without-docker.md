# Running without Docker

Docker is the supported way to run Introspect, and the other pages assume it.
This page is for people who prefer a plain Node.js process.
The code is the same.
What differs is isolation: the process runs with all your user rights, and no read-only mounts protect your session logs.

> **NOTICE: This path has not been tested as often as the Docker path.**
> Introspect is not published as a package yet, so you build it from the repository.
> If a step fails, use the Docker path.

## Requirements

- Node.js 24 or newer
- `corepack` (it comes with Node.js) to get `pnpm`
- git
- Optional: the `claude` command, for the **Local claude CLI** judge, and `gh`, for pull request mode

## Install

1. Clone the repository and change into it.

   ```sh
   git clone https://github.com/floriankraemer/ai-introspection.git ai-introspection
   cd ai-introspection
   ```

   You are in the project folder.

2. Install the dependencies.

   ```sh
   corepack enable
   pnpm install
   ```

   `node_modules` appears.

3. Build the server and the web interface.

   ```sh
   pnpm build
   ```

   The folders `dist` and `web/dist` appear.

4. Start the server.

   ```sh
   node dist/cli.js serve
   ```

   The server runs in this terminal and listens on `127.0.0.1:7317`.
   Keep the terminal open, or run the command under a service manager.

5. In a second terminal, print the sign-in link.

   ```sh
   node dist/cli.js open
   ```

   The terminal prints `http://127.0.0.1:7317/auth#<token>`.

6. Open the link in your browser and complete the [setup wizard](05-setup-wizard.md).

If you link the package with `pnpm link --global`, you can type `introspect` instead of `node dist/cli.js`.
The [command reference](18-command-reference.md) uses `introspect`.

## Differences from the Docker setup

| Topic | Docker | Without Docker |
|---|---|---|
| Data folder | Volume `introspect_data`, at `/data` | `~/.introspect` (change with `INTROSPECT_DATA_DIR`). The folder is private to your user. |
| Session logs | Mounted read-only at `/sources/…` | Read directly from `~/.claude/projects` and `~/.codex/sessions` |
| Skills repo | Mounted at `/repos/skills` | Any git repo you name in the wizard |
| File watching | Polling | Native file events, plus a scan every 60 seconds |
| Claude login | `make claude-login` in the container | `introspect judge-login` |
| Settings from `.env` | Read by Compose | Set as environment variables before you start the server |
| Database | SQLite in the volume | SQLite file in the data folder. Set `DATABASE_URL` to a `postgres://` address for Postgres. |

Variables you can set in the environment of the server:

| Variable | Meaning |
|---|---|
| `INTROSPECT_DATA_DIR` | Data folder. Default `~/.introspect`. |
| `INTROSPECT_PORT` | Port. Default 7317. |
| `INTROSPECT_HOST` | Must be a loopback address (`127.0.0.1`, `localhost` or `::1`). |
| `DATABASE_URL` | A `postgres://` address, or the path of a SQLite file. |
| `INTROSPECT_CLAUDE_HOME` | The private home of the claude judge. |
| `GH_TOKEN` | GitHub token for pull request mode. |
| `TZ` | Time zone of the budget windows. |

> **NOTICE: Introspect writes to the skills repo you choose, and runs git there.**
> Without Docker there is no mount to protect other folders.
> Choose a repo you own.
> Do not choose `~/.claude`, which holds your Claude credentials.
> Do not copy your own login to the judge, unless you accept that both clients share one refresh token and can sign each other out.
> `INTROSPECT_CLAUDE_CREDENTIALS` does exactly that, once.
> Use `introspect judge-login` instead.

## Update

1. Run `git pull` in the project folder.

   The source is up to date.

2. Run `pnpm install` and `pnpm build`.

   The `dist` folder is rebuilt.

3. Restart the server.

   Stop it with Ctrl+C and run `node dist/cli.js serve` again.
   Your data stays in the data folder.
