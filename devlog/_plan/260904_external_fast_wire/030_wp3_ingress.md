# 030 — wp3 / PR3: the ingress round-trip


## Amendments from audit round 1

### A1 — Claude surfaces parse AFTER alias decoding (B1)

A Claude alias is `claude-ocx-<provider>--<model>` (`src/claude/alias.ts:89`): it already
uses `--` as its own separator. A real model named `foo--fast` therefore produces
`claude-ocx-p--foo--fast`, and stripping the marker off the RAW alias yields
`claude-ocx-p--foo`, which routes `p/foo` — a different model, silently, with no error.
`knownEffortRowIds()` holds routed ids, not Claude aliases (`effort-row.ts:44`), so it
cannot defend the raw form.

So on `/v1/messages` and `/v1/messages/count_tokens` the marker is stripped only after the
alias is decoded, and the known-id check runs against the decoded routed id where the
inventory is authoritative. The alias's own separator is the FIRST `--` after the prefix
and the fast marker is the LAST one in the model half, so the two are unambiguous once
decoding has happened — and ambiguous before it.

### A2 — every ingress parses the IMMUTABLE original selector (B5)

The original wp3 draft parsed the effort row, mutated `parsed.modelId`, then parsed fast
from the mutated value. That made `x--fast--high` fire both dimensions while
`x--high--fast` fired neither, and Chat and Messages — parsing from the unmutated
requested id — disagreed with Responses about the same string.

Every ingress now captures the requested id once, checks `hasCompositeRowMarkers()` first
(wp1), and parses both grammars from that captured value:

```ts
const selector = parsed.modelId;             // captured BEFORE any mutation
if (!hasCompositeRowMarkers(selector)) {
  const effortRow = parseRequestEffortRowId(selector, config);
  const fastRow = parseRequestFastRowId(selector, config);
  // ... apply at most one
}
```

### A3 — `/v1/messages/count_tokens` (B4)

`claude-messages.ts:1022` resolves a model and can hand it to `wantsNativePassthrough` at
`:1036`. Without parsing, a listed fast alias is forwarded upstream as a model Anthropic
has never heard of. It needs the model rewritten to the base before that guard — and
nothing else, because `count_tokens` returns a token estimate and sends no tier:

```diff
   const countRoute = extractOcxRouteDirective(raw);
   if (countRoute) { model = stripOneMillionMarker(countRoute); raw.model = model; }
+  // A token estimate carries no tier, so only the identity is corrected here. Without this
+  // the synthetic id reaches native passthrough as an unknown upstream model.
+  const countFastRow = parseRequestFastRowId(model, config);
+  if (countFastRow) { model = countFastRow.baseId; raw.model = model; }
```

### A4 — `/v1/responses/compact` (B4)

`compact.ts:502-515` routes `raw.model` through `routeCompactionModel` with no tier
handling, so a fast id selected from `/v1/models` would fail to route at compaction time.
Parse before the routing call and carry the tier, since compaction is a real turn:

```diff
+  const compactFastRow = parseRequestFastRowId(raw.model, config);
+  if (compactFastRow) {
+    raw.model = compactFastRow.baseId;
+    (raw as Record<string, unknown>).service_tier = "priority";
+  }
   route = routeCompactionModel(config, raw.model, evidenceFromBody(raw));
```

### A5 — additional tests

8. `count_tokens` with a fast alias returns an estimate for the BASE model and does not
   forward the synthetic id upstream.
9. `compact` with a fast id routes the base model and reaches the adapter with the tier.
10. A real model literally named `foo--fast` routes to ITSELF on every ingress, including
    through its Claude alias. This is the B1 regression and it fails against the pre-audit
    design.
11. `x--high--fast` and `x--fast--high` resolve to neither grammar, identically on all
    five surfaces.

### A6 — scope

Scope IN gains `src/server/responses/compact.ts` and the `count_tokens` handler in
`src/server/claude-messages.ts`.

Stacked on PR2. Scope IN: `src/server/responses/core.ts`, `src/server/chat-completions.ts`,
`src/server/claude-messages.ts`, `tests/fast-row-ingress.test.ts` (new). Scope OUT: the tier
state machine itself — wp3 supplies a caller intent and lets `decideTier` rule on it.

## The one rule this phase obeys

A fast row sets `service_tier: "priority"` as a **caller-supplied tier** and changes nothing
else. It never writes `tierDecision` and never bypasses `decideTier`. Everything that already
governs Fast keeps governing it:

- `fastMode: false` still suppresses the request (`fastwire.ts:420` returns `{kind:"drop"}`
  even for an explicit caller tier). An operator who turned Fast off globally is not
  overridden by a client picking a fast row.
- An ineligible route still drops the tier (`fastwire.ts:413`), so a stale client holding a
  `--fast` id after the model lost eligibility degrades to a normal request rather than
  erroring.
- Pricing and usage keep reading the same `tierDecision`, so no cost path changes.

`"priority"` is the canonical spelling; `"fast"` is accepted as an alias and folded to it
(`fastwire.ts:247`). wp3 writes the canonical value.

## `/v1/responses`

Two insertion points, both alongside the existing effort-row handling.

The combo pre-dispatch at `core.ts:2726` runs before `comboIdFromRawBody`, so the rewrite has
to happen there or a combo child is built from the synthetic id:

```diff
     const comboEffortRow = typeof (body as { model?: unknown }).model === "string"
       ? parseRequestEffortRowId((body as { model: string }).model, config)
       : null;
+    const comboFastRow = typeof (body as { model?: unknown }).model === "string"
+      ? parseRequestFastRowId((body as { model: string }).model, config)
+      : null;
+    if (comboFastRow) {
+      const raw = body as Record<string, unknown>;
+      raw.model = comboFastRow.baseId;
+      // A caller intent, not a decision: decideTier still rules on eligibility below.
+      raw.service_tier = "priority";
+    }
```

