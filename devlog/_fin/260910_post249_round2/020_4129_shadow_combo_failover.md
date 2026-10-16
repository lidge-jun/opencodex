# A1 — #4129 shadowCallIntercept on a combo never enters the failover loop

Raw research: `_research/4129.md` (xai/grok-4.6, read-only, verified against `cd813d3d9`).

## Verdict

Real, and it is **two** cooperating bugs rather than one.

## Root cause

The combo gate runs on the un-rewritten body. `comboIdFromRawBody` reads only
`body.model` (`src/combos/request.ts:20`), and at `src/server/responses/core.ts:3306`
the incoming helper slug is still `gpt-5.6-luna`, which is not a combo id. The
`while (pick)` loop at `core.ts:2798` — inside `handleComboResponses`, declared at
`core.ts:2600` — is therefore never entered, `advanceComboAfterFailure` at
`core.ts:3056` never runs, and 429/5xx hops only exist inside that loop
(`src/combos/failover.ts:468`).

The shadow rewrite happens later, after parse, at `core.ts:3480-3512`, and
`resolveRoute("combo/shadow")` goes through `routeModel` → `tryPickComboModel`
(`src/router.ts:674`, `src/combos/resolve.ts:418`), which collapses the combo to
**one** target while still tagging `routeKind: "combo"`. That is the reported
"combo route, one attempt" log.

Second path: `shouldInterceptShadowCall` is
`isShadowSourceModel && !shadowCallTargetsIntersect` (`src/lib/shadow-call.ts:88`).
If the collapsed first pick happens to be `openai/gpt-5.6-luna`, the intersect
check is true (`shadow-call.ts:70`), intercept is skipped entirely,
`shadowCallRewrittenFrom` stays unset and the route is plain native. Swapping the
two blocks does not close this path.

## Chosen fix

Add an early branch in `handleResponsesInner` **before** `comboIdFromRawBody`
(`core.ts:3306`), only when `!options.comboAttempt`:

- raw `body.model` is a string and `isShadowSourceModel(body.model, _sci.sourceModels)`
- `_sci.enabled` and `_sci.model` are set
- `resolveComboId(config, _sci.model)` names a configured combo — resolved by
  **config lookup, not `routeModel`/`tryPickComboModel`**, so the combo is never
  collapsed to one candidate for the identity check

Then rewrite `body.model` to `_sci.model` and set `logCtx.shadowCallRewrittenFrom`
through the same `shadowSourceModelPrefix` + sanitize as `core.ts:3502`. The existing
combo gate takes it from there and `handleComboResponses` runs its normal loop.

Treat a combo selector as routing policy, not as its first pick's identity. Leave
`shouldInterceptShadowCall` alone for direct same-provider replacements (#2706).

Do **not** re-enter `handleComboResponses` from the late intercept site: that
double-runs `expandPreviousResponseInput` and `onRequestBodyRead`.

## Policy edges — decided here, out of scope for this PR

- `parsed._cursorIsolateConversation` (`core.ts:3506`) is not propagated to combo
  children. Plumbing a new `HandleResponsesOptions` bit is a separate change and
  only matters when a Cursor target sits in the combo. **Deferred**, noted in the
  PR body.
- `shadowCallTargetError` (`src/server/management/shadow-call-validation.ts:7`)
  collapses the same way, so a dashboard PUT of a Luna-first `combo/shadow` can
  still 400 even though file config works. **In scope only if the fix is trivial**;
  otherwise report it as a follow-up issue.

## Regression test

Extend `tests/responses/responses-shadow-intercept.test.ts` (already in
`layout.json` explicit — no new layout entry needed). Reuse its
`handleResponses` + fake `fetch` + `logCtx` harness.

1. `shadowCallIntercept.model = "combo/shadow"`, failover combo, inbound
   `gpt-5.6-luna`, first target 429 or 503 and second 200 → `response.ok`,
   `logCtx.shadowCallRewrittenFrom === "gpt-5.6-luna"`, `logCtx.provider === "combo"`,
   `routeDecision.routeKind === "combo"`, and `attempts` of length 2 in configured
   order. Red today: one attempt, or a native route with no marker.
2. Same combo with `openai/gpt-5.6-luna` as the **first** target returning 200 →
   exactly one upstream call, marker still set, `routeKind === "combo"`. Red today:
   `routeKind: "native"`, marker unset.
3. Existing non-combo self-target and prefix-log cases stay green.

## PR

`fix(responses): let a combo shadow-call target enter the failover loop` — branch
`lane-a/1-4129`, PR base `dev`, bottom of the Lane A stack. Closes #4129.
