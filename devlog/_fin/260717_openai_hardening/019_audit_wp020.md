# Cycle 020 Audit Amendments

Reviewer: GPT-5.6 Sol, high reasoning, priority service tier
Result: `VERDICT: GO-WITH-FIXES (blockers=8)`

All blockers are accepted:

1. Move central sidecar ownership and all standalone/internal callers from 040 into
   the atomic activation cycle so mandatory route-mode auth leaves no blind caller.
2. Pool mode fails typed 401 when no usable selected account/main token exists; it
   never degrades to Direct caller credentials.
3. Separate proxy admission secrets from upstream Codex Authorization and prove no
   admission bearer reaches any forward endpoint.
4. Make bare OpenAI-family routing terminal when no fixed tier is enabled.
5. Scope canonical own-key rejection to Direct/Multi; preserve safe custom/API fields.
6. Add a public OAuth predicate excluding `chatgpt` across management and CLI while
   retaining the lower-level internal Codex-account login flow.
7. Add an injected startup migration coordinator and complete atomic writer IO seam.
8. Add real transport-level WS route-first activation tests, not registry-only tests.

## Repair verdict

Result: `VERDICT: PASS`

After three repair rounds, the same reviewer confirmed exact sidecar/planner contracts,
typed pool and admission failures, startup/atomic cleanup semantics, terminal routing,
raw management ownership, public OAuth isolation, quota ownership, transport WS proof,
and the complete focused command. No caller or phase contradiction remains.

## Source re-audit after Cycle 010 implementation

Reviewer: GPT-5.6 Sol, high reasoning, priority service tier
Result: `VERDICT: GO-WITH-FIXES (blockers=6)`

The source-level re-audit found six additional exactness gaps. Accepted amendments:

1. Registry metadata becomes the sole runtime mode authority; delete the duplicate
   hard-coded helper from the foundation module.
2. Reject `chatgpt` in the final default route and enforce legacy/Multi invariants even
   when marker 1 already exists.
3. Select no-active Multi from main+added and support main thread affinity explicitly.
4. Reuse an existing/racing backup only when its bytes equal the current original;
   otherwise throw a typed collision before save.
5. Validate caller bearer only after a Direct route; Multi/API keep their independent
   credential owners and proxy admission uses a dedicated header.
6. Clear WS account tracking before each frame so failed Multi resolution cannot retain
   the previous account.

The same reviewer must PASS these amendments before Build resumes.

## Repair audit round

Result: `VERDICT: GO-WITH-FIXES (blockers=4)`

Accepted final precision fixes:

1. Reuse existing `getProviderRegistryEntry`; add only the mode accessor.
2. Permit managed `disabled` and `selectedModels` overlays on canonical Multi while
   keeping transport/auth and all other own fields fail-closed.
3. Specify `OpenAiTierBackupIO` and the exact optional dependency signature so every
   backup stage/race is deterministic under tests.
4. Add `tests/codex-routing.test.ts` to the focused exit command.

## Final A verdict

Result: `VERDICT: PASS`

The same GPT-5.6 Sol high/priority reviewer confirmed all ten source-level amendments
are coherent, owned by exact files/signatures, and covered by feasible named tests.
This approves the plan only; implementation remains subject to Build and Check gates.
