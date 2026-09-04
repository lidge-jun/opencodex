# 030 — wp3 / PR3: the ingress round-trip

Stacked on PR2. Scope IN: `src/server/responses/core.ts`, `src/server/chat-completions.ts`,
`src/server/claude-messages.ts` (both the messages handler and `count_tokens`),
`src/server/responses/compact.ts`, `tests/fast-row-ingress.test.ts` (new). Scope OUT: the
tier state machine itself — wp3 supplies a caller intent and lets `decideTier` rule on it.

## The rule every surface obeys

A fast row sets `service_tier: "priority"` as a **caller-supplied tier** and changes nothing
else. It never writes `tierDecision` and never bypasses `decideTier`. Everything that
already governs Fast keeps governing it:

- `fastMode: false` still suppresses the request (`fastwire.ts:420` returns `{kind:"drop"}`
  even for an explicit caller tier). An operator who turned Fast off globally is not
  overridden by a client picking a fast row.
- An ineligible route still drops the tier (`fastwire.ts:413`), so a stale client holding a
  `--fast` id after the model lost eligibility degrades to a normal request rather than
  erroring.
- Pricing and usage keep reading the same `tierDecision`, so no cost path changes.

`"priority"` is the canonical spelling; `"fast"` is accepted as an alias and folded to it
(`fastwire.ts:247`). wp3 writes the canonical value.

Every ingress parses from the selector as the client sent it, never from a value a previous
parser mutated. Responses used to parse the effort row, mutate `parsed.modelId`, then parse
fast from the mutated id — which made `x--fast--high` fire both dimensions while
`x--high--fast` fired neither, and made Responses disagree with Chat and Messages about the
same string.

## `/v1/responses`

Two insertion points. The combo pre-dispatch at `core.ts:2726` runs before
`comboIdFromRawBody`, so the rewrite happens there or a combo child is built from the
synthetic id:

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

The ordinary path at `core.ts:2795` captures the selector first, then updates both
representations — the typed route reads `parsed.*` while the Responses passthrough starts
its outbound body from `parsed._rawBody` (`openai-responses.ts:2179`):

```diff
+    // Captured before any parser mutates it, so both grammars see the client's id.
+    const selector = parsed.modelId;
-    const effortRow = parseRequestEffortRowId(parsed.modelId, config);
+    const effortRow = parseRequestEffortRowId(selector, config);
     ...
+    const fastRow = parseRequestFastRowId(selector, config);
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
`providers/service-tier`, `providers/registry`, `types`, and `server/effort-row` — all
already on this file's graph, none reaching `src/lab`. The guard must stay green without
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

`requestedModel` is already captured before mutation here, which is why this surface never
had the ordering defect.

Unlike the effort row, a fast row does **not** block the native-chat shortcut at
`chat-completions.ts:139`. The effort row must, because native chat cannot carry a
Responses-style reasoning effort. Native chat carries `service_tier` natively and applies
the same policy (`chat-native.ts:186`, `openai-chat.ts:144-150`), so blocking it would
degrade the request for no reason. Leaving that guard alone is the change.

The translated path needs nothing: `chat/inbound.ts:315` already copies `raw.service_tier`
into the Responses body.

## `/v1/messages` — decode the alias before touching the marker

A Claude alias is `claude-ocx-<provider>--<model>` (`src/claude/alias.ts:89`): it already
uses `--` as its own separator. A real model named `foo--fast` therefore arrives as
`claude-ocx-p--foo--fast`, and stripping the marker off the RAW alias would leave
`claude-ocx-p--foo`, routing `p/foo` — a different model, silently, with no error.
`knownEffortRowIds()` holds routed ids, not Claude aliases (`effort-row.ts:44`), so it
cannot defend the raw form.

The alias is decoded by `resolveInboundModel` (`src/claude/inbound.ts:59`), which is called
inside `anthropicToResponsesTranslation` at `inbound.ts:500` — after the point where the
effort row parses. wp3 therefore decodes explicitly, before parsing, and leaves the
inbound body's own model resolution to run as it always has:

```diff
     effortRow = parseRequestEffortRowId(requestedModel, config);
     if (effortRow) { anthropicBody.model = effortRow.baseId; effortOverride = effortRow.effort; }
+    // Decode first: the alias grammar and the fast marker share "--", so the marker is only
+    // unambiguous once the provider half has been split off.
+    const decoded = resolveInboundModel(requestedModel, config.claudeCode);
+    const fastRow = parseRequestFastRowId(decoded, config);
+    if (fastRow) anthropicBody.model = fastRow.baseId;
```

`parseRequestFastRowId` then checks the stripped base against the routed inventory, where
`p/foo--fast` is present and the strip is refused.

The Anthropic translator carries no `service_tier` — `claude/inbound.ts:500` builds its body
from model/input/store/stream plus sampling fields only — so the tier is applied to the
translated body at `claude-messages.ts:670`:

```diff
     const translation = anthropicToResponsesTranslation(anthropicBody, ...);
     internalBody = translation.body;
