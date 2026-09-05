# 010 — Requested fallback model attribution

## Status and scope

Proposed implementation plan, not implemented or tested. Parent owns orchestration,
implementation, UI coordination, and verification. This delegated task writes only
this document. No local tests, inference, credentials, or user ledger reads.
Source anchors refer to the inspected checkout and must be refreshed if it moves.

This is an accounting/selection-contract repair, not a model allowlist or provider
capability claim. Keep all historical provider identities, tokens, requests,
attempts, timestamps, and selectors. No ledger rewrite, new history database,
guessed actual model, quota changes, or broad restriction on native slash IDs.

## Decision

Annotate all proven unchanged default-provider selectors (including bare gemini/qwen) as
unresolved requested models. Do not move usage to the provider named by a prefix.
Leave routing of ordinary native slash IDs and bare fallback models unchanged.
Reject missing reserved policy selectors prospectively.

Route trace alone proves fallback provenance, not whether a remote aggregator
recognizes that selector. Therefore "unresolved" means not resolved by this
router to a known model identity; it does NOT mean invalid upstream or unsupported.
Never use today's config/catalog membership to reconstruct historical routing.
No annotation also does NOT mean actual-model confirmation. Existing resolvedModel
is insufficient: src/server/responses/compact.ts:552-558 fills it from routing
before upstream execution; src/server/responses/core.ts:2101 does likewise for
virtual wire identities.

## Diff 1 — One read-time identity classifier

Add a small pure owner, src/usage/model-identity.ts, reused by summary and Logs cost
projection. Existing ownership searched: usageModelIdentity (summary.ts:339),
computeEntryCost (:207), estimateAttemptCost (cost.ts:528), estimateRequestCost
(:610), and persisted routeDecision (log.ts:152). No equivalent classifier exists
in the inspected usage module. Keep Antigravity canonicalization in its existing
owner; classify the original row BEFORE display canonicalization.

Proposed isUnresolvedRequestedModel(source, target) predicate:

1. source.routeDecision exists, routeKind is default-provider, selected.reason is
   default-provider, and truncated.strings is not true.
2. selected.model is nonempty. A separate slash predicate controls pricing restriction.
3. trace.requestedModel === selected.model: the router forwarded it unchanged.
4. target.model === selected.model and the recorded target provider matches the
   recorded selected provider (exact, or existing baseProviderLabel normalization
   for account-log labels; no config lookup).

For parent-only rows target is the entry; with attempts it is EACH physical
attempt independently. Do not apply a parent decision to a different attempt.
Do not use source.requestedModel in place of trace.requestedModel: preprocessing
may have rewritten the route selector. Do not derive confirmation from an echoed
resolvedModel. Missing, truncated, or nonmatching trace remains unclassified.
This deliberately fixes proven cases without inventing missing historical facts.

Examples: unchanged default-provider anthropic-looking, cursor-looking, and
historical policy selectors qualify by structure/evidence, not a vendor list.
Bare kimi-k2.5, claude-opus-5, and other unslashed fallbacks qualify for the provenance marker but retain their existing price eligibility.
Configured explicit-provider native slash IDs and policy/combo target selections
do not qualify. A genuine native slash ID forwarded through default-provider CAN
qualify: that is honest unresolved routing provenance, not grounds to reject it.

Relevant route facts: src/router.ts:676-687 allows native slashes to fall through;
:794 forwards unchanged; :800-821 records requested/selected identity.
Trace bounds and immutable selection semantics: src/routing/trace.ts:5-14.

## Diff 2 — Compatible summary annotation, no regrouping loss

Use additive hasUnresolvedRequestedModel?: true on UsageAttribution,
UsageModelAccumulator, UsageModel, and UsageDayModel in src/usage/summary.ts.
Meaning: this row includes at least one proven unresolved requested-model
attribution. Do not call the opposite state confirmed.

Full propagation chain:

- :322, :339-383 — attribution type and parent/attempt identity construction;
  preserve model/resolvedModel/raw data, add only the derived marker.
- :59 and :73 — daily and overall public model-row types.
- :516, :673 — accumulator type and initialization.
- :1132-1146 — OR the marker on every matching addition, not only first creation.
- :698 and :706 — clone preserves it; merge ORs it regardless of firstSeen.
- :830 — overflow may OR it with the same "includes" semantics.
- :867 and :889 — emit it in BOTH daily and overall model rows.

