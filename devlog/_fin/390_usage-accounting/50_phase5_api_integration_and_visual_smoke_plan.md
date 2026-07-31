# Phase 5 — HTTP Integration Test and Visual Smoke

Phases 1-4 shipped the backend, GUI, and docs. Phases 1-3 had unit tests; Phase 4 only ran the build. This phase closes two verification gaps: the `/api/usage` HTTP layer is only exercised by the pure summarizer test (not the real handler), and the rendered GUI has never been opened in a browser.

## Surface

### NEW `tests/api-usage.test.ts`

Integration test that boots a real server with `startServer(0)`, hand-writes a small `usage.jsonl` fixture under a temp `OPENCODEX_HOME`, and asserts:

- `GET /api/usage` returns `200`, JSON-parseable, with the documented shape (`range`, `since`, `generatedAt`, `summary`, `days`, `models`, `providers`).
- `?range=7d` filters out older entries; `?range=30d` is the default; `?range=unknown` falls back to `30d`.
- A missing file (no `usage.jsonl` written) returns an empty summary, not 500.
- The endpoint requires the same `x-opencodex-api-key` auth as other management endpoints (verify a `401` without it and `200` with it).

This is the canonical proof that the wire path matches the unit-tested summarizer.

### Visual smoke test (no source change)

1. Launch the proxy on a free port with a known `OPENCODEX_HOME` and `OPENCODEX_API_AUTH_TOKEN`.
2. Write a small `usage.jsonl` fixture covering several days, two providers, three models — enough that the heatmap has color levels and the model list has rows.
3. Open the dashboard via `cli-jaw browser`, navigate to the Usage tab, take a screenshot, and verify the heatmap and tables render.
4. Tear down the proxy.

Result is a screenshot saved to `/tmp` plus a snapshot of the page in the chat. No file changes; this is verification evidence, not a code artifact.

## Out Of Scope

- Persistent E2E test harness (Playwright etc.) — would be its own phase.
- Heatmap visual regression baselines.
- Log rotation / pruning.

## Risks

- Auth token defaults differ between dev and tests. Mitigation: set `OPENCODEX_API_AUTH_TOKEN` and `OPENCODEX_HOME` explicitly per test.
- Browser snapshot can return stale state if the page does not finish fetching `/api/usage` before snapshot. Mitigation: wait for `.heatmap-grid` to appear before taking the screenshot.
- The proxy may collide on an in-use port. Mitigation: use `startServer(0)` for the test and a known unused high port for the visual smoke.

## Verification

- `bun test tests/api-usage.test.ts tests/usage-summary.test.ts tests/usage-log.test.ts tests/request-log.test.ts`
- `bun x tsc --noEmit`
- Visual: `cli-jaw browser snapshot` proves the Usage tab rendered with the fixture data.
- Atomic commit: `test(usage): add /api/usage HTTP integration coverage`.
