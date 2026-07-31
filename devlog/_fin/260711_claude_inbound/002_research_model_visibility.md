# 002 — Research: custom model NAMES + picker VISIBILITY in Claude Code

User problem statement (2026-07-11): CCR only reuses the existing Anthropic model
names — you route "claude-sonnet-..." somewhere else, but you cannot SPECIFY your own
model names and have them SHOW UP in Claude Code's UI. Is that really the ceiling?

Answer: **No — since Claude Code v2.1.129 there is an official gateway model
discovery protocol.** CCR's comma-hack is the legacy workaround, not the ceiling.

## Claim ledger (tier per cxc-search; Tier 1 = search-sourced snippet w/ named
## source, promote to Tier 2 by opening the page during Phase 1 build)

| # | Claim | Source | Tier |
|---|-------|--------|------|
| 1 | `ANTHROPIC_MODEL` / `--model` / in-session `/model <name>` accept ARBITRARY model strings; the gateway just has to accept the id on /v1/messages | code.claude.com/docs/en/env-vars, /docs/en/model-config | T1 (official docs) |
| 2 | CCR's built-in reality: the native `/model` picker lists only default Claude models; routed models are selected by TYPING `/model provider,model` (comma separator; provider/model must exist in CCR config) | github.com/musistudio/claude-code-router issues #575, #504 | T1 (repo issues) |
| 3 | CCR surfaces the ACTIVE routed model via its own StatusLine module (`{{model}}` template), not via the picker | CCR issue #744 + README | T1 |
| 4 | **Gateway model discovery**: Claude Code >= v2.1.129 with `CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1` calls `GET /v1/models` on `ANTHROPIC_BASE_URL` and ADDS returned models to the `/model` picker, labeled "From gateway"; entries carry `id` + optional `display_name` | code.claude.com/docs/en/llm-gateway-protocol, /docs/en/llm-gateway-connect | T1 (official docs) |
| 5 | Discovery caveat: picker ignores discovered ids unless they start with `claude` or `anthropic` — so expose a claude-/anthropic-prefixed ALIAS id and map it to the real upstream model in the proxy; `display_name` can show the honest routed name | code.claude.com/docs/en/llm-gateway-protocol | T1 |
| 6 | Manual alternative without discovery: `ANTHROPIC_CUSTOM_MODEL_OPTION` adds individual picker entries; LiteLLM tutorial demonstrates the same alias->upstream mapping pattern | docs.litellm.ai/docs/tutorials/claude_non_anthropic_models | T1 |

## What this means for opencodex (design delta to 000_plan.md)

1. **D6 (new): implement Anthropic-visible model discovery.** opencodex already
   serves `GET /v1/models` (OpenAI list shape, `src/server/index.ts`). Add an
   Anthropic-facing variant (or shape-detect) that returns routed models as
   discovery entries with:
   - `id`: alias `anthropic-<provider>-<model-slug>` or `claude-<...>` (constraint
     from claim 5 — bare "google/gemini-3-pro" would be ignored by the picker),
   - `display_name`: the honest routed name, e.g. "gemini-3-pro (google) — opencodex".
   Inbound `/v1/messages` resolves the alias back through the same mapping before
   `routeModel` (extends the D5 modelMap: alias generation must be deterministic
   and reversible).
2. **`ocx claude` injects `CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1`** next to
   ANTHROPIC_BASE_URL/AUTH_TOKEN, gated by a Claude Code version check (>= 2.1.129)
   with the env-var fallback documented.
3. **Statusline is optional garnish**, not the mechanism (CCR needed it because it
   lacked discovery; with the picker showing "From gateway" entries + display_name,
   the built-in UI already reflects the routed model).
4. Verification items for Phase 1 (promote claims 4-5 to Tier 2 before coding):
   open llm-gateway-protocol + llm-gateway-connect pages; confirm exact env var
   name, minimum version, response schema (`data[].id`, `display_name`), and the
   claude/anthropic prefix rule; confirm whether the picker persists the selection
   into `settings.json` `model`.

## Non-goals confirmed by this research

- No need to patch/wrap Claude Code's UI or intercept slash-commands CCR-style
  (`/model provider,model` message interception) — discovery supersedes it.
- No separate dashboard implication: discovery is served by the same daemon.