Keep usageModelKey (:359), provider attribution, model IDs, filter matching
(:797-825), totals, and attempt/request deduplication unchanged. No decorated
display text becomes a model key. Mixed rows say "Includes unresolved requested
model usage"; the marker does not imply every token in the row is unresolved.
Exact splits/counts by provenance are unnecessary for this patch.

The attribution layer also modifies `gui/src/components/provider-workspace/types.ts`,
`ProviderWorkspaceShell.tsx` and `ProviderUsage.tsx`: carry the optional field from
the API row to `ProviderModelUsageRow` and show a translated inline annotation
"Includes unresolved requested model usage" below the original selector. Use the
same annotation in the model table rather than silently dropping historical rows.
All locale modules receive the corresponding key. Keep grouping by m.provider;
recompute `shareRatio` from selected-provider token total, not the global summary,
so the screenshot's nearly empty bars become meaningful within each provider.
Test propagation and selected-provider shares with existing provider workspace
tests. Extract only that existing grouping into `buildProviderModelUsage` in the
existing pure `gui/src/provider-workspace/usage.ts` owner; no parallel client or
state. NEW `gui/tests/provider-usage-attribution.test.tsx` directly exercises the
production helper plus rendered ProviderUsage. Increment the provider usage session-cache version to prevent stale derived
rows after update. Backend marker alone is not UI completion.

## Diff 3 — Restrict only unsupported cross-provider price inference

Do NOT unprice every default-provider route and do NOT globally remove vendor
fallback. Bare fallback models retain their existing pricing exactly.

In src/usage/cost.ts add an optional final price-resolution options parameter,
allowModelLevelFallback?: boolean (default true), propagated through
resolveMatchedPrice (:176), inner/exact resolution (:221/:243), and any
Antigravity secondary lookup. When false, preserve all exact provider/selector
sources: user overlay, verified override, provider metadata bundle, expected
overlay. Only replace the call to resolveModelLevelPrice at :283 with null.

Include this mode in priceMemo's key (:203-209), or bypass memoization for the
restricted mode. Normal and restricted calls must never reuse each other's
cached results. Preserve existing provider-label and user-overlay precedence.
Provider-specific rate evidence is a pricing contract, not model confirmation.

Add optional allowModelLevelFallback to estimateRequestCost's input (:610) and
the transient attempt estimate input type (:528/:569); do not add it to persisted
usage types. estimateComboCost forwards each transient attempt's option through
estimateAttemptCost. Derive false only for predicate-positive attributions whose selector contains a slash.

In summary.ts:207 computeEntryCost, annotate shallow transient attempt copies
with this option and pass it for parent-only requests. Never mutate attempts or
overwrite model with display text. Preserve partial priced-attempt summary sums;
null estimates remain unpriced, not zero-token/zero-dollar measurements.

In src/server/management/shared.ts:96 extend MetricSource with optional
routeDecision. In costResult (:132-136) apply the SAME classifier to parent or
each attempt before calling estimators. Otherwise Logs retains the wrong price
after Summary is fixed. Preserve estimateComboCost's all-attempts-or-null behavior
and existing unavailable reasons (:113-128); do not import summary.ts into this
consumer. Also update `requestLogDto` in shared.ts:165: its
individual attempt `costResult` call must carry the parent routeDecision while
matching each attempt's own provider/model. Add parent/attempt/Summary agreement
cases to `tests/server/management-api-logs-metrics.test.ts`.
This is a required implementation scope extension beyond the initial
delegated server-error-only investigation, now explicitly identified for parent.

Legitimate aggregator behavior: explicit provider native slash routes retain all
pricing; default-provider native slash routes still execute, and retain exact
provider/user rates. Only a vendor-only inferred price becomes unavailable when
the trace proves unresolved slash fallback. Trace alone cannot safely exempt a
genuine aggregator's uncatalogued default-fallback ID while rejecting the same
shape under Kimi. An exemption would require a separate explicit provider/model
contract, not a prefix/catalog guess; no such framework is added in this patch.

