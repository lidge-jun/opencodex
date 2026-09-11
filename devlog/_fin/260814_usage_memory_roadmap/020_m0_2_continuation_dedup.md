---
title: "M0-2: Continuation overlap removal"
phase: "020"
depends: []
consumes: []
branch: codex/m0-2-continuation-dedup
closes: "(split from #1412)"
---

# 020 — M0-2: Stop compounding replayed history

## Audit history

**P stale check.** WP0 named the wrong mechanism. Compounding is the unconditional concat at
`src/responses/state.ts:895`, not a core.ts prepend. `_providerContinuation` carries provider
scalars, not history, so the draft plan to clear it would have broken Cursor while fixing
nothing.

**A round 1 — FAIL, 5 blockers.** All verified against the tree.

| # | Blocker | Disposition |
|---|---------|-------------|
| 1 | Stripping the id destroys Kiro/Cursor provider continuity for that turn | Folded — keep the id, add explicit disposition |
| 2 | Zero prefix length re-acknowledges historical compaction markers and duplicates guidance | Folded — record the recognized prefix |
| 3 | Strict raw prefix match rarely fires: the proxy mutates stored input | **Thesis narrowed** — see below |
| 4 | A bounded serialization SAMPLE can collide, causing a false skip | Folded — hard cap + "not comparable" |
| 5 | A new metric field breaks two privacy-pinned tests | Folded — internal counter, not `ResponseStateMetrics` |

The reviewer also refuted one bug I suspected in my own plan: stripping the id would NOT have
mis-set `_previousResponseInputExpanded`, because `core.ts:1521` requires both
`body !== originalBody` AND a surviving string id. Good to know, but blocker 1 removes the
strip anyway.

**A round 3 — FAIL, 4 blockers.** Third consecutive FAIL, so under LOOP-REPAIR-01 this stops
being a patch loop and returns to P with a changed plan. The change: **adopt the anchor rule
#1412 already arrived at** (`hasStableAnchor`) instead of continuing to invent one. That draft
is unmerged and its predicate is not in the tree, but its design was validated against real
incident traffic, and three rounds of independently re-deriving it have now failed.

| # | Blocker | Disposition |
|---|---------|-------------|
| 11 | Crossing `providerOutputStart` proves position, not identity | **Replan** — require provider-issued id on the anchor item |
| 12 | Spill persistence is a separate versioned shape; scope missed it | Folded — `spill-store.ts` + byte accounting + validation in scope |
| 13 | The thesis line still said layer 1 "bounds" the residual | Folded — stale sentence corrected |
| 14 | The 8 KiB cap was scoped to id-less items only | Folded — applies to every item |

### Blocker 11: position is not identity

Round 2's fix required the matched run to cross into `response.output`. That proves an item
sits on the provider side of the boundary — not that only the provider could have produced it.
An id-less assistant message satisfies the numeric anchor on content equality alone, which is
the round-2 ambiguity wearing a different hat.

The corrected rule needs both:

- exact bounded canonical content equality for **every** stored item, and
- at least one item at `index >= providerOutputStart` carrying a **non-empty provider-issued
  `id` or `call_id`**.

If no provider-output item supplies stable identity, expand. The reviewer notes this is what
#1412's `hasStableAnchor` does; that predicate is not in this tree
(`rg hasStableAnchor src/` → no match), so this layer implements the rule rather than
importing it.

On the question I asked directly — whether a client legitimately echoing assistant output
defeats the anchor — the answer is no, and for a satisfying reason: a client echoing provider
output *with the provider's own id* is replaying that exact occurrence, which is precisely what
we want to detect. The hole was only ever id-less output.

**A round 2 — FAIL, 2 High + 3 confirmations.** The round-1 fixes for B1, B2, B4, B5 were
verified correct. Two findings replace the predicate itself:

| # | Blocker | Disposition |
|---|---------|-------------|
| 6 | Value equality does not prove two items are the SAME historical occurrence | Folded — provider-output anchor required |
| 7 | "Layer 1 bounds the residual" overstates what M0-1 does | Folded — claim corrected |
| 8 | Type/comment contracts still say "the proxy expanded" | Folded — `src/types.ts` added to scope |
| 9 | The 8 KiB cap is right but the mechanism was underspecified | Folded — iterative writer with depth limit |
| 10 | The internal counter is never reset between tests | Folded — reset added |

### Blocker 6: equality is not identity, and the counterexample is one item long

Stored state flattens both sides of a turn into one array:
`items: [...inputItems(request.input), ...response.output]` (`src/responses/state.ts:1047`).
Nothing marks where the client's input ends and the provider's output begins.

The reviewer's counterexample needs only a single item. Turn 1 stores one user message
`"repeat"` with empty output. Turn 2 is a genuine delta that legitimately begins with another
`"repeat"` followed by `"new"`. The whole stored run fingerprints equal, so a
content-equality predicate skips — and silently deletes a real historical occurrence. That is
precisely the false skip this design calls the unacceptable failure.

The fix is to require evidence only the PROVIDER could have produced. `rememberResponseState`
knows the boundary at write time (`inputItems(request.input).length`), so it records it, and a
skip requires the matched run to include at least one item from the provider-output side.
A client cannot forge that anchor by repeating itself.

This expands scope into the stored-state shape, which round 1 had listed as out of scope. That
is the correct trade: the alternative is a predicate that can delete conversation history.

### Blocker 7: M0-1 does not bound this, and saying so was wrong

Round 1 justified narrowing by claiming unmatched sessions "hit a 413 instead of an OOM".
The reviewer disproved it in three steps: expansion and parsing happen at
`src/server/responses/core.ts:1510`, long before admission at `:1847`, so the concatenation
and its allocations are already done; admission fails open when no ceiling resolves
(`src/server/responses/input-admission.ts:165`); and compaction turns are exempt (`core.ts:1844`).

The honest statement, now in the doc: M0-1 refuses known-ceiling, non-compaction requests
before upstream dispatch. It does not prevent pre-admission materialization, and it is not a
reason to defer FU-2 indefinitely.

### Blocker 3 forces the thesis to narrow — this is the important one

`injectDeveloperMessage` splices proxy-authored developer items directly into `rawInput`
(`src/server/responses/collaboration.ts:491-497`), and `rememberResponseState` then stores
`[...inputItems(request.input), ...response.output]` (`src/responses/state.ts:1047`) — the
MUTATED input. Separately, passthrough JSON is recorded before client-facing item-id repair
(`src/server/responses/core.ts:2753` then `:2793`).

So stored state routinely contains items the client never saw, and ids the client saw in a
different form. A strict match on raw stored objects fails at item 0 for exactly those
sessions, and the compounding continues.

Two honest options:

- **Reconstruct a client-visible projection** of stored items — model proxy-only injection and
  id repair, then compare. That is a second implementation of two subsystems whose output is
  already hard to predict, and every future injection site silently degrades it.
- **Narrow the thesis** to what can be recognized soundly.

This layer takes the second. The claim becomes: *detect the case where the client verbatim
replays a conversation the proxy did not mutate, and stop doubling it.* That is the
stateless-client shape — no injected guidance, no repaired ids — and it is a real population,
but it is NOT all of #1412.

The gap is stated rather than papered over: **a session where the proxy injected guidance into
stored history is not deduplicated by this layer.**

What M0-1 does and does not do for that gap (corrected per blocker 7): it refuses
known-ceiling, non-compaction requests before upstream dispatch. It does NOT prevent the
concatenation or the parse, which happen at `core.ts:1510` well before admission at `:1847`,
and it fails open when no ceiling resolves. So the residual is reduced, not bounded, and FU-2
is real remaining work rather than something M0-1 has already covered.

