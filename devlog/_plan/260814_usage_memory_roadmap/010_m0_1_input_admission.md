---
title: "M0-1: Responses input admission gate"
phase: "010"
depends: []
consumes: []
branch: codex/m0-1-input-admission
closes: "(split from #1412)"
---

# 010 — M0-1: Model-aware input admission gate

## Audit history

**P stale check (base `origin/dev` @ v2.17.0)** replaced three WP0 assumptions: reuse
`estimateTokens` (`src/lib/token-estimate.ts`) instead of a `chars / 4` heuristic;
measure `OcxParsedRequest.context`, not `input[]`; call `formatErrorResponse` with 3 args
(its 4th is `{code, retryAfter}`, so a metadata object would have been silently dropped —
`src/bridge.ts:1825`).

**A round 1 — FAIL, 5 blockers. All folded.**

| # | Blocker | Disposition |
|---|---------|-------------|
| 1 | Gate would 413 compaction-recovery turns, deadlocking the client | Folded — full bypass; reviewer confirmed both paths in round 2 |
| 2 | A heuristic estimate cannot justify "could not have succeeded upstream" | Folded — tolerance margin; claim removed |
| 3 | `candidateCapabilityEvidence` merges registry data even for same-named custom providers | Folded — read `route.provider` |
| 4 | Merged `modelMaxInputTokens` lives on `route.provider`, not raw config | Folded — read `route.provider` |
| 5 | `candidateCapabilityEvidence` does sync `existsSync`/`readFileSync`/`statSync` per call | Folded — no filesystem access on the request path |

**A round 3 — GO-WITH-FIXES, 1 blocker, folded below. Audit loop exits here** (AUDIT-LOOP-01:
near-pass with every blocker folded). Round 3 also confirmed 2.5 is above the estimator's
maximum internal divergence — base ratio 4 over clamp 2.5 is exactly 1.6 — so no worse
CJK-mode overshoot can be constructed, and that `nativeOpenAiContextWindow` touches no
filesystem.

| # | Blocker | Disposition |
|---|---------|-------------|
| 8 | "canonical native provider" underspecified — a custom provider named `openai` could take the native fallback | Folded — exact 3-clause predicate |

### Blocker 8: name alone does not identify the native route

Bare native-family routing accepts `config.providers.openai` (`src/router.ts:615`), and a
transport-mismatched custom provider named `openai` is deliberately preserved
(`src/router.ts:251`). Gating the native fallback on `providerName === "openai"` alone would
hand built-in native limits to that custom provider — reintroducing blocker 3 through the
back door. The condition is therefore all three of:

```ts
providerName === OPENAI_CODEX_PROVIDER_ID          // src/providers/openai-tiers.ts:5
  && isCanonicalOpenAiForwardProvider(provider)    // adapter + forward auth + canonical base URL
  && !modelId.includes("/")                        // bare native slug, not a routed id
```

Account-qualified routes stay covered: routing strips the namespace into the native model id
and keeps `providerName: "openai"` (`src/router.ts:543`), with `codexAccountNamespace` as a
separate field — so the shape predicate, not the name, is what decides.

**A round 2 — FAIL, 2 new blockers.** Round-1 fixes 1, 3, 4, 5 verified by the reviewer as
real. Two new findings, both reproduced independently before acceptance:

| # | Blocker | Disposition |
|---|---------|-------------|
| 6 | `ADMISSION_TOLERANCE = 1.5` is under the estimator's own 1.6x aliasing overshoot | Folded — tolerance raised to 2.5 with a measured basis |
| 7 | Dropping native metadata makes the gate inert on every native OpenAI model | Folded — pure static native fallback added |

### Blocker 6: the estimator can overshoot 1.6x, so 1.5x was below its own error bar

`cjkRatio` (`src/lib/token-estimate.ts:47-53`) samples with
`stride = ceil(length / 2048)` and tests only `text[i]`. When record length aligns with the
stride, every sampled character can be Korean while the text is almost entirely ASCII.
Reproduced locally on Bun 1.3.14 with a 126,046-char payload of 62-char records each
starting with one Hangul character:

```
{"length":126046,"stride":62,"sampledRatio":1,"trueRatio":0.0161,
 "clampFires":true,"withClamp":50419,"honest":31512,"overshoot":1.6}
```