+    if (fastRow) internalBody.service_tier = "priority";
```

Native Anthropic passthrough at `claude-messages.ts:660` **must** be blocked for a fast row,
the opposite of the chat case: that path forwards to Anthropic's own API, whose wire has no
`service_tier` field, and the `anthropic-speed` FastWire kind has an empty adapter set by
design (`fastwire.ts:15`). Sending it there would silently drop the tier.

```diff
-    if (!effortRow && ... wantsNativePassthrough(...))
+    if (!effortRow && !fastRow && ... wantsNativePassthrough(...))
```

In practice an `anthropic`-adapter route is `wire-unavailable` and never publishes a fast
row, so this guard defends a hand-typed id rather than a listed one.

## `/v1/messages/count_tokens`

`claude-messages.ts:1022` resolves a model and can hand it to `wantsNativePassthrough` at
`:1036`. Without parsing, a listed fast alias is forwarded upstream as a model Anthropic has
never heard of. It needs the identity corrected — and nothing else, because `count_tokens`
returns an estimate and sends no tier:

```diff
   const countRoute = extractOcxRouteDirective(raw);
   if (countRoute) { model = stripOneMillionMarker(countRoute); raw.model = model; }
+  // Decode before stripping, for the same aliasing reason as /v1/messages. A token estimate
+  // carries no tier, so only the identity is corrected here.
+  const countFastRow = parseRequestFastRowId(resolveInboundModel(model, config.claudeCode), config);
+  if (countFastRow) { model = countFastRow.baseId; raw.model = model; }
```

## `/v1/responses/compact`

`compact.ts:502-515` routes `raw.model` through `routeCompactionModel`, and `config` is in
scope from `handleResponsesCompact`'s own signature (`compact.ts:485`). Two separate
concerns, and the audit caught them being conflated:

**Identity** is corrected before routing, or the synthetic id fails to route at all:

```diff
+  const compactFastRow = parseRequestFastRowId(raw.model, config);
+  if (compactFastRow) raw.model = compactFastRow.baseId;
   route = routeCompactionModel(config, raw.model, evidenceFromBody(raw));
```

**The tier** is NOT written unconditionally. Native compact forwards its body directly
(`compact.ts:594`, `compact.ts:735`) and never calls `decideTier`, so an unconditional
`service_tier: "priority"` would bypass `fastMode: false`, a withdrawn capability, and wire
eligibility — the one rule this phase exists to preserve. The policy runs after the route
settles, exactly as `core.ts:2109` does it:

```diff
+  if (compactFastRow) {
+    const decision = decideTier(
+      fastPolicyForModel(route.provider, route.modelId, route.providerName),
+      config.fastMode,
+      "priority",
+    );
+    if (decision.kind === "set") (raw as Record<string, unknown>).service_tier = decision.value;
+  }
```

## Tests — `tests/fast-row-ingress.test.ts`

Each test drives one conditional and asserts an observable effect, per
`cursor-fast-tier.test.ts:31`.

1. **Responses:** a `--fast` model resolves to the base model and reaches the adapter with
   `service_tier: "priority"`. Assert on the outbound body, not on `parsed`.
2. **Chat completions:** same, through the translated path.
3. **Messages:** same, and the native passthrough was not taken.
4. **Flag off:** the same id is an ordinary unknown model on all five surfaces — no
   rewrite, no tier. Default-off at the request path, not only at listing.
5. **Ineligible route:** a `--fast` id on a `capability-unsupported` model reaches the
   adapter with NO `service_tier`; the route still resolves to the base model.
6. **`fastMode: false` wins:** the decision is `{kind:"drop"}`. The operator's switch is not
   overridable by id.
7. **Round-trip identity:** the id wp2 publishes for a model parses back to that model. This
   is the equivalence guard `cursor-fast-listing.test.ts:27` uses, and it is what keeps
   listing and ingress from drifting.
8. **`count_tokens`:** a fast alias returns an estimate for the BASE model and does not
   forward the synthetic id upstream.
9. **`compact`:** a fast id routes the base model and carries the tier — and with
   `fastMode: false`, routes the base model with NO tier. The second half fails against an
   unconditional write.
10. **A real `foo--fast` model routes to ITSELF** on every ingress, including through its
    Claude alias. This is the alias-collision regression.
11. **`a--high--fast` resolves** when `a--high` is a real model — the row wp2 published is
    the row wp3 accepts.

## Verification

`bun test tests/fast-row-ingress.test.ts tests/fast-row-listing.test.ts tests/fast-row.test.ts`,
`bun test tests/core-lab-boundary.test.ts` (mandatory: a protected root was touched),
`bun run typecheck`, `bun run privacy:scan` (request-path change). No full suite.

