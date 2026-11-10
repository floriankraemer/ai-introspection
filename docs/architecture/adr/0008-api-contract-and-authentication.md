# 0008. REST/JSON `/v1` API with an OpenAPI 3.1 contract from zod; loopback token auth locally, OIDC for teams

## Status

Accepted (2026-11-08)

## Context

The plan requires the UI to talk to an HTTP API rather than the database, and the contract (`/v1/sessions`, `/v1/grades`, `/v1/proposals`, `/v1/trends`) to be identical in local and team mode.
API clients: the SPA, the `introspect` CLI, the team-mode shipper (local install pushing sessions), GitHub App webhooks, and ad-hoc `curl`.
Local mode is single-user with "no auth", but a localhost HTTP server is reachable from any web page in the user's browser (cross-site requests, DNS rebinding) and from other local users.
Team mode needs SSO/OIDC and roles: member, rubric owner, admin.

Two decisions are bundled because the contract style constrains auth: the API style, and team-mode authentication.

## Considered options

API style:

1. REST/JSON under `/v1`, with an OpenAPI 3.1 document generated from zod schemas.
2. tRPC.
3. GraphQL.
4. gRPC or Connect.

Team authentication:

1. Built-in OIDC client (`openid-client`), server-side sessions, personal access tokens for CLI and shipper.
2. Reverse-proxy authentication (for example oauth2-proxy) with trusted identity headers.
3. A hosted identity vendor SDK.
4. A full authentication framework library.

## Decision table (API style)

| Option | Pros | Cons |
|---|---|---|
| REST/JSON + OpenAPI 3.1 from zod | Every client type can use it, including webhooks and `curl`. Contract-first via `@hono/zod-openapi`: one zod schema validates requests, types handlers, generates the OpenAPI document and the typed client. Cache- and proxy-friendly. | Some endpoint design discipline needed (pagination, errors, idempotency). |
| tRPC | Excellent TypeScript DX. | TypeScript-only, not a public contract for shippers, webhooks or other languages. |
| GraphQL | Flexible reads for the dashboard. | Schema, resolvers and query cost limits add complexity; no need for client-shaped queries across six screens. |
| gRPC / Connect | Strong contracts, streaming. | Browser and webhook support need adapters; heavier tooling. |

## Evaluation matrix (API style)

| Quality attribute | Weight | REST/JSON /v1, OpenAPI 3.1 from zod | tRPC | GraphQL | gRPC / Connect |
|---|---:|---:|---:|---:|---:|
| Maintainability | 20% | 4 | 4 | 3 | 4 |
| Client reach (browser, CLI, shipper, webhooks, curl) | 15% | 5 | 2 | 4 | 3 |
| Simplicity | 15% | 4 | 5 | 2 | 3 |
| Testability | 15% | 5 | 4 | 4 | 4 |
| Security / privacy | 15% | 4 | 4 | 3 | 4 |
| Ecosystem / LLM-SDK fit | 10% | 5 | 3 | 4 | 3 |
| Scalability (team mode) | 10% | 4 | 4 | 4 | 5 |
| **Weighted total (max 5.00)** | 100% | **4.40** | 3.75 | 3.35 | 3.70 |

Scores: 1 = poor, 3 = acceptable, 5 = excellent. Weighted total = sum(weight x score) / 100.

## Decision table (team authentication)

| Option | Pros | Cons |
|---|---|---|
| Built-in OIDC client + sessions + PATs | Works with any OIDC provider (Entra ID, Google, Okta, Keycloak) on any host. Small surface: authorization-code flow with PKCE, an HttpOnly session cookie, hashed PATs. Roles stored in our DB. | We own session and token handling code (well understood, testable). |
| Reverse-proxy auth | No auth code in the app. | Security depends on deployment correctness (header spoofing if the proxy is bypassed); CLI and shipper tokens still needed. |
| Hosted vendor SDK | Fast, polished. | Vendor lock-in and an external dependency for self-hosted teams; data residency questions. |
| Full auth framework | Many features. | Brings password, social and organisation features we do not need; larger attack surface. |

## Evaluation matrix (team authentication)