A payload that is **1.6% Korean samples as 100% Korean**, fires the 2.5-chars/token clamp
(`src/lib/token-estimate.ts:67`), and inflates the estimate by 1.6x. Fixed-width records
with a leading Korean label are ordinary data, not a contrived attack.

`ADMISSION_TOLERANCE` is therefore **2.5**, not 1.5: strictly above the 1.6x demonstrated
internal divergence, with margin left for the ~10% model-family ratio spread documented at
`src/lib/token-estimate.ts:8-11`. The #1412 shape (10x inflation) still clears 2.5x by a
factor of four, so the gate keeps the case it exists for while becoming much harder to
trip by accident.

Fixing `cjkRatio` itself is the better long-term fix and is deliberately NOT done here:
`estimateTokens` also feeds usage accounting and auto-compact
(`src/server/chat-completions.ts:140`), so changing its output is a behavior change to
unrelated subsystems and belongs in its own layer with its own tests. Recorded as
follow-up FU-1 rather than smuggled into an admission-gate PR.

### Blocker 7: without native metadata the gate is inert where it matters most

The canonical `openai` registry entry (`src/providers/registry.ts:937-947`) declares
`adapter`, `baseUrl`, `authKind` — and no `contextWindow`, `modelContextWindows`, or
`modelMaxInputTokens`. Native model limits live only in static metadata:
`NATIVE_OPENAI_CONTEXT_OVERRIDES` (`src/codex/catalog/metadata.ts:104`) gives `gpt-5.5`
272k, `gpt-5.4` 1M, and the GPT-5.6 family 372k.

So a `route.provider`-only ceiling returns null for the default Codex route, and the gate
silently never fires on the most-used path. Round 1 accepted "thin evidence fails open" as
a trade; that reasoning does not survive contact with the fact that the primary route has
no evidence at all.

The fix keeps blocker 5 intact by taking only the **static** half of what
`candidateCapabilityEvidence` consults: `nativeOpenAiContextWindow`
(`src/codex/catalog/metadata.ts:135`) reads two in-memory maps and touches no filesystem.
The catalog row — the part that costs `existsSync`/`readFileSync`/`statSync` — stays
excluded.

## Thesis

Refuse a request whose input alone cannot plausibly fit the model context window, before
spending auth, circuit budget, or upstream bandwidth on a turn the provider will reject.

