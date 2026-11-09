# Introspect

Local-first tool that grades your coding-agent sessions and proposes fixes to your skills and rubrics.

## Quick start

```sh
git clone <repo-url> && cd ai-introspection
docker compose up
# open http://localhost:7317
```

Run `make up` instead if you want the source folders created as your user (see ADR-0011).

## Development

Everything runs in Docker; the host needs only Docker with Compose.

- `make dev` starts the server (7317) and Vite (5173) with live reload.
- `make test` runs the unit tests; `make test-pg` runs the Postgres tests.
- `make lint`, `make build`, `make shell`, `make down` do what they say.

Architecture: [docs/architecture/architecture-overview.md](docs/architecture/architecture-overview.md).
