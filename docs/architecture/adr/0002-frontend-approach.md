# 0002. React SPA built with Vite, served as static assets by the backend

## Status

Accepted (2026-11-08)

## Context

The six mockups (`docs/mockups/*.dc.html`) define the UI needs:

- Sessions: pass-rate cards, search plus two select filters, a sortable table with a chip per rubric, multi-select for "Grade selected".
- Session detail: a trace timeline of 186+ events with filter tabs (All / Errors / Evidence only), collapsed runs of repeated failures, per-rubric grade cards with expandable evidence, "Judge was wrong" and "Add to calibration set" actions.
- Rubrics: a markdown editor, numeric threshold and target inputs, dry-run trigger, calibration table with an 8/10 gate.
- Proposals: an inbox with tabs, rationale, evidence links, a unified diff view, accept / edit / reject actions.
- Trends: a weekly line chart per rubric with a target line and dashed merge markers, a change log table.
- Settings: forms with radio groups, a numeric budget, schedule choices, paths, and a disabled team-mode panel.

The UI talks to the HTTP API only (plan principle), in both local and team mode.
The UI must ship inside the npm package and inside the container without a separate frontend server.

## Considered options

1. React 19 SPA built with Vite.
2. Svelte 5 SPA.
3. Vue 3 SPA.
4. Server-rendered HTML with HTMX, plus JavaScript islands for editor, chart and timeline.
5. Next.js with server rendering.

## Decision table

| Option | Pros | Cons |
|---|---|---|
| React 19 SPA (Vite) | Largest ecosystem for every needed widget (CodeMirror 6 bindings, Recharts, TanStack Query/Router/Virtual). Static build fits the "API-only UI" principle and embeds in the npm package. Best-known testing story (Testing Library, Playwright). Coding agents produce idiomatic React reliably, which lowers long-term maintenance cost. | More boilerplate than Svelte. Bundle larger than Svelte or HTMX (target ≤ 350 KB gzip, see overview). |
| Svelte 5 SPA | Smallest bundles, concise components. | Smaller ecosystem for editor/chart/virtual-list integrations. Fewer engineers and less agent fluency. |
| Vue 3 SPA | Good ergonomics, solid ecosystem. | Ecosystem for our specific widgets smaller than React's; no decisive advantage over React. |
| HTMX + islands | Minimal client JS for tables and forms. | The three richest screens (timeline, editor, chart) need JS islands anyway, so two rendering paradigms. Server templates couple the UI to the backend process, which weakens the "UI talks to the API" seam. Harder component-level testing. |
| Next.js (SSR) | Strong ecosystem. | Introduces a second server framework and Node server runtime next to Hono; SSR adds no value for a localhost tool; complicates single-process packaging. |

## Evaluation matrix

| Quality attribute | Weight | React 19 SPA (Vite) | Svelte 5 SPA | Vue 3 SPA | Server-rendered HTMX + JS islands | Next.js (SSR) |
|---|---:|---:|---:|---:|---:|---:|
| Simplicity | 15% | 3 | 4 | 4 | 4 | 2 |
| Maintainability | 20% | 5 | 4 | 4 | 3 | 3 |
| Performance | 10% | 4 | 5 | 4 | 4 | 4 |
| Testability | 15% | 5 | 4 | 4 | 3 | 4 |
| Ecosystem / LLM-SDK fit | 20% | 5 | 3 | 4 | 2 | 5 |
| Security / privacy | 10% | 4 | 4 | 4 | 4 | 3 |
| Portability / run-everywhere | 5% | 5 | 5 | 5 | 5 | 3 |
| Distribution / install experience | 5% | 5 | 5 | 5 | 5 | 2 |
| **Weighted total (max 5.00)** | 100% | **4.50** | 4.00 | 4.10 | 3.35 | 3.45 |

Scores: 1 = poor, 3 = acceptable, 5 = excellent. Weighted total = sum(weight x score) / 100.

## Decision

Build the UI as a React 19 single-page application with Vite, TypeScript strict mode and these libraries:

- TanStack Query 5 for server state (polling where the UI needs freshness, see ADR-0005), TanStack Router 1 for typed routes.
- CodeMirror 6 with the markdown language for the rubric editor and for "Edit first" on proposals.
- Recharts 3 for the trend chart (line series, target `ReferenceLine`, dashed merge-marker `ReferenceLine`s).
- TanStack Virtual for the trace timeline (sessions with up to 10,000 events).
- Tailwind CSS 4 with design tokens taken from the mockups (pass/fail/n-a chip colours, neutral greys).
- An in-house unified-diff renderer (about 50 lines) instead of a diff library, because the mockup needs only add/delete/context lines.

The API types come from the shared zod schemas (ADR-0008); no hand-written fetch types.
The backend serves the built assets from `/` and the API from `/v1`; unknown non-API paths return `index.html`.

## Consequences

- Positive: one UI codebase for local and team mode; team mode adds only an auth redirect and role-aware controls.
- Positive: the UI can be developed and tested against a mocked API.
- Negative: a JavaScript bundle must be kept within budget; CI fails if the gzip size of the initial route exceeds 350 KB.
- Negative: no server-side rendering, so the first paint depends on JavaScript; acceptable for a developer tool on localhost or an authenticated team server.

## Revisit triggers

- The initial bundle cannot be kept under 350 KB gzip without dropping a required widget.
- Team mode needs public, crawlable pages (not in the plan).

## Related

- ADR-0001 (runtime), ADR-0008 (API contract), overview section "Screen to API mapping".
