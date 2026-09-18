# 010 — Cross-merge audit findings

Five reviewers read the merged state on `dev` rather than any single pull
request's diff, one per contended file group. Four groups came back clean. One
found a real regression, and it is fixed on this branch.

## Clean

**Account routing** — the highest-risk group, and the one the audit was really
for. Three sessions changed account-binding behavior in sequence. The reviewer
established first that they were sequential rather than parallel: the cache-safe
replacement landed first, the cache-affinity default was rebased on top of it and
updated the earlier tests explicitly, and the transient-hold change describes
itself as a follow-up from reviewing the merged commit. Then it verified the
thing that actually mattered — that the cache-safe replacement is still reachable
now that affinity defaults on — by tracing that a fully spent account remains
selectable, so the rebind branch is still entered. It also confirmed the
transient-hold path and the quota-rebind path are mutually exclusive, since one
requires a soft-avoided account and the other requires a selectable one.

**Responses and Anthropic** — the ChatGPT control strip still applies on the code
paths the later merges added, because recovery and 401 replay both rebuild
through the same adapter. Opaque-blob recovery and forward-identity sanitation
compose rather than collide: an identity mismatch strips the blob before the
first send, so there is nothing left for recovery to act on.

**Chat image pipeline** — three merges on one pipeline, and the question was
whether the final-boundary refusal can now reject something the earlier
normalization deliberately produced. It cannot: the normalizer only emits Chat
image objects carrying a URL, and the refusal only matches audio, file, document
and file-id-only inputs. Those sets do not intersect.

**Config schema and CLI** — the auto-refresh section still degrades to off when
absent, and the terminal-escaping wrapper still wraps the diagnostics that the
runtime-discovery change now produces. That second one is worth noting because
those two changes are exactly the pair whose test-file conflict was resolved by
hand during round 1.

## Finding, fixed here

`src/web-search/passthrough-bridge.ts` — a mixed leg whose upstream terminal was
`response.failed` released its withheld client-executed tool call.

The merge that added mixed-tool leg termination reordered the decision so the
failed/incomplete terminal is checked before the client-executed-call case, and
routed both terminals to the same `endWithoutSearch` branch, which calls
`flushHeldCalls()`. Ten lines above it, the failure path documents the opposite
rule in as many words: releasing a tool call Codex would start executing is
exactly what must not happen. Before that reordering, a mixed leg with a failed
terminal went to the failure path and dropped the held call.

The two terminals are not interchangeable. `response.incomplete` leaves a turn
the client can still act on, so handing its call back is right. `response.failed`
does not, and releasing the call there starts work inside a dead turn.

The fix splits them on that distinction rather than reverting the reordering: the
decision now carries whether held calls may be released, true only for
`incomplete`, and the emit path drops them otherwise. The hosted cell still
closes in both cases, which is what the reordering was for in the first place.

A regression test sits directly beside the existing incomplete-terminal test, as
its sibling, asserting that no function call and no call id reach the client on a
failed terminal.

This was an intra-commit defect rather than a two-lane collision. The audit found
it anyway, because reading the merged file against its own documented invariants
is the same activity either way.
