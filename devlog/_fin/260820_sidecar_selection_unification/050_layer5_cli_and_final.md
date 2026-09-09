# 050 — Layer 5: CLI --list + docs + top-layer full validation (wp6)

Branch: codex/sidecar-cli (base: codex/sidecar-write-gates).

## CLI (extend EXISTING command — no new top-level command; src/cli/sidecar.ts WITHDRAWN)
- src/cli/agent.ts `ocx agent sidecar <status|web|vision>` gains `--list`: prints the candidate sets from GET /api/sidecar-settings (webSearchModels / visionModels) — the exact sets the GUI sees, produced by the same server functions.
- Parse --list BEFORE the existing rejectArgs call (auditor note).
- Writes need no client-side gate: L4's server-side gate on the shared PUT covers CLI automatically.

## Docs
- docs-site: web-search + vision pages updated (selection rules, auth slots, --list). English source only.

## Final verification (top layer)
- bun run typecheck && bun run test (FULL suite) && bun run privacy:scan && bun run lint:gui
- gh pr list chain state recorded in goalplan c7.

## Tests: extend existing CLI/agent tests for --list output parity with GET payload.

