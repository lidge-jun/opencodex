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
