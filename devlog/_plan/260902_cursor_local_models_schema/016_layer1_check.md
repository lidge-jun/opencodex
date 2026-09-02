# 016 — Layer 1 check (wp2 C)

Tip: `f1a9a2c43` on `codex/cursor-local-models-schema` (2 commits over `origin/dev` `85f7ef92a`).

| Check | Result |
|---|---|
| `bun run typecheck` | exit 0 |
| focused set (9 files: cursor-local-models-schema, grok-models-effort-list, server-combo-failover-e2e, claude-models-discovery, server-auth, ollama-native, provider-outbound, codex-catalog, gui-management-session) | 496 pass / 0 fail, receipt `.codexclaw/evidence/<session>/test-receipt.json` |
| extra consumers found by `rg 'object: "model"'`: ollama-show-enrichment, catalog-llamacpp-capabilities | upstream fixtures, not readers of our list; ran anyway: 25 pass |
| `bun run privacy:scan` | passed |
| `bun run skill:surface:check` | current |
| live Cursor Private Inference | Reasoning Low/Medium/High/Extra High shown; High turn → `reasoning.effort: "high"` on `/v1/responses` (015) |

Adversarial review: an Opus reviewer was dispatched with the diff and a six-point checklist
but produced no output in ~7 minutes and was retired (DISPATCH-RETIRE-01). The main session ran
the same checklist directly: no other test asserts full row equality on the raw list; the
`api_types` OpenAI-family invariant is unit-tested; native rows always get
`supports_vision: true` via `nativeInputModalities`'s text+image fallback (documented in 010);
routed rows with unknown modalities omit `supports_vision`/`input_modalities`; `contextCap`
precedence over `contextWindow` exposes only the operator-narrowed limit already visible on
the Codex catalog branch; the combo e2e rewrites keep `is_combo` presence and absence explicit.
Full suite deliberately not run (user constraint); exact-head CI is the gate at publish.