The reviewer's judgment on whether to keep this layer at all: keep it. #1412 documents an
observed population — stateless DeepSeek tool-result turns that send full history alongside
`previous_response_id` — where 1x reconstruction was demonstrated. That is the population
this layer fixes.

## Thesis

When the client verbatim replays history the proxy stored unmodified, prepending the stored
copy doubles it, and the doubled turn is stored again, so the next turn triples. Detect that
exact case and skip the prepend.

Every ambiguity resolves toward expanding: a wrong skip silently truncates real conversation,
while a wrong expand is merely large. Note that layer 1 does not *bound* that residual — it
refuses known-ceiling, non-compaction requests before dispatch, but expansion and parsing
already happened by then (`core.ts:1510` vs `:1847`) and it fails open on unknown ceilings.

## Current state

- `src/responses/state.ts:895` concatenates unconditionally — the compounding site
- `src/responses/state.ts:899` records the prefix length via a WeakMap; `:376` documents it as
  the provenance boundary that acknowledges historical compaction markers exactly once
- `src/responses/parser.ts:372` uses `inputIndex >= replayedInputPrefixLength` to decide a new
  compaction boundary; Cursor turns that into `contextUsageReset`
  (`src/adapters/cursor/request-builder.ts:318`)
- `src/server/responses/collaboration.ts:455` scans only the replay prefix for existing guidance
- `src/server/responses/collaboration.ts:491` mutates `rawInput`, and `state.ts:1047` stores it
- `ResponseStateMetrics` (`state.ts:932`) has exactly 12 fields, pinned by
  `tests/memory-watchdog.test.ts:213` as a privacy review gate

## Design decisions

### Keep the id; skip only the concatenation (blocker 1)

`previousResponseProviderState(parsed.previousResponseId)` (`core.ts:1544`) is how Kiro and
Cursor recover their conversation ids; without the id Kiro mints a fresh UUID
(`src/adapters/kiro-wire.ts:112`) and Cursor starts a new conversation
(`src/adapters/cursor/request-builder.ts:283`). So the request keeps `previous_response_id`,
and only the input concatenation is skipped.