The ordinary path at `core.ts:2795` must update both representations, for the reason the
effort row already does: the typed route reads `parsed.*` while the Responses passthrough
starts its outbound body from `parsed._rawBody` (`openai-responses.ts:2179`).

```diff
     const effortRow = parseRequestEffortRowId(parsed.modelId, config);
     ...
+    const fastRow = parseRequestFastRowId(parsed.modelId, config);
+    if (fastRow) {
+      parsed.modelId = fastRow.baseId;
+      parsed.options.serviceTier = "priority";
+      const raw = parsed._rawBody as Record<string, unknown>;
+      raw.model = fastRow.baseId;
+      raw.service_tier = "priority";
+    }
```

Downstream is untouched: `core.ts:2109` reads `parsed.options.serviceTier` as `callerTier`,
`decideTier` rules, and `applyTierDecisionToResponsesBody` writes the final field.

**Core-lab boundary.** `src/server/responses/core.ts` is one of the four protected roots
(`tests/core-lab-boundary.test.ts:19`). `src/server/fast-row.ts` imports only
`providers/service-tier`, `providers/registry`, `types`, and `server/effort-row` — all already
on this file's import graph, none reaching `src/lab`. The guard must stay green without
adjustment; if it does not, the import is wrong, not the guard.

## `/v1/chat/completions`

Same place as the effort row, before routing (`chat-completions.ts:107`):

```diff
     const effortRow = parseRequestEffortRowId(requestedModel, config);
     if (effortRow) chatBody.model = effortRow.baseId;
+    const fastRow = parseRequestFastRowId(requestedModel, config);
+    if (fastRow) {
+      chatBody.model = fastRow.baseId;
+      chatBody.service_tier = "priority";
+    }
```

Unlike the effort row, a fast row does **not** block the native-chat shortcut at
`chat-completions.ts:139`. The effort row has to, because native chat cannot carry a
Responses-style reasoning effort. Native chat carries `service_tier` natively and applies
the same policy (`openai-chat.ts:144-150`), so blocking it would degrade the request for no
reason. Leaving that guard alone is the change.

The translated path needs nothing: `chat/inbound.ts:315` already copies
`raw.service_tier` into the Responses body.

## `/v1/messages`

Parse after the `ocx-route` directive, like the effort row (`claude-messages.ts:629`), so a
fast id inside a directive works too:

```diff
     effortRow = parseRequestEffortRowId(requestedModel, config);
     if (effortRow) { anthropicBody.model = effortRow.baseId; effortOverride = effortRow.effort; }
+    const fastRow = parseRequestFastRowId(requestedModel, config);
+    if (fastRow) anthropicBody.model = fastRow.baseId;
```

The Anthropic translator does **not** carry `service_tier` — `claude/inbound.ts:500` builds
its body from model/input/store/stream plus sampling fields only. So the tier is applied to
the translated body, immediately after translation (`claude-messages.ts:670`):

```diff
     const translation = anthropicToResponsesTranslation(anthropicBody, ...);
     internalBody = translation.body;
+    // The Anthropic translator carries no service_tier, so the caller intent is applied to
+    // the translated body rather than the inbound one.
+    if (fastRow) internalBody.service_tier = "priority";
```

Native Anthropic passthrough at `claude-messages.ts:660` **must** be blocked for a fast row,
the opposite of the chat case: that path forwards the request to Anthropic's own API, whose
wire has no `service_tier` field, and the `anthropic-speed` FastWire kind has an empty
adapter set by design (`fastwire.ts:15`). Sending it there would silently drop the tier.

```diff
-    if (!effortRow && ... wantsNativePassthrough(...))
+    if (!effortRow && !fastRow && ... wantsNativePassthrough(...))
```

In practice an `anthropic`-adapter route is `wire-unavailable` and never publishes a fast
row at all, so this guard is defence for a hand-typed id rather than a listed one.

## Tests — `tests/fast-row-ingress.test.ts`

Each test drives one conditional and asserts an observable effect, per
`cursor-fast-tier.test.ts:31`.

1. **Responses:** a `--fast` model resolves to the base model and reaches the adapter with
   `service_tier: "priority"`. Assert on the outbound body, not on `parsed`.
2. **Chat completions:** same, through the translated path.
3. **Messages:** same, and assert the native passthrough was not taken.
4. **Flag off:** the same `--fast` id is treated as an ordinary unknown model on all three
   ingresses — no rewrite, no tier. This proves default-off at the request path, not only
   at listing.
5. **Ineligible route:** a `--fast` id on a `capability-unsupported` model reaches the
   adapter with **no** `service_tier` — `decideTier` dropped it. The route still resolves
   to the base model.
6. **`fastMode: false` wins:** a `--fast` id with the global switch off produces
   `{kind:"drop"}`. The operator's switch is not overridable by id.
7. **Round-trip identity:** the id published by wp2 for a model parses back to exactly that
   model. This is the equivalence guard `cursor-fast-listing.test.ts:27` uses, and it is
   what keeps listing and ingress from drifting apart.

## Verification

`bun test tests/fast-row-ingress.test.ts tests/fast-row-listing.test.ts tests/fast-row.test.ts`,
`bun test tests/core-lab-boundary.test.ts` (mandatory: a protected root was touched),
`bun run typecheck`, `bun run privacy:scan` (request-path change). No full suite.
