# Introspect

Local-first tool that grades your coding-agent sessions and proposes fixes to your skills and rubrics.

## Quick start

```sh
git clone <repo-url> && cd ai-introspection
make up      # builds and starts Introspect; creates the mounted folders as your user
make open    # prints the sign-in link; open it in your browser
```

Optional: `cp .env.example .env` first to set your git identity (`GIT_AUTHOR_NAME`, `GIT_AUTHOR_EMAIL`), the skills repository (`INTROSPECT_SKILLS_REPO`, default `~/.claude`, mounted at `/repos/skills`) and the folder with your project repositories (`INTROSPECT_PROJECTS_DIR`, mounted at `/repos/projects`).
If something does not work, `make doctor` checks the setup and prints one fix per problem (see ADR-0011).

## Development

Everything runs in Docker; the host needs only Docker with Compose.

- `make dev` starts the server (7317) and Vite (5173) with live reload.
- `make test` runs the unit tests; `make test-pg` runs the Postgres tests.
- `make lint`, `make build`, `make shell`, `make down` do what they say.
- `make doctor` runs `introspect doctor` in the running stack; the same report is at `GET /v1/doctor`.

Architecture: [docs/architecture/architecture-overview.md](docs/architecture/architecture-overview.md).
