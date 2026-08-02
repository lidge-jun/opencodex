# wt3 — Implementation roadmap (re-verify at P before building)

Branch `codex/wt3-provider-wire` off `dev`. One PABCD cycle per bug; land in dependency order A → B → C (D optional).

## Bug A — #746/#748: Copilot mixed-wire routing

File map:

- MODIFY `src/providers/registry.ts` — per-model wire override for the `github-copilot` preset: Responses-only models route to the Responses adapter instead of the preset-wide `openai-chat`.
- MODIFY `src/providers/github-copilot-transport.ts` — only if the transport needs Responses-shaped auth/headers distinct from chat (verify at P).
- MODIFY provider routing tests + a mixed-wire fixture: model list containing both chat-served and Responses-only models.

Acceptance + activation:

1. `gpt-5.4` via Copilot preset issues a Responses request (never `/chat/completions`). Activation: mock-transport test asserting the wire per model — external corroboration: litellm#23332.
2. Chat-served Copilot models still use chat completions (no regression). Activation: existing suite.
3. `gpt-5.6-sol` tools+reasoning request takes the path that does not 400. Activation: request-shape test; note external evidence is lead-only (JetBrains LLM-29711), so gate on request shape, not a claimed upstream error string.

## Bug B — #860 (+#875): DeepSeek service_tier capability gate

File map:

- MODIFY `src/types.ts` + registry-enriched metadata — provider-level `supportsServiceTier` capability (`src/providers/registry.ts`), canonical OpenAI Responses providers = true, DeepSeek = explicitly false.
- MODIFY `src/adapters/openai-responses.ts` / `src/server/responses/core.ts` — `fastMode` injects/removes `service_tier` only for supporting providers; strip for rejecting providers; preserve caller values for unclassified custom providers.
- DOCS: configuration reference (EN + zh-CN) per PR.

Acceptance + activation:

1. DeepSeek Responses request never carries `service_tier`, including with `fastMode` on. Activation: serialized-payload test.
2. Canonical OpenAI keeps injecting; custom unclassified preserves caller value. Activation: payload tests.
3. Issue #875 triage: determine whether the stall is (a) this field, (b) missing `reasoning_content` echo after tool calls (verified DeepSeek failure mode — 400, per official Thinking Mode docs), or (c) NIM/vLLM-only. Hosted stall reports were NOT externally verified; do not close #875 on #860's evidence alone. If (b), that is a separate fix in the same lane (response-state must round-trip `reasoning_content`).

## Bug C — #839/#854 consolidated: Claude 1M windows

File map:

- MODIFY `src/providers/registry.ts:217` — `ANTHROPIC_MODEL_CONTEXT_WINDOWS` lives here (verified on dev@3195c7194; it does omit the three models). Add `claude-opus-4-7`, `claude-opus-4-6`, `claude-sonnet-4-6` at 1M (externally verified: Anthropic announcements 2026-02-05 / 2026-04-16 / 2026-02-17 + model overview). `src/claude/context-windows.ts` only hosts `shouldMarkOneMillion` (:83) and marker helpers — no map change there.
- MODIFY `src/claude/model-info.ts` — generated profiles: `[1m]` marker only when the authoritative effective window ≥ 1M (fixes the 372K-route-marked-`[1m]` defect from #854); honor provider caps + case-insensitive marker spelling.
- Tests: picker row emission (`[1m]` present for the three models, absent for sub-1M routes).

Land as ONE PR crediting #839 and #854.

## Cross-worktree coordination (wt2 #847)

wt3 Bug B and wt2 #847 both touch `src/adapters/openai-responses.ts` and `src/server/responses/core.ts`. The changes live in different code paths (wt2: SSE record/tool-argument caps; wt3: `service_tier` injection at `core.ts:803-807`), so either landing order works — but whichever lane lands second MUST rebase over the other and re-run its payload-shape tests. Both units name this file pair in their ledgers.

## Bug D (optional) — #616/#837 hosted image tools

Rebase #837 (it already integrates #616 with authorship preserved); validate the per-model Responses wire including OpenAI API virtual-model rewrites.

## Verification gate

`bun run typecheck` + `bun run test`; wire changes need the full suite (shared adapters).