Consequence: `body !== originalBody` AND the id survives, so `core.ts:1521` would now set
`_previousResponseInputExpanded = true`. That is not a lie — the history IS present, the client
supplied it — and it is what the canonical-backend guard (`core.ts:1622`) and the Kiro guard
(`core.ts:2028`) need in order not to treat this turn as a replay miss (#702).

To keep "is the history present" separate from "did the proxy physically prepend it", the skip
returns a NEW object (a shallow copy with identical content). Identity changes, content does
not, and the disposition is recorded on the WeakMap alongside the prefix length.

### Record the recognized prefix length anyway (blocker 2)

The prefix length is not "how many items the proxy inserted" — `state.ts:376` defines it as the
boundary between replayed history and newly appended input. On a skip, the client supplied the
history, but the boundary is identical and still known: it is the number of stored items matched.

Recording it keeps two behaviors correct that would otherwise silently break:

- a historical `context_compaction` marker inside the replayed prefix is NOT re-acknowledged
  (`parser.ts:372`), so Cursor does not spuriously reset context usage
- `injectDeveloperMessage` still sees existing guidance in the prefix
  (`collaboration.ts:455`) and does not inject a duplicate

### A skip requires a provider-output anchor (blocker 6)

Content equality proves two items look alike, not that they are the same occurrence. Since a
client can legitimately repeat itself, a run of equal items is not evidence of replay.

`rememberResponseState` therefore records `providerOutputStart` — the index in `items` where
`response.output` begins.

Round 3 showed that reaching that index is not enough (blocker 11): position proves an item sits
on the provider side, not that the provider authored it, and an id-less assistant message
satisfies a positional anchor on content equality alone. The final rule is all three of:

- the matched run covers the whole stored entry,
- it reaches `providerOutputStart`, and
- some matched item at or past that index carries a **non-empty provider-issued `id` or
  `call_id`**.

There is no invariant that provider output always carries ids (`state.ts:1031` accepts arbitrary
output arrays), so when none does, the entry simply never skips.

Entries written before this field exists have no anchor, so they never skip and expand as
before.

### Only compare items that can be compared safely (blocker 4)

A sampled hash can collide, and a collision here silently replaces history — the exact failure
this design calls worse than expansion. And `JSON.stringify(item).slice(n)` serializes the whole
object anyway, so sampling does not even buy the cost saving it was meant to.

So every item — identified or not — is compared on bounded canonical content. An
`id`/`call_id` participates as additional occurrence evidence and never substitutes for content
equality, so the byte cap applies uniformly: an over-cap identified tool item is non-comparable
exactly like an over-cap message.

The cap must be enforced DURING canonicalization, not after (blocker 9): serializing first and
measuring afterward still traverses and allocates the whole oversized value, which is the cost
the cap exists to avoid. So the writer is iterative, counts UTF-8 bytes as it goes, aborts the
moment it passes 8 KiB, and carries a node/depth limit so a deeply nested item cannot blow the
stack. Over the cap returns **not comparable**, and any not-comparable item anywhere in the
stored run aborts the whole check — the reviewer confirmed aborting is right, since skipping
just that item could align different occurrences and manufacture a false positive.

### The counter stays internal (blocker 5)

`ResponseStateMetrics` is pinned at 12 fields by `tests/memory-watchdog.test.ts:213` precisely
so a new field gets privacy review before reaching `/api/system/memory`. This layer does not
need that surface, so the counter is a test-only export (like the existing
`*ForTests` helpers) and neither pinned test changes.

## File change map

### MODIFY: src/responses/state.ts

```diff
+/** Hard cap for canonicalizing ANY item. Past it, the item is not comparable. */
+const REPLAY_FINGERPRINT_MAX_BYTES = 8 * 1024;
+/** Node/depth ceiling so a deeply nested item cannot blow the canonicalizer. */
+const REPLAY_FINGERPRINT_MAX_DEPTH = 64;
+
+/**
+ * Canonical fingerprint for replay comparison, or null when the item cannot be compared
+ * safely.
+ *
+ * Iterative and byte-counted: it aborts the moment it passes the cap rather than
+ * serializing the whole value and measuring afterwards, because a tool result can be
+ * megabytes and this runs on the request path. String escaping is counted incrementally
+ * for the same reason.
+ *
+ * The cap applies to EVERY item, identified or not. An `id`/`call_id` is additional
+ * occurrence evidence, never a substitute for content equality, so an over-cap tool item
+ * is non-comparable exactly like an over-cap message.
+ */
+function replayItemFingerprint(item: unknown): string | null;
+
+/** Non-empty provider-issued `id`/`call_id` on an item, else null. */
+function providerIssuedIdentity(item: unknown): string | null;
+
+/**
+ * Number of leading stored items the client already carries verbatim, or 0.
+ *
+ * Requires an exact ordered run: every stored item must match the client input item at the
+ * same index. Any not-comparable item aborts to 0 -- skipping just that item could align
+ * different occurrences and manufacture a false positive.
+ *
+ * Note (FU-2): stored input can contain proxy-injected guidance the client never saw
+ * (collaboration.ts:491 -> state.ts:1047) and ids repaired after recording
+ * (core.ts:2753/2793). Those sessions do not match here and expand as before.
+ */
+function clientCarriedPrefixLength(stored: readonly unknown[], clientInput: readonly unknown[]): number;
```

Record the provider-output boundary at write time. Compute the normalized array ONCE and reuse
it for both fields, so the boundary can never disagree with the items it indexes:

```diff
   const clientThreadId = normalizedClientThreadId(opts?.clientThreadId);
+  const requestItems = inputItems(request.input);
   setResidentEntry(response.id, {
     createdAt: now(),
     ...(clientThreadId ? { clientThreadId } : {}),
-    items: [...inputItems(request.input), ...response.output],
+    items: [...requestItems, ...response.output],
+    // Where response.output begins. A replay skip requires a matched item at or past this
+    // index that also carries a provider-issued id -- position alone proves only that an
+    // item sits on the provider side, not that the provider authored it. Entries written
+    // before this field have no anchor and never skip.
+    providerOutputStart: requestItems.length,
   });
```

Inside `expandPreviousResponseInput`, before building the expanded object:

```diff
+  const clientInput = inputItems(request.input);
+  const stored = materialized.state.items;
+  const anchor = materialized.state.providerOutputStart;
+  // The client already replayed this history verbatim. Prepending the stored copy would
+  // double it, and the doubled turn is stored again, so the next turn triples (#1412:
+  // 127k -> 1.3M).
+  //
+  // Three independent conditions, all required. The run must cover the whole stored entry;
+  // it must reach the provider-output region; and some matched item in that region must
+  // carry a provider-issued id. Content equality alone cannot prove two items are the same
+  // occurrence -- a client repeating its own message produces an equal run without ever
+  // having seen this conversation -- and skipping on that would delete real history.
+  const carried = clientCarriedPrefixLength(stored, clientInput);
+  if (
+    carried === stored.length
+    && anchor !== undefined
+    && carried > anchor
+    && stored.slice(anchor, carried).some(item => providerIssuedIdentity(item) !== null)
+  ) {
+    replayOverlapSkips += 1;
+    // Keep previous_response_id: Kiro and Cursor recover their conversation ids from it
+    // (kiro-wire.ts:112, cursor/request-builder.ts:283). Only the concatenation is skipped.
+    const unchanged = { ...request };
+    // Same provenance boundary as a real expansion: the replayed prefix must not
+    // re-acknowledge historical compaction markers (parser.ts:372) and must stay visible
+    // to guidance de-duplication (collaboration.ts:455).
+    replayedInputPrefixLengths.set(unchanged, carried);
+    return unchanged;
+  }
```

Also: add `providerOutputStart` to the `measureResidentEntry` field list (`state.ts:127`) so
resident byte accounting does not undercount, thread it through the four manual spill-payload
constructions and `materializeEntry` (`state.ts:847`), and validate it on load as a safe
integer in `0..items.length`, discarding anything else to `undefined`. A malformed snapshot
must degrade to "never skip", never to a bad boundary.

Plus `replayOverlapSkipsForTests()` (NOT a `ResponseStateMetrics` field) and
`replayOverlapSkips = 0` in `clearResponseStateMemoryForTests` (`state.ts:1079`).

### MODIFY: src/responses/spill-store.ts

`ResponseSpillPayload` (`spill-store.ts:33`) is the durable spill shape and is versioned
separately from the resident entry, so the anchor has to be added there too or a spilled entry
silently loses it and stops skipping after a restart:

```diff
 export interface ResponseSpillPayload {
   version: 1;
   responseId: string;
   createdAt: number;
   clientThreadId?: string;
   items: unknown[];
+  /** Index in `items` where provider output begins; see state.ts replay-overlap detection. */
+  providerOutputStart?: number;
   providers?: OcxProviderContinuationState;
 }
```

Compatibility here is **one-way, and the doc says so** rather than claiming more (blocker 12).
`validPayload` is a strict key allowlist (`spill-store.ts:264`): unknown keys make a payload
*corrupt*, not merely unrecognized. So a new build reads old payloads fine — the field is
absent and the entry never skips — but an older build would reject a new payload outright.

That is acceptable for a forward-only upgrade and unacceptable for a downgrade, so the
allowlist gains `providerOutputStart` in the same change that starts writing it. A rollback
across this commit invalidates spilled entries, which degrades to a replay miss (already a
handled path, `state.ts:840`), not to corruption of live state.

### MODIFY: src/types.ts

The two provenance fields describe a condition, not an action, so their contracts are corrected
rather than left false (blocker 8). The reviewer confirmed no consumer depends on the literal
"the proxy inserted these" reading:

```diff
-  /** Number of leading raw input items restored from local previous_response_id state. */
+  /**
+   * Boundary between replayed history and this turn newly appended input. Usually the
+   * items the proxy restored; also set when the CLIENT carried that history verbatim and
+   * the proxy skipped the prepend (see expandPreviousResponseInput).
+   */
   _replayPrefixLen?: number;
-  /** True when the proxy expanded a previous_response_id request into a full input replay. */
+  /**
+   * True when the full history for a previous_response_id request is present in the input --
+   * whether the proxy expanded it or the client already carried it. Consumers use this to
+   * mean "this request is self-contained", never "the proxy mutated it".
+   */
   _previousResponseInputExpanded?: boolean;
```

The matching "Expansion provenance" comment at `src/responses/state.ts:376` is reworded the
same way.

### NEW: tests/continuation-dedup.test.ts

1. Client verbatim-replays full stored history including identified provider output → 1x
2. The same call three times → still 1x, not 2x/3x
3. Delta continuation (new items only) → expands exactly as today
4. **A client repeating an identical message does NOT skip** — stored `["repeat"]` with empty
   output, client sends `["repeat", "new"]` (blocker 6)
5. **A run reaching id-less provider output does NOT skip** (blocker 11)
6. **A stored entry with no provider output never skips** (blocker 6)
7. **A legacy entry without `providerOutputStart` never skips** (back-compat)
8. **A malformed `providerOutputStart` (negative, > items.length, non-integer) degrades to
   never-skip** (blocker 12)
9. **A spilled-then-materialized entry keeps its anchor and still skips** (blocker 12)
10. **A snapshot restart preserves the anchor** (blocker 12)
11. Resident byte accounting includes the new field (blocker 12)
12. Partial overlap → expands; reordered items sharing a set but not a sequence → expands
13. Empty client input + stored history → expands normally
14. `previous_response_id` survives a skip, so provider continuity is intact (blocker 1)
15. A skip records the prefix length, so a historical `context_compaction` marker is NOT
    re-acknowledged, and guidance is not injected twice (blocker 2)
16. Two id-less items sharing a long prefix but differing in the tail do NOT fingerprint equal
17. **An over-cap item is non-comparable even WITH an id, and canonicalization stops early
    rather than serializing the whole value** (blocker 14 / 9)
18. A deeply nested item hits the depth limit → not comparable, no stack overflow
19. `responseStateMetrics()` still returns exactly 12 fields (blocker 5)
20. `clearResponseStateMemoryForTests()` resets the skip counter (blocker 10)
21. Existing `tests/responses-state.test.ts` and the spill suite stay green

## Activation scenario

The #1412 population: a stateless provider (DeepSeek tool-result turns) where the client sends
the full conversation AND `previous_response_id`. Today turn 3 sends 50 stored + 50 client =
100 items, then 150. With the skip it stays at 50.

Observable proof in C: assert the item count equals the client input count AND that
`replayOverlapSkipsForTests()` incremented — a silent no-op is otherwise indistinguishable
from a working skip.

## Follow-ups (not this layer)

- **FU-2: client-visible projection for overlap detection.** Recognize replays of history the
  proxy mutated (injected guidance, repaired ids). Needs a sanitized #1412 fixture first;
  designing it blind is how the round-1 predicate got written. Explicitly NOT covered by M0-1:
  admission runs after expansion and parsing, and fails open on unknown ceilings.

## Scope boundary

IN: overlap detection, the `providerOutputStart` anchor and its persistence through resident
entries, spill payloads, byte accounting and load validation, the internal counter and its
reset, the two provenance contracts in `src/types.ts`, the test file
OUT: `ResponseStateMetrics` and `/api/system/memory`, the scope-mismatch path,
`_providerContinuation` semantics, the injection sites in `collaboration.ts`, and
client-visible projection (FU-2)
