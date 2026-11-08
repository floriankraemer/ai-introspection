# 0001. TypeScript on Node.js LTS with Hono as runtime and backend framework

## Status

Accepted (2026-11-08)

## Context

The app (Introspect, CLI `introspect`) must run on one laptop (macOS, Linux, and Windows through WSL2) and as a team server, from one codebase, with the mode switched by configuration.
Native Windows (outside WSL2) is not supported in v1; on Windows, Introspect runs inside WSL2 as a Linux program.
The build plan leaves the stack open: TypeScript (Node + Hono + React) or Python (FastAPI + HTMX).
Forces in tension:

- The improver is an agent with repository access; the judge is a structured LLM call. Both need first-class Anthropic SDK support, and the improver benefits from the Claude Agent SDK, which ships official packages for TypeScript and Python only.
- "Run everywhere" favours runtimes with mature macOS and Linux support (WSL2 counts as Linux) and a simple install.
- The frontend (ADR-0002) will be TypeScript in every realistic option, so a TypeScript backend lets API schemas be shared without code generation across languages.
- A single static binary is the best install story, but it conflicts with native modules (SQLite driver) and the Agent SDK, which are JavaScript or Python libraries.
- The user weighs quality, robustness, scalability and maintainability above development cost.

## Considered options

1. TypeScript on Node.js 24 LTS with Hono 4.
2. TypeScript on Bun with Hono 4.
3. Python 3.13 with FastAPI.
4. Go with `net/http` (plus a small router).
5. Rust with axum.

## Decision table

| Option | Pros | Cons |
|---|---|---|
| TypeScript / Node.js 24 LTS + Hono | Official `@anthropic-ai/sdk` and `@anthropic-ai/claude-agent-sdk`. One language across UI, API, CLI and shared zod schemas. Node has first-class Windows/macOS/Linux builds and is already present on most machines that run coding agents. Hono runs on web-standard `Request`/`Response`, so the HTTP layer is runtime-portable. Mature tooling (Vitest, Playwright, ESLint, dependency-cruiser). | Requires a Node runtime on the target machine (no single binary in v1). Native module (`better-sqlite3`) needs prebuilt binaries per platform. Dependency hygiene in npm needs active care (lockfile, audit). |
| TypeScript / Bun + Hono | `bun build --compile` produces a single executable with cross-compilation. Built-in SQLite. Fast startup. | Node API compatibility is high but not complete; the Agent SDK and native drivers are tested primarily against Node. Smaller operational track record for long-running servers. Security patch cadence tied to one vendor. |
| Python 3.13 + FastAPI | Official Anthropic SDK and Agent SDK. Strong data tooling for later analysis. | Two languages (Python backend, TypeScript UI) and duplicated schemas. Install story on Windows (interpreter versions, `pipx`/`uv`) is the weakest of all options. Weaker static typing at module boundaries than TypeScript strict mode. |
| Go + net/http | Single static binary for all platforms, low memory, excellent operability. | No Claude Agent SDK; the improver would have to shell out to `claude -p` only or reimplement an agent loop. Still needs a TypeScript toolchain for the SPA, so two languages. |
| Rust + axum | Single binary, best performance and memory safety. | No Agent SDK, no official Anthropic Rust SDK; highest complexity for a CRUD-plus-jobs app whose bottleneck is LLM latency, not CPU. Two languages. |

## Evaluation matrix

| Quality attribute | Weight | TypeScript / Node.js 24 LTS + Hono | TypeScript / Bun + Hono | Python 3.13 + FastAPI | Go + net/http | Rust + axum |
|---|---:|---:|---:|---:|---:|---:|
| Portability / run-everywhere | 15% | 5 | 4 | 4 | 5 | 4 |
| Simplicity | 10% | 4 | 5 | 4 | 4 | 2 |
| Maintainability | 15% | 4 | 3 | 3 | 4 | 3 |
| Performance | 5% | 4 | 5 | 3 | 5 | 5 |
| Scalability (team mode) | 5% | 4 | 4 | 3 | 5 | 5 |
| Security / privacy | 10% | 4 | 3 | 4 | 4 | 5 |
| Operability | 5% | 4 | 4 | 3 | 5 | 5 |
| Testability | 10% | 5 | 4 | 4 | 4 | 4 |
| Ecosystem / LLM-SDK fit | 15% | 5 | 4 | 5 | 2 | 1 |
| Distribution / install experience | 10% | 4 | 5 | 2 | 5 | 5 |
| **Weighted total (max 5.00)** | 100% | **4.40** | 4.00 | 3.65 | 4.10 | 3.55 |

Scores: 1 = poor, 3 = acceptable, 5 = excellent. Weighted total = sum(weight x score) / 100.

Weights reflect the user's priorities: portability, maintainability and LLM-SDK fit carry the most weight; raw performance carries little because the workload is I/O- and LLM-bound (a judge call takes seconds; ingest is ~2 MB/s of JSONL, see the overview NFRs).

## Decision

Use TypeScript (strict mode, ESM) on Node.js 24 LTS, tracking the Active LTS line, with Hono 4 on `@hono/node-server` for HTTP.
The same package provides the server, the background roles and the CLI (`introspect`).

Distribution story:

- Local: published to npm; installed with `npm install -g <package>` (or run with `npx`). The SPA is pre-built and embedded in the package as static assets.
- Cloud: one OCI image built from the same package (ADR-0004).
- Single binary: deferred. Node's Single Executable Applications can embed the app, but native addons and the Agent SDK make it fragile today.

## Consequences

- Positive: one language and one type system end to end; zod schemas define API contracts, DB row types and UI types once.
- Positive: both LLM transports the Settings screen offers (API key and local `claude` CLI) are implementable with official SDKs (ADR-0006).
- Positive: Hono keeps a cheap escape hatch to Bun or other runtimes if the single-binary need becomes real.
- Negative: users need Node.js 24+ installed; the CLI checks the version at startup and prints an actionable error.
- Negative: the native SQLite driver ties releases to the platforms its prebuilt binaries cover (macOS arm64/x64, Linux x64/arm64 glibc and musl; WSL2 uses the Linux binaries); other platforms need a compiler toolchain.

## Revisit triggers

- Native Windows support (outside WSL2) is requested: check the native module and path handling on Windows and add Windows to the CI matrix; the runtime choice itself does not change.
- More than 20 % of install issues in the first 3 months relate to Node presence or native module builds: re-evaluate Bun `--compile` or Node SEA for a single binary.
- The Claude Agent SDK is no longer needed by the improver (ADR-0006 switches to CLI-only): Go becomes competitive again for its binary story.
- Node removes or breaks APIs that Hono's Node adapter relies on.

## Related

- ADR-0002 (frontend), ADR-0003 (persistence), ADR-0004 (deployment and packaging), ADR-0006 (LLM integration).
