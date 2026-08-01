# 010 — Done: slash-model-id codec (outcome: DONE)

Date: 2026-07-18. Commit: c29a79ba (dev).

## What shipped

- `src/providers/slug-codec.ts` — encode/routedSlug/decode/slugEquals/slugsEquivalent.
  Codex-facing alias separator is `-` (user-directed revision from `_`: the Codex app
  accepted the alias tagging, and `-` reads cleaner next to ids already full of `_`).
- Catalog emits one-slash slugs (`zenmux/moonshotai-kimi-k3-free`); jawcode metadata +
  identity text use the native id; collisions keep the plain-hyphen id, drop the loser,
  warn once per provider+alias.
- Router decodes via exact known-id lookup (config ∪ registry ∪ registry hint maps ∪
  live cache); raw full-slash selectors and unknown ids behave as before.
- zenmux registry seed (`moonshotai/kimi-k3-free`, `moonshotai/kimi-k3`) live-verified
  2026-07-18 (Sol subagent, zenmux.ai/api/v1/models).
- Management pickers emit encoded slugs with tolerant disabled checks; Claude agent
  roster decodes before aliasing; README + docs/codex-app-model-catalog.md SoT note.

## Evidence

- Focused: tests/slug-codec.test.ts 15/15; cohort 186/186 (codex-catalog,
  nvidia-nim-hardening, provider-registry-parity, multi-agent-compat, selected-models,
  native-model-toggle, reasoning-effort). tsc --noEmit clean.
- Isolated detached-worktree full suite: change 2953p/55f/2e (3008) vs HEAD baseline
  2938p/55f/2e (2993) — identical failing set; +15 new green tests. The 55 fails are
  pre-existing parallel-load flakiness (websocket timeout, oauth token-store races,
  worktree-only gui react runtime resolution); the 8 failing files pass 135/135 isolated.
- Activation: decode-hit, warn-once, miss pass-through, encoded fallbacks, jawcode
  native lookup (template + null-template) all asserted in tests.

## Follow-up (user action)

Reinstall/restart the local ocx service from this branch and run `ocx sync` (or restart
the app) so `~/.codex/opencodex-catalog.json` picks up the one-slash slug; the stale
`zenmux/moonshotai/kimi-k3-free` entry is replaced on next sync.

## LOOP-PESSIMIST-01

- Full-suite flakiness (55 fails) is NOT explained by this change (identical at HEAD) and
  remains an open repo hygiene issue worth its own unit.
- Cold-cache decode depends on registry seeds/hint maps; providers with slash ids and no
  static seeds rely on the warm live cache (pass-through + upstream error otherwise).
