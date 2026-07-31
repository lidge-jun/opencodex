# Phase 6 — Full Codex CLI E2E (real `codex exec` → ocx → kiro)

## Symptom reported by user
Interactive Codex (model `kiro/claude-sonnet-4.6`) showed "Reconnecting… high demand,
temporary errors" and never produced output. "안되는데?" → "codex exec으로 성공시켜봐".

## Root cause (confirmed, not guessed)
The proxy listening on `localhost:10100` was the **globally-installed published build**
`/opt/homebrew/lib/node_modules/@bitkyc08/opencodex/dist` (v2.6.0) — which has **no kiro
adapter**. Evidence: `grep 'kiro/' /Users/jun/.codex/opencodex-catalog.json` returned
**empty** → kiro models were never advertised to Codex, so `kiro/*` requests failed.
My kiro implementation lives only on `feat/kiro-on-dev` in the workspace, never published.

## Fix
Replace the running proxy on 10100 with the **branch build**:
1. `kill -9` the stale published proxy holding 10100.
2. `bun run src/cli.ts start --port 10100` (dev run — `bin/ocx.mjs` is the npm shim that
   execs the *bundled published* package, so dev MUST use `src/cli.ts` directly).
3. Branch `start` auto-injected **23 models incl. 11 `kiro/*`** into the Codex catalog
   (`/Users/jun/.codex/opencodex-catalog.json`) — verified `kiro/claude-sonnet-4.6` present.

## Verification (live, real Codex CLI 0.142.3)
- Direct `POST /v1/responses` to the proxy → **HTTP 200** + full Responses SSE
  (`response.created → output_item.added → content_part.added → output_text.delta* →
  output_text.done`), assembled text "Hi! What are you working on?". Proves
  proxy + kiro adapter + Responses re-emission end-to-end.
- `codex exec --model kiro/claude-sonnet-4.6 "Reply with exactly: hello-from-kiro-via-codex"`
  → **`hello-from-kiro-via-codex`** (exact), RC=0, 14,547 tokens.
- `codex exec … "What is 17*23? …"` → **`391`** (correct), RC=0.

## Note on the earlier 429
The first `codex exec` hit `429 Too Many Requests (exceeded retry limit)`. A direct
`/v1/responses` curl seconds later returned 200, and both subsequent `codex exec` runs
succeeded — so the 429 was **transient CodeWhisperer throttling** from the prior
interactive "Reconnecting 1/5…" retry storm, not a proxy/adapter defect.

## Operational caveat (for the user)
10100 is now served by the **workspace dev proxy** (`bun run src/cli.ts start`, PID at
write-time 62725). To make this permanent in the normal `ocx` flow, the published install
must be updated to include the kiro adapter (publish from `feat/kiro-on-dev`, then
`ocx update`) — otherwise a future `ocx start` from the global binary reverts to the
kiro-less build. The full Codex CLI path is now proven working against the branch build.
