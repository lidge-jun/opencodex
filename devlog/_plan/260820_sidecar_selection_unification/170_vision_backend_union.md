# 170 — Backend union: "routed" describer (wp2, REVISED)

Depends on: 160. REVISION 2026-08-22: user directive — vision does not need
per-backend executors. Any picker-visible model with image input can describe;
the proxy's own router already speaks every provider wire. The earlier
xai/gemini backend literals were implemented but never released; this revision
replaces them before any push.

## Design

- `VisionSidecarBackend = "openai" | "anthropic" | "routed"`.
- "openai"/"anthropic" arms unchanged (forward Responses / OAuth Messages) —
  they carry auth semantics loopback routing cannot replicate (forwarded
  headers, OAuth beta fences), and their defaults must not drift.
- "routed": the describer is ANY routed model, dispatched through the proxy's
  own /v1/chat/completions on loopback (pattern: src/claude/gateway-cache.ts
  self-fetch). One executor, every provider.

## Filter (#2188 rules, unchanged shape)

1. Picker-visible ∪ auth slots (pickerVisibleSidecarCandidates).
2. − provably text-only (modelAcceptsImageInput === false drops the row).

visionBackendForCandidate: native/openai → openai; resolved-OAuth anthropic
row → anthropic; ANY OTHER provider row → "routed". Routed option values are
NAMESPACED ("provider/model") so routeModel is unambiguous; legacy sides keep
bare ids (GUI/current-value compatibility).

## Gate

visionDescriberIsProvablyBlind keeps the four-family probe widening AND
learns namespaced ids: split on first "/", probe that provider's config row +
metadata family. Bare ids keep the existing all-family probe.

## Runtime

- planVisionSidecar routed arm requires: cfg.backend === "routed", explicit
  cfg.model, and plan-time modelAcceptsImageInput !== false for the target.
- Recursion safety: the loopback request re-enters the vision planner only if
  the routed model is provably text-only; the plan-time check excludes exactly
  that set, so describe recursion is structurally impossible.
- resolveVisionBackend: explicit honored; unset default order UNCHANGED.

## Files (wp2 scope, revised)

- src/vision/eligibility.ts: union, visionBackendForCandidate routed arm,
  namespaced option values, BASELINE narrow-key record (kept from r1).
- src/vision/backends.ts (r1 descriptor table): SIMPLIFIED — descriptors for
  openai/anthropic/routed; xai/gemini entries dropped.
- vision-sidecar-options.ts: enabledVisionBackends offers "routed" whenever
  any routed row exists; gate learns namespaced ids.
- config-routes.ts + agent-settings-routes.ts: literal sets accept "routed"
  (xai/gemini literals removed).
- types: backend unions.
- tests: vision-backend-union.test.ts rewritten for routed.


## Audit round 2 amendments (2026-08-22, sol-medium)

- **Recursion fence is a MECHANISM, not a predicate claim.** The loopback
  describe request carries a terminal marker header
  `x-opencodex-vision-describe: 1`. The Responses plan site treats a marked
  request as terminal: images are STRIPPED, never described (depth cap 1).
  This holds under predicate drift (modelInputModalities is invisible to a
  row-less plan-time target) and combo re-resolution (router.ts:625-631 can
  land a different sibling). Belt-and-braces: the routed arm also requires
  `!isModelTextOnly(resolvedRoute.provider, resolvedRoute.modelId)` at plan
  time — the exact re-entry predicate on the resolved route.
- **PUT-gate coherence:** a namespaced model with backend openai/anthropic is
  REJECTED (forward executor POSTs the string verbatim — web-search F1
  selector/slug failure); backend "routed" REQUIRES a namespaced id.
- **GUI inference:** `value.includes("/") → "routed"` in
  visionSidecarBackendForModel's fallback; persisted backend keeps traveling
  as currentBackend.
- Known limitation (recorded, not fixed here): a non-loopback-only bindHost
  where 127.0.0.1 does not answer — same latent limitation gateway-cache has.
- handleNativeChatCompletions fast path has no vision handling; the marked
  describe request must not regress it (marker check lives at the Responses
  plan site the bridge replays into).