## Diff 4 — Missing policy fails with existing wire error shape

In src/router.ts near NoEligiblePolicyCandidateError (:49), add exported
UnknownRoutingPolicyError extends Error with readonly profileId and distinct
name/message "Unknown routing policy: <id>". Do not subclass
NoEligiblePolicyCandidateError or fabricate an evaluation trace.

At routeModelInternal:603-612, before any provider/default resolution and only
when !bypassCombos, detect the explicit reserved policy/ prefix independently of
resolvePolicyProfileId. If no profile resolves, throw the new error. This must
also reject policy/ with empty suffix (parsePolicyModelId at profile.ts:111-115
currently returns null). A resolved alias with an unavailable profile also fails.
Preserve valid profile evaluation, alias matching, and concrete recursion bypass.
Do not widen this into a ban on unknown provider prefixes or arbitrary slash IDs.

Wire contract is 404 with error.type=invalid_request_error:

- Responses core.ts:2964-2973 and reroute catches :3074/:3198 already map ordinary
  routing errors to that response; no new status/envelope is necessary.
- Compact compact.ts:529-536 already has the same generic mapping.
- Chat chat-completions.ts:148-155 and Messages claude-messages.ts:765-771 must
  explicitly catch UnknownRoutingPolicyError and return their existing protocol
  error helpers, with existing final-request-log handling. Do not fall through
  preprocessing to a second route attempt. Only NoEligiblePolicyCandidateError
  carries err.trace; keep the two branches/types distinct.

Historical successful missing-policy entries remain unchanged and annotated on
read. Rejection applies only to new requests.

## Regression ledger (parent executes remotely; none run here)

Extend existing files, avoiding new test-file registration churn:

- tests/usage/usage-summary.test.ts: synthetic trace fixtures for the supplied
  Kimi slash shapes and historical policy shape; parent-only and attempts; exact
  request/token/provider preservation; daily/overall marker; mixed rows in either
  order; partition merge, overflow and filtered/cache parity. Legitimate bare
  fallback keeps price. Missing/truncated/nonmatching trace is not inferred.
- tests/usage/usage-cost.test.ts: restricted mode suppresses vendor-only pricing;
  exact user/provider rates remain; alternate restricted/normal calls to catch
  memo pollution; native aggregator slashes and bare vendor fallback retain normal
  behavior. Existing kiro case :170 and aggregator cases :1330 must stay valid.
- tests/usage/usage-aggregate-cache.test.ts: append/rebuild projections agree on
  marker and price without touching ledger records.
- tests/usage/usage-surfaces.test.ts (inspect existing helpers first): Logs cost
  and Summary agree on eligibility, while retaining their documented partial-sum
  versus whole-combo unavailable behavior.
- tests/routing/policy-execution.test.ts: replace the fallthrough expectation at
  :237; missing and empty reserved policies throw the distinct class; valid alias,
  no-eligible trace, native slash routing, bare fallback and concrete target
  non-recursion remain unchanged.
- tests/routing/routing-policy-surface-parity.test.ts: handler-level missing-policy
  cases for Responses/Chat/Messages, streaming and nonstreaming; assert 404/type
  and zero adapter dispatch. Add compact coverage using its existing handler
  fixture owner, identified before implementation. No inference fixture.

Parent verification: direct TypeScript checker already selected in 000; focused
regressions in remote CI at exact head; API/browser evidence for annotation via
the existing UI owner; unchanged ledger evidence. Do not run local tests/hooks.
User-facing contract docs need a small update in the parent's normal docs scope;
document unresolved selector semantics and missing policy 404, not model support.

## Risks and acceptance

Do not mistake unclassified history for confirmed attribution. Truncated traces
and retargeted attempts intentionally remain outside positive classification.
Do not broaden the pricing suppression to bare fallback models or make a provider
catalog the historical oracle. Bare fallback marker tests must assert unchanged
pricing alongside the annotation. Keep all ledger writes and quota changes out.

Accept when proven slash fallback rows are visibly qualified under their recorded
provider, preserve tokens/counts, and no longer inherit a foreign vendor-only
price; normal bare/explicit-aggregator pricing is unchanged; reserved missing
policies return compatible errors before dispatch; Summary and Logs use one rule.
