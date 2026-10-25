# 000 — moonshot_k31_seed: Plan

Issue #7653 (lane M4). Single-cycle C3 change; docs-first roadmap cycle skipped (one work-phase).

## Objective

The `moonshot` preset (Kimi API, `https://api.moonshot.ai/v1`) seeds `kimi-k3` plus legacy K2 ids
(`src/providers/registry/model-seeds.ts:772-773`) but not Kimi K3.1 Pro, so the picker never offers
`kimi-k3.1-pro` / `kimi-k3.1-pro-highspeed`, and a routed request gets no 1M window or effort ladder.
#7657 (46f23cab5e) already added the price rows for both ids (`src/usage/expected-prices.ts:467-468`)
but deliberately left the seeds out.

Evidence base (official Moonshot platform docs only, fetched 2026-10-25):

- https://platform.kimi.ai/docs/models.md — both `kimi-k3.1-pro` and `kimi-k3.1-pro-highspeed` listed
  as current multi-modal models ("native visual understanding and a 1M-token context window";
  highspeed = "same intelligence, about 2-3x the speed").
- https://platform.kimi.ai/docs/pricing/chat.md — "All K3 series models support a 1,048,576-token
  context window"; price rows $2/$10/$0.20/$2(5m) and $4/$20/$0.20/$4(5m) (already in tree, unchanged).
- https://platform.kimi.ai/docs/guide/kimi-k3-1-pro-quickstart.md — always thinking; top-level
  `reasoning_effort` low/high/max, default max; temperature/top_p/n/penalties fixed; vision via base64
  or ms:// file ids; return the complete assistant message (reasoning_content) on multi-turn.
- https://platform.kimi.ai/docs/api/models-overview.md — "kimi-k3.1-pro and kimi-k3.1-pro-highspeed
  also have the same parameter constraints as kimi-k3"; `tool_choice` auto/none/required supported.
- https://platform.kimi.ai/docs/guide/use-reasoning-effort.md — low/high/max, default max.

## Loop-spec

- Loop archetype: verifier-defined (parity + wire tests, typecheck, gates).
- Write scope: model-seeds.ts KIMI_API_* constants; entries-extended.ts moonshot entry wiring;
  tests/providers/provider-registry-parity.test.ts; tests/codex-integration/reasoning-effort.test.ts;
  docs-site/src/content/docs/guides/providers.md (English canonical); structure/providers-and-adapters.md
  (in-place, file stays at 600 lines); this devlog unit.
- Out of scope (owner decision, noted in PR): K2 retirement, moonshot defaultModel (kimi-k2.7-code,
  entries-extended.ts:475), rename migrations, kimi-k3's own max-only ladder (docs now list low/high/max
  for kimi-k3 too — follow-up), coding presets, prices, GUI, translated docs (English-only addition
  does not contradict them).
- Budget / bounds: none stated; host limits apply. Tool scope: local repo, gh (push/PR authorized by
  lane brief), GOAT task.create for review.

## Work-phase map (one phase = one full PABCD cycle)

| WP | Doc | Slice | Depends on |
|----|-----|-------|------------|
| wp1 | 010_phase1.md | seed + tests + docs + gates + PR + review | — |

## Accept criteria

- c-1 moonshot seeds both ids with 1M window, text+image, low/high/max default max, K3 effort map,
  fixed sampling, preserve reasoning, not auto-tool-choice-only; kimi-k3 / K2 / default unchanged.
- c-2 regression tests red on base (0aeaf0cb6b) and green after the fix.
- c-3 typecheck, test:changed, privacy:scan, structure:check, docs-site build green on final head.
- c-4 PR open on dev, GOAT-linked, independent review PASS at exact head, CI state reported.