| Quality attribute | Weight | Built-in OIDC client (openid-client) + app sessions + PATs | Reverse-proxy auth (oauth2-proxy), trust headers | Hosted identity vendor SDK (Auth0, Clerk) | Full auth framework (Better Auth) |
|---|---:|---:|---:|---:|---:|
| Security / privacy | 30% | 4 | 3 | 4 | 4 |
| Simplicity | 20% | 4 | 4 | 4 | 3 |
| Portability / run-everywhere | 20% | 5 | 3 | 2 | 5 |
| Operability | 15% | 4 | 3 | 4 | 4 |
| Maintainability | 15% | 4 | 4 | 3 | 3 |
| **Weighted total (max 5.00)** | 100% | **4.20** | 3.35 | 3.45 | 3.85 |

Scores: 1 = poor, 3 = acceptable, 5 = excellent. Weighted total = sum(weight x score) / 100.

## Decision

Contract:

- REST/JSON under `/v1`, defined with `@hono/zod-openapi`; the OpenAPI 3.1 document is served at `/v1/openapi.json` and checked into the repository; CI fails on unreviewed contract changes.
- The SPA and CLI use a typed client generated from the same schemas.
- Lists use cursor pagination (`?cursor=…&limit=…`, default 50, maximum 200).
- Errors use RFC 9457 `application/problem+json`.
- Long-running actions (grade, re-grade, dry-run, import, improver run) return `202 Accepted` with a job resource (`GET /v1/jobs/{id}`).
- `POST /v1/sessions` is an idempotent upsert keyed by the client-supplied UUIDv5 session ID, accepting a session with its events in one request (gzip, maximum 20 MB).
- Versioning: additive changes only within `/v1`; a breaking change introduces `/v2` and keeps `/v1` for at least one minor release.
- The endpoint list per screen is in the overview ("Screen to API mapping").

Local mode authentication (`auth = local-token`):

- Bind to `127.0.0.1` only (refuse to start on a non-loopback address in local mode).
- Reject requests whose `Host` header is not `127.0.0.1:<port>` or `localhost:<port>` (DNS-rebinding defence), and state-changing requests whose `Origin` does not match.
- A random 256-bit token is generated per install and stored in `<data_dir>/token` with file mode 0600. The CLI sends it as a bearer token. `introspect open` opens `http://127.0.0.1:<port>/auth#<token>`; the page exchanges it for an HttpOnly, `SameSite=Strict` cookie.

Team mode authentication (`auth = oidc`):

- Browser: OIDC authorization-code flow with PKCE via `openid-client` 6; server-side session (stored in Postgres), HttpOnly, Secure, `SameSite=Lax` cookie, 12-hour idle timeout.
- CLI and shipper: OAuth device authorization flow against the same provider ("Connect with SSO" in Settings), exchanged for a workspace-scoped personal access token; tokens stored as SHA-256 hashes, revocable, 90-day expiry.
- GitHub App webhooks: HMAC-SHA256 signature verification; delivery IDs de-duplicated through job idempotency keys.
- Authorisation: roles `member`, `rubric_owner`, `admin`, checked in application services; Postgres row-level security on `workspace_id` as a second line, set per transaction with `SET LOCAL app.workspace_id`.
- Privacy: per-user "Share my sessions" opt-out is enforced at the shipper (nothing sent) and at the server (rejected). Trend and pass-rate endpoints aggregate by workspace, rubric and repository only; no endpoint ranks users.

## Consequences

- Positive: one contract for all clients and both modes; the shipper is just another API client.
- Positive: local mode is protected against browser-borne attacks without any login.
- Negative: endpoint design discipline (pagination, problem details, idempotency) is required on every endpoint; a lint rule over the OpenAPI document enforces it.
- Negative: we own OIDC session and PAT code; it gets a dedicated security review (`security-expert`) before Phase 5 ships.

## Revisit triggers

- A team needs SCIM provisioning or more than three roles.
- The UI needs push updates (see ADR-0005 revisit triggers).

## Related

- ADR-0002 (UI client), ADR-0004 (bind address and modes), ADR-0007 (shipping), ADR-0009 (module APIs behind the HTTP layer).
- ADR-0012 adds a separate intake listener with per-person tokens, and amends the "server never receives unredacted data" rule for raw mode.
