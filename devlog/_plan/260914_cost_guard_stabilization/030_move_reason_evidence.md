# 030 — wp3: every move says why

## Today

There is no account-move metric and no persisted move reason. `logCtx.affinity` is
typed as `reused | new_bind | rebound | cleared` but never assigned, and
`appendUsageEntry` would drop it. `src/codex/affinity-debug.ts` is an opt-in
HMAC-tagged header diagnostic for account-switch **compatibility** failures, not a
record of routing decisions. The only way to infer a move today is to read account
labels across log lines, which is how #4546 had to be diagnosed in the first place.

Cache accounting has a related gap. Missing cache information is correctly omitted
rather than stored as zero on `OcxUsage`, and `cacheHitRate` is `null` when
unobserved — but the bridged Responses, Chat and Anthropic paths always emit
`cached_tokens: 0`, and Kiro always writes 0. A reader cannot distinguish "the
provider reported no cache hit" from "the provider reported nothing", which is
precisely the distinction needed to tell whether a routing change worked.

## The rule

A live-binding move is a decision the operator paid for, so it carries its reason:
which cause fired (`soft-quota`, `quota-refusal`, `exhausted`, `transient-hold-expired`,
`unusable`, `paused`, `generation`, `expired`, `detour`), and whether the binding
was held or released. The reason rides the existing per-attempt record in
`usage.jsonl` — the one surface that already has attempt granularity — so the GUI
Logs attempt view and `ocx logs explain` can render it without a new store.

Missing cache information stays `unknown`. A synthesized `cached_tokens: 0` on a
bridged path is a reporting artifact and must not aggregate as a measured miss.

## Scope for this unit

wp3 lands the reason at the decision point and the record, because that is what
makes the wp2 and wp3 rules auditable in the field rather than only in tests. The
dashboard rendering and the amplification metric (sends per logical request) belong
with wp4, where the send budget gives them a denominator that means something.

## Outcome

Closed. `resolveCodexAccountForThreadDetailed` now returns a `CodexAffinityDecision` on every
selection path, the pool auth context carries it, and `logCtx.affinity` / `logCtx.affinityReason`
are assigned in `core.ts` (`849f3c9ccf`). A release recorded by the outcome path -- a 429
clearing the pin -- is held per thread, bounded at 4096 entries, and consumed by that thread's
next resolve.

Two audit rounds changed the shape, and both corrections are worth keeping:

The reason was being synthesized at the call site instead of read from the guard that actually
refused the account. It now comes from `codexAccountBlockReason`, and a release survives a
resolve that finds no account at all (`b8d90ba3a8`, closing #4598).

`appendUsageEntry` builds the persisted entry from an explicit field whitelist, so the affinity
fields the writer set were dropped silently by the normalizer and the whole feature was a no-op
end to end. `ab6fd697c1` adds them to the whitelist and surfaces the decision in the route
explanation. The general lesson for anything downstream of the usage log: a field the writer
sets but the normalizer does not name does not exist.

What wp3 deliberately did not do: render the reason in the dashboard, and count sends per
logical request. Both wait for wp4's budget to give them a denominator.
