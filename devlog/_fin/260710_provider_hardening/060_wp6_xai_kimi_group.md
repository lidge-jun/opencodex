# 060 — WP6: xai, kimi, kimi-code, moonshot, firepass

Pre-analysis: Franklin (sol explorer xhigh, 2026-07-10). Re-verify at WP6's P.

## P scope decision (260710, main session)

IN this cycle:
- R1 (AMENDED A-round1) registry: kimi + kimi-code entries ADD "kimi-for-coding"
  alias + pin ctx 262_144 for all five ids; the alias ALSO joins every Kimi
  capability classification the k2.7 ids carry (KIMI_THINKING_MODELS-style
  noReasoningModels/preserveReasoningContentModels, locked-parameter lists,
  autoToolChoiceOnlyModels) so the alias cannot silently regress to generic
  handling (reviewer blocker 1). moonshot ADD ctx 262_144 for its four ids (NO
  coding alias). xai NOOP. firepass FREEZE + note. kimi domain FROZEN.
- R2 (FINAL, A-round2): litellm KEEPS authKind "key" (flipping to local would
  remove it from key-login/validation + GUI presets and suppress key entry —
  reviewer-proven regression). Instead introduce OPTIONAL-KEY semantics: new
  registry/provider flag `keyOptional: true` seeded on litellm only; O3 throws
  on blank credential for authMode key/oauth UNLESS keyOptional. Flag must flow
  through providerConfigSeed/routedProviderConfig like other seed fields.
  Tests: keyless litellm request builds without Authorization and without
  throw; litellm WITH key still sends Bearer; keyOptional absent => throw.
- O1 openai-chat.ts non-stream (:417): 200 body with {error:{...}} => error
  event; empty choices / missing message => error "upstream response contained
  no choices". (Shared surface — lands once here, benefits ~30 providers.)
- O2 openai-chat.ts stream (:296): malformed SSE data frame (invalid JSON that
  is not the [DONE] sentinel) => terminal error event instead of debug-drop
  (a following [DONE] can no longer whitewash lost content).
- O3 (FINAL, A-round2) openai-chat.ts auth (:248): blank credential => throw
  ONLY when authMode is "key" or "oauth" AND NOT provider.keyOptional (R2).
  Tests MUST preserve keyless local/undefined behavior explicitly (ollama-style
  provider builds request without Authorization, no throw).
- O4 safeToolName final empty fallback (:125) — verify truly unreachable, then
  remove.
- Tests (AMENDED A-round1, blocker 3): O1 branches activated SEPARATELY
  ({error} envelope / empty choices / missing message), O2 malformed-frame
  terminal error, O3 both directions (key-blank throws, local/undefined keyless
  passes), R1 alias capability parity assertions.

OUT (recorded honestly):
- usage-as-terminal-evidence EOF semantics (:323/:401): test-locked, needed by
  providers that omit finish_reason on usage-only tails — behavior change too
  broad; named.
- Orphan-result synthesis + invented tool ids (:93/:276): protocol-compat with
  Codex replay flows, test-locked.
- developer-image demotion (:41) + Kimi named/required tool-choice reduction
  (:200): documented upstream constraints (autoToolChoiceOnlyModels registry
  metadata is the honest surface, already present).
- Global bracket-suffix stripping (:10/:194): WP7 zai item (registry-scoped fix
  planned there).

## Verdicts

- xai: NOOP (260709 refresh matches evidence; registry.ts:187,
  devlog/model_update/260709_model_refresh/001_xai_lineup.md).
- kimi + kimi-code: ids current; ADD kimi-for-coding alias + pin 262_144 ctx for
  all five ids (Tier-2, 002 research).
- moonshot: ids current; ADD 262_144 ctx; NO coding alias on standard API entry.
- kimi domain: registry api.kimi.com vs docs api.kimi.ai — FREEZE pending
  authenticated probe (in-repo design decision devlog/_fin/130_provider-catalog-
  single-source/02_single-source-design.md:246 chose .com; only auth.kimi.com was
  proven).
- firepass: no Tier-2 model/entitlement proof; candidate disable-or-document —
  NEEDS_HUMAN flavor decision at WP6 P (removal breaks existing users' config).

## openai-chat.ts adapter findings (shared surface — affects WP6/7/8/9)

- HIGH openai-chat.ts:417 — non-stream 200 {error} / empty choices => silent done.
- HIGH openai-chat.ts:296 — malformed SSE frame debug-dropped; trailing [DONE]
  completes cleanly (content loss).
- MED :323/:401 — any usage-bearing chunk makes finish-less EOF a success.
- MED :93/:276 — orphan results get synthetic calls; invented tool ids.
- MED :41/:200 — developer-image demotion to user; Kimi named/required tool
  choice silently reduced to auto.
- Dead: safeToolName final empty fallback unreachable (:125); bracket-suffix
  stripping global though Z.AI-only justified (:15, ties into WP7 zai item).
- upstream-retry: NARROW, ok (no change).
- Auth: adapter sends unauthenticated request when key blank (:248) — same
  loud-throw treatment as WP2 anthropic.

Note: shared openai-chat.ts changes land ONCE (in WP6 as the first openai-chat
cycle) and later WPs re-verify only.

## Tests to add
non-stream error envelope, malformed-frame+[DONE], usage-then-truncation, blank
auth, kimi ctx/alias assertions. Several existing tests bless silent repair —
invert only those directly testing the silent path.