Deliberately narrow: not a context manager, not a compaction trigger. It catches the
pathological case (#1412 reported 127k of real context inflating to 1.3M-1.6M tokens) and
stays out of the way otherwise.

## Current state

- `src/server/responses/core.ts:1842` acquires the per-host circuit admission — failure-rate
  based, not size based
- `src/server/responses/core.ts:680` and `:1552` return 413 for translator buffer overflow —
  post-translation and byte-based
- `src/routing/evaluator.ts:192` compares a context window for routing ELIGIBILITY, not
  request admission
- `src/server/responses/core.ts:3500` retries images one tier lower after an UPSTREAM 413 —
  after dispatch, no overlap
- `route.provider` already carries merged, transport-guarded `modelContextWindows` and
  `modelMaxInputTokens` (`src/router.ts:250-284`, attached at `:455`)
- `src/lib/token-estimate.ts` yields model-aware, CJK-aware estimates
- No estimated-token admission exists anywhere (reviewer-confirmed)

## Design decisions

### Compaction turns bypass the gate (blocker 1)

Codex sends `{type:"compaction_trigger"}` precisely BECAUSE context is full.
413-ing it is a deadlock: the client is told to compact, and compaction is refused.

Reviewer verified in round 2 that both paths set the flag before the gate: v2 sets
`compactionRequest = true` at `src/responses/parser.ts:355` and emits `_compactionRequest`
at `:711`; routed `/v1/responses/compact` appends the same trigger
(`src/server/responses/compact.ts:659`) and re-enters `handleResponses` at `:671`, parsed
at `src/server/responses/core.ts:1538` — before the `:1840` guard.

### The ceiling comes from the routed provider, plus static native metadata (blockers 3, 4, 5, 7)

`routedProviderConfig` (`src/router.ts:250`) already refuses registry merging when
`providerMatchesRegistryTransport` is false (`:252`), so a user-defined provider sharing a
built-in name keeps its own limits, and it merges registry + user caps (`:278-284`).
Reading `route.provider` gets all of that for free, as pure record lookups.

Native models then fall back to `nativeOpenAiContextWindow`, which is static maps only.

`min()` of the defined positive values is correct: `modelMaxInputTokens` is documented as a
per-model maximum INPUT limit (`docs-site/.../providers.md:83`) and catalog construction
already bounds it against context (`src/codex/catalog/provider-fetch.ts:800`), so the
tighter of the two is the real admission ceiling.

## File change map

### NEW: src/server/responses/input-admission.ts

```ts
/**
 * Multiplier applied to the ceiling before refusing.
 *
 * 2.5, not 1.5: estimateTokens can overshoot by 1.6x on its own. cjkRatio
 * (src/lib/token-estimate.ts:47) samples every `stride`-th character, so a payload of
 * fixed-width records whose length aligns with the stride can sample as 100% CJK while
 * being ~1.6% CJK, firing the 2.5-chars/token clamp. Measured on Bun 1.3.14:
 * 126,046 chars, true CJK ratio 0.0161, sampled ratio 1.0, estimate inflated 1.6x.
 *
 * A threshold under that turns the estimator error bar into false 413s. 2.5 sits above
 * it with room for the ~10% model-ratio spread, and still catches the #1412 case (10x).
 */
export const ADMISSION_TOLERANCE = 2.5;

export interface InputAdmissionResult {
  admitted: boolean;
  estimatedTokens: number;
  /** Resolved ceiling, or null when unknown (=> always admitted). */
  ceiling: number | null;
}

/**
 * Estimate input tokens over the parsed request, delegating every text blob to
 * estimateTokens(text, modelId) so model-aware and CJK-aware ratios apply.
 *
 * Covers the full OcxMessage union (src/types.ts:96), not user text only:
 *   - user / developer: string or OcxContentPart[]
 *   - assistant: OcxAssistantContentPart[] = text | thinking | toolCall, so thinking
 *     blocks and JSON tool-call arguments are counted, plus kiroRedactedReasoning
 *   - toolResult: string or OcxContentPart[]
 * Tools are charged name + description + JSON.stringify(parameters): all three reach
 * the upstream (src/types.ts:181).
 *
 * Images are not text. A data: URL is charged by DECODED byte size / 750; a remote
 * https URL is charged a small fixed cost because its bytes are not in this request.
 */
export function estimateInputTokens(parsed: OcxParsedRequest, modelId: string): number;

/**
 * Resolve the admission ceiling. Pure: no filesystem, no catalog, no registry scan.
 *
 * Order:
 *   1. provider.modelContextWindows[modelId] ?? provider.contextWindow
 *      — route.provider is routedProviderConfig output (src/router.ts:455), already
 *        transport-guarded and merged, so a same-named custom provider keeps its own
 *        limits instead of inheriting built-in ones.
 *   2. nativeOpenAiContextWindow(modelId) when step 1 found nothing AND all three hold:
 *        providerName === OPENAI_CODEX_PROVIDER_ID
 *        && isCanonicalOpenAiForwardProvider(provider)
 *        && !modelId.includes("/")
 *      The `openai` registry entry carries no context fields
 *      (src/providers/registry.ts:937), so without this the gate is inert on the
 *      default Codex route. All three clauses are required: a transport-mismatched
 *      custom provider named "openai" is preserved verbatim by routing
 *      (src/router.ts:251) and must NOT inherit built-in native limits.
 *      Static maps only (src/codex/catalog/metadata.ts:135) — no filesystem,
 *      preserving blocker 5.
 *
 *      providerContextCaps is deliberately NOT applied: it is a Codex-visible
 *      presentation cap (src/types.ts:790), not upstream capacity, so honoring it
 *      here would let a display setting cause false 413s.
 *   3. Tighten by provider.modelMaxInputTokens[modelId] when present (min of defined
 *      positive values).
 * Returns null when nothing resolves — unknown models stay admissible.
 */
export function resolveInputCeiling(
  provider: OcxProviderConfig,
  providerName: string,
  modelId: string,
): number | null;

/**
 * Fail-open when no ceiling is known. Refuses only when
 * estimate > ceiling * ADMISSION_TOLERANCE.
 *
 * Caller skips compaction turns; see the core.ts call site.
 */
export function checkInputAdmission(
  parsed: OcxParsedRequest,
  provider: OcxProviderConfig,
  providerName: string,
  modelId: string,
): InputAdmissionResult;
```

### MODIFY: src/server/responses/core.ts

Location: inside `handleResponsesInner`, after `applyFinalRouteRequestNormalization`
settles the final route and before the `preAuthHostKey` circuit block (`:1840`). After
normalization the gate measures what will actually be sent, including replay expansion;
before auth and the circuit, an oversized turn costs no credential resolution and burns no
circuit budget. Reviewer confirmed `parsed`, `route`, `config`, and `formatErrorResponse`
are in scope there (`:1824-1836`, import at `:2`).

```diff
+ // Refuse an input that cannot plausibly fit the model context window before spending
+ // auth, circuit budget, or upstream bandwidth on a turn the provider will reject anyway.
+ //
+ // Compaction turns are exempt: Codex sends compaction_trigger BECAUSE context is full
+ // (src/responses/parser.ts:355), so refusing the turn that shrinks the context would
+ // deadlock the client against the very limit this gate reports.
+ if (parsed._compactionRequest !== true) {
+   const inputAdmission = checkInputAdmission(parsed, route.provider, route.providerName, parsed.modelId);
+   if (!inputAdmission.admitted) {
+     return formatErrorResponse(
+       413,
+       "request_too_large",
+       `Estimated input (~${inputAdmission.estimatedTokens} tokens) is far past the context `
+         + `window of ${parsed.modelId} (${inputAdmission.ceiling} tokens). Start a new session `
+         + `or choose a model with a larger context window.`,
+     );
+   }
+ }
```

### NEW: tests/input-admission.test.ts

1. Input under the ceiling → admitted
2. Input past `ceiling * ADMISSION_TOLERANCE` → refused, reporting both numbers
3. Input over the ceiling but inside tolerance → admitted (estimator error bar)
4. No ceiling resolvable → admitted (fail-open)
5. `modelMaxInputTokens` tightens the ceiling below the context window
6. A same-named custom provider uses its OWN limits, not registry limits (blocker 3)
6b. **A custom provider named `openai` with no limits does NOT get the native fallback (blocker 8)**
7. **Native `gpt-5.6-sol` resolves 372k from static metadata (blocker 7)**
7b. **An account-namespaced native route still resolves the native ceiling (blocker 8)**
7c. **A routed `provider/model` id does not take the native fallback (blocker 8)**
8. **The stride-aliased 1.6x CJK payload does NOT trip the gate at its true size (blocker 6)**
9. Assistant thinking blocks and tool-call arguments are counted
10. Tool name + description + parameters all counted
11. A `data:` image is charged by decoded size, not URL character length
12. A remote https image is charged a small fixed cost
13. **A `_compactionRequest` turn is admitted no matter how large (blocker 1)**
14. Ceiling resolution performs no filesystem access (blocker 5)

## Activation scenario

A turn carrying ~1.3M estimated tokens (the #1412 shape) targets a 372k-window native
model. `1_300_000 > 372_000 * 2.5 = 930_000`, so the client gets 413 before any upstream
fetch.

Observable proof required in C: the focused test asserts the 413 AND that no upstream fetch
was attempted — the test installs a fetch that throws if called, so a gate placed after
dispatch fails rather than passing quietly.

Blocker-1 proof: a `_compactionRequest` turn of the same size returns non-413.
Blocker-6 proof: the aliased payload from the probe above is admitted.

## Follow-ups (not this layer)

- **FU-1: fix `cjkRatio` periodic aliasing** (`src/lib/token-estimate.ts:47`). Sampling
  every `stride`-th character aliases against fixed-width records. `estimateTokens` also
  feeds usage accounting and auto-compact (`src/server/chat-completions.ts:140`), so this
  is a behavior change to unrelated subsystems and needs its own layer and tests. Until it
  lands, `ADMISSION_TOLERANCE` absorbs the error.

## Scope boundary

IN: the admission module, its single guarded call site, the test file
OUT: the translator buffer limit, provider config defaults, GUI surface, any second copy of
context-window resolution, changing `estimateTokens` behavior (FU-1), and making
`src/routing/capability.ts` transport-aware (sidestepped by reading `route.provider`), and
applying `providerContextCaps` to admission
