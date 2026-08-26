# 002 — Plan audit (A phase, WP1)

The dispatched read-only auditor produced nothing across four wait cycles and
was retired under the loop's failed-dispatch rule. The audit below was performed
directly by the main agent against source at `bb89eafbe`. Every anchor cited in
`001`, `010`, `020`, and `030` was re-opened and confirmed.

## Anchor verification

| Doc claim | Verified |
|-----------|----------|
| `config-routes.ts:591` union of five backends | yes, exact |
| `config-routes.ts:668` two-arm ternary falling back to stored | yes, exact |
| `config-routes.ts:688` persistence honors the full union | yes |
| `agent-settings-routes.ts:1121` five-arm ternary | yes |
| `cli/status.ts:188` computes `routingKind` | yes |
| `cli/status.ts:316` `startup` lands in JSON | yes |
| `cli/index.ts:845` green check ignores routing | yes |
| `cli/doctor.ts:986` prints `routing=` | yes |
| `shim.ts:481` `hasUsableBackingPath` | yes |
| `shim.ts:1887` `allowFreshInstall` guard | yes |
| `cli/codex-shim-autorestore.ts:35` warns only with a message | yes |
| `autostart-health.ts:143` `startupHealthSummary` | yes |

One correction: `030` cites the destroyed-shim bail as `shim.ts:2043`. The
actual line is **`2045`**; `2043` is inside the `preserveOnly` branch. The
quoted code is right, the number is off by two.

## Blocking findings

**A1 — `030` targets only one of six `ineligible` returns.**
`rg 'status: "ineligible"' src/codex/shim.ts` finds returns at `2028`, `2031`,
`2039`, `2042`, `2045`, `2049`, and `2085`. Only `2028` and `2085` carry a
message today. The plan attaches one to `2045`, but `2042` is the
`preserveOnly` sibling case and `2049` is `isHealthyShimProbe` — both are
reachable in a version-manager overwrite and both would stay silent.

Correction: WP4 must attach messages to the reachable silent returns, not just
the one the reporter happened to hit. The `preserveOnly` branch at `2042`
deserves its own wording — its condition is a missing backup **or** a resurrected
original, which is a different story from a destroyed wrapper.

**A2 — `020`'s truth table omits `custom-local` and `unknown`.**
`CodexRoutingKind` (`inject.ts:314`) has five members. The table covers
`opencodex-local`, `native`, and `custom-remote`. The predicate as written
returns `[]` for `custom-local` and `unknown`, which is the correct behavior —
`startupHealthSummary` already renders both as `AT RISK after restart` with a
remedy command (`autostart-health.ts:149-150`), so a second warning would be
noise. But the plan does not say so, and a later reader could "fix" the omission.

Correction: state the five-member coverage explicitly and record that
`custom-local`/`unknown` are intentionally silent **because** they are already
loud elsewhere. Add both to the helper's test cases so the intent is pinned.

## Non-blocking findings

**B1 — `010`'s cast.** `WEB_SEARCH_BACKENDS_UNION.includes(x as ...)` does not
narrow `x` in TypeScript; `includes` returns `boolean`, not a type predicate.
The proposed `submittedBackend as typeof WEB_SEARCH_BACKENDS_UNION[number]`
cast in the true arm is therefore load-bearing, not decorative. It is sound
because `:591` already rejected non-members, but the doc should say that the
cast is doing real work rather than reading as noise.

**B2 — `webSearchModelIsRejected`'s `backend` parameter type.** If it is typed
as the narrow union, passing the widened value type-checks only because both
resolve to the same union. Confirm at implementation time; if it is narrower,
the signature is the thing to widen, not the call site to cast.

**B3 — line-number drift.** `030` says `2043`, actual `2045`. Corrected in this
document rather than by rewriting `030`, so the drift stays visible.

## Verified correct

- The #2457 mechanism, end to end: union at `:591`, ternary at `:668`,
  persistence at `:688`. A submitted `gemini` provably reaches the stored-backend
  arm.
- Both null policies genuinely differ between the two routes. `010`'s refusal to
  unify them is right.
- `startup.routingKind` is already in `status --json`. `020`'s claim that no
  schema change is needed holds.
- `allowFreshInstall: false` at `1887` is the invariant that blocks adoption.
  `030`'s refusal to relax it is correct, and it is what makes A1 a
  message-plumbing fix rather than a behavior change.

## Verdict

**PASS with two required amendments.** A1 and A2 are corrections to WP4 and WP3
scope respectively; neither invalidates the plan's shape, and both are folded
into this document rather than silently patched into the originals. B1–B3 are
notes for the implementer.
