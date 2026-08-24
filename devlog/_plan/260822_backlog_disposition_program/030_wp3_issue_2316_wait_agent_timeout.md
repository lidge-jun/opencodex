# WP3 — Reimplement #2316: Grok wait_agent timeout_ms integral-float rejection

> Source: read-only research lane `res-2316` (model `openrouter/stealth-ox-alpha`), dispatched at work-phase 0 against `dev@ced9a85c5`.
> Every file:line pointer below was independently spot-checked by the main agent before the roadmap was locked; verification notes are appended at the end of this document.

Investigation complete. Both triage claims verified against real code; here is the implementation doc.

# Issue #2316 — Implementation Doc

## 1. ROOT CAUSE

Both claimed defects are real and independently sufficient to reproduce the symptom.

**Defect A — `number`-typed u64 fields are outside the repair contract.**
[src/lib/tool-argument-integers.ts](/Users/jun/Developer/new/700_projects/opencodex/src/lib/tool-argument-integers.ts) gates all integral-float repair on `integer` being *declared*:

- L36–41 `declaresInteger`: `if (type === "integer") return true; return Array.isArray(type) && type.includes("integer");` — `"number"` returns false.
- L126–144 `coerceValue`, number branch: L129 `const integerDeclared = declaresInteger(resolved) || branches.some(declaresInteger);` and L141 `if (!integerDeclared || !safelyIntegral(value)) return { value, changed: false };`. So a `120000.0` arriving under `{ "type": "number" }` hits L141 with `integerDeclared === false` and passes through unchanged. L186 `if (!parameters || !args) return args;` also means no schema ⇒ full passthrough.

Upstream evidence confirms the mismatch: [001_upstream_multiagent_v2_evidence.md:134](/Users/jun/Developer/new/700_projects/opencodex/devlog/_plan/260816_codexrs_multiagent_v2_and_history_perf/001_upstream_multiagent_v2_evidence.md) — V1 `wait_agent` optional field `timeout_ms: number`; :139 V2 same. Rust runtime deserializes `u64` ⇒ serde rejects `120000.0`.

**Defect B — schema map keyed only by namespaced wire name unless toolChoice names the bare one.**
[src/server/responses/collaboration.ts:121](/Users/jun/Developer/new/700_projects/opencodex/src/server/responses/collaboration.ts): `const wireName = namespacedToolName(t.namespace, t.name)` (`namespace ? \`${namespace}__${name}\` : name`, [src/types/tools.ts:30–32](/Users/jun/Developer/new/700_projects/opencodex/src/types/tools.ts)), then L~117 `toolParameterSchemas.set(wireName, t.parameters)`. The bare-name entry exists only in the second loop (L153–161) guarded by `bareChoiceNames.has(t.name)` — i.e. only when `toolChoice` explicitly selected the tool. With `toolChoice: "auto"` and Grok echoing bare `wait_agent`, the bridge lookups miss:

- Streaming: [src/bridge.ts:626–629](/Users/jun/Developer/new/700_projects/opencodex/src/bridge.ts) `coerceIntegerToolArguments(currentToolCall.args || "{}", options?.toolParameterSchemas?.get(currentToolCall.name))`.
- Non-streaming: [src/bridge.ts:1656–1659](/Users/jun/Developer/new/700_projects/opencodex/src/bridge.ts) `options?.toolParameterSchemas?.get(currentToolCallName)`.

Missing key ⇒ `parameters === undefined` ⇒ L186 passthrough ⇒ `120000.0` reaches Codex raw.

**Existing invariant to preserve:** [tests/tool-argument-integers.test.ts:59–62](/Users/jun/Developer/new/700_projects/opencodex/tests/tool-argument-integers.test.ts) `"never touches number-typed fields"` asserts `'{"temperature":1.0}'` comes back byte-identical. So the fix cannot blanket-coerce all `number` fields; it must be keyed to known Codex-native u64 fields.

## 2. FILE CHANGE MAP

### MODIFY [src/lib/tool-argument-integers.ts](/Users/jun/Developer/new/700_projects/opencodex/src/lib/tool-argument-integers.ts)

**(a)** Add allowlist constant immediately before `function coerceValue(...` (currently L121):

```diff
+/**
+ * Codex-native fields whose advertised JSON Schema says `number` but whose Rust
+ * runtime deserializes `u64` (#2316). An integral value serialized as `120000.0`
+ * has exactly one faithful reading (`120000`), so it is repaired; a genuinely
+ * fractional value still fails, and ordinary `number` fields like `temperature`
+ * stay untouched.
+ */
+const U64_NUMBER_FIELDS = new Set(["timeout_ms"]);
+
 function coerceValue(value: unknown, schema: SchemaNode | undefined, root: SchemaNode, depth: number): CoerceResult {
```

**(b)** Thread the property key into `coerceValue` and add the number-field repair. Replace L121 signature and insert into the number branch between the `#1938` block (ends L138) and L139's comment:

```diff
-function coerceValue(value: unknown, schema: SchemaNode | undefined, root: SchemaNode, depth: number): CoerceResult {
+function coerceValue(value: unknown, schema: SchemaNode | undefined, root: SchemaNode, depth: number, key?: string): CoerceResult {
   // A hostile or deeply nested schema must not blow the stack.
   if (depth > 64) return { value, changed: false };
   const resolved = schema ? resolveRef(schema, root, new Set()) : undefined;
 
   if (typeof value === "number") {
     if (!resolved) return { value, changed: false };
     const branches = compositionBranches(resolved);
     const integerDeclared = declaresInteger(resolved) || branches.some(declaresInteger);
     if (!integerDeclared && safelyIntegral(value)) {
       // Issue #1938: a bare integer in a string-only field has exactly one faithful
       // string reading. A field that also accepts a numeric type keeps the number.
       const stringDeclared = declaresString(resolved) || branches.some(declaresString);
       const numericDeclared = declaresNumeric(resolved) || branches.some(declaresNumeric);
       if (stringDeclared && !numericDeclared) {
         return { value: String(value), changed: true };
       }
     }
+    // #2316: a known Codex-native u64 field advertised as `number` still rejects
+    // integral floats at the Rust boundary. Re-serialize the same JS number so
+    // `120000.0` becomes `120000`; non-integral values keep failing.
+    if (
+      !integerDeclared && key !== undefined && U64_NUMBER_FIELDS.has(key)
+      && (declaresNumeric(resolved) || branches.some(declaresNumeric))
+      && safelyIntegral(value)
+    ) {
+      return { value, changed: true };
+    }
     // Not an integer field, already an integer, non-integral, or unrepresentable:
     // in every one of those cases the received value is the right thing to keep.
     if (!integerDeclared || !safelyIntegral(value)) return { value, changed: false };
```

**(c)** Pass the key at the two recursive call sites in the array branch (L150) and object loop (L167):

```diff
     const next = value.map(entry => {
-      const result = coerceValue(entry, itemSchema, root, depth + 1);
+      const result = coerceValue(entry, itemSchema, root, depth + 1);
       if (result.changed) changed = true;
       return result.value;
     });
```
(array items keep no key — leave that call as-is.)

```diff
   for (const [key, entry] of Object.entries(object)) {
     const childSchema = asSchema(properties?.[key]) ?? additional;
-    const result = coerceValue(entry, childSchema, root, depth + 1);
+    const result = coerceValue(entry, childSchema, root, depth + 1, key);
     if (result.changed) changed = true;
     next[key] = result.value;
   }
```

Note: `JSON.parse("120000.0") === 120000` and `Number.isInteger(120000) === true`, so "repair" here just means re-stringify; a payload already containing `120000` produces byte-identical output, keeping the "returns original bytes when nothing needs repair" behavior intact for these fields too.

### MODIFY [src/server/responses/collaboration.ts](/Users/jun/Developer/new/700_projects/opencodex/src/server/responses/collaboration.ts)

In `buildToolBridgeMaps`, first authorization loop (~L117), register the bare logical name as a schema alias whenever the tool is namespaced. Collision-guarded (first declaration wins):

```diff
-    if (t.parameters && typeof t.parameters === "object") toolParameterSchemas.set(wireName, t.parameters);
+    if (t.parameters && typeof t.parameters === "object") {
+      toolParameterSchemas.set(wireName, t.parameters);
+      // #2316: routed providers can echo the bare logical name instead of the
+      // namespaced wire name even under toolChoice "auto"; expose the schema
+      // under both keys so argument repair still finds it.
+      if (t.namespace && !toolParameterSchemas.has(t.name)) toolParameterSchemas.set(t.name, t.parameters);
+    }
```

No change needed in [src/bridge.ts](/Users/jun/Developer/new/700_projects/opencodex/src/bridge.ts) — its `.get(name)` lookups become hits once the map carries the alias. (If another adapter builds `toolParameterSchemas` itself without aliases, it would still miss; none currently do besides this builder.)

## 3. TEST PLAN

Extend [tests/tool-argument-integers.test.ts](/Users/jun/Developer/new/700_projects/opencodex/tests/tool-argument-integers.test.ts).

Add fixture near the top:

```ts
/** The multi_agent wait shape from the #2316 report: Codex advertises number, runtime wants u64. */
const WAIT_TIMEOUT_SCHEMA = {
  type: "object",
  properties: { targets: { type: "array", items: { type: "string" } }, timeout_ms: { type: "number" } },
};
```

New tests inside the top-level describe (names verbatim):

1. `test("repairs an integral float in a number-advertised u64 field (#2316)")` — assert `coerceIntegerToolArguments('{"targets":["a"],"timeout_ms":120000.0}', WAIT_TIMEOUT_SCHEMA)` `toBe('{"targets":["a"],"timeout_ms":120000}')`. **Fails before** (returns input unchanged); passes after.
2. `test("leaves a fractional timeout_ms failing")` — `coerceIntegerToolArguments('{"timeout_ms":1.5}', WAIT_TIMEOUT_SCHEMA)` `toBe('{"timeout_ms":1.5}')`.
3. `test("still never touches ordinary number-typed fields")` — existing temperature assertion at L59–62 must remain green unchanged (guards regression).
4. Wiring test in the `#1611 wiring` describe: extend `schemas` map with both `"multi_agent_v1__wait_agent"` and `"wait_agent"` mapped to `WAIT_TIMEOUT_SCHEMA`; add `test("bare-name tool calls find their schema for u64 repair")` — stream events `{ type:"tool_call_start", id:"call_3", name:"wait_agent" }`, delta `'{"timeout_ms":120000.0}'`, end, done, via `bridgeToResponsesSSE(..., { toolParameterSchemas: schemas })`; assert `response.function_call_arguments.done` arguments `toBe('{"timeout_ms":120000}')`.
5. Builder test (new small test or appended): call `buildToolBridgeMaps` from `src/server/responses/collaboration.ts` with a parsed request containing one namespaced tool `multi_agent_v1/wait_agent` with parameters and default/auto choice; assert `maps.toolParameterSchemas.get("wait_agent")` is defined **and** `maps.toolParameterSchemas.get("multi_agent_v1__wait_agent")` is defined. Fails before (bare key undefined under auto choice); passes after.

## 4. VERIFIER COMMAND

```bash
bun test tests/tool-argument-integers.test.ts
```

Yes — it imports and executes both changed files directly (`src/lib/tool-argument-integers.ts` at L2, `src/bridge.ts` at L3) and will execute `src/server/responses/collaboration.ts` once test 5 imports it. Before opening a review-ready PR, AGENTS.md requires `bun run typecheck` and `bun run test` (this touches shared server config-building code).

## 5. ACTIVATION SCENARIO

A test triggers the path by feeding the real bridge an adapter event sequence where `tool_call_start` carries name `wait_agent` (bare) and the args delta carries `{"timeout_ms":120000.0}`, with `options.toolParameterSchemas` built by `buildToolBridgeMaps` under a default/auto tool choice. Observable proof the changed conditional ran: the SSE frame `response.function_call_arguments.done` (streaming) / `output[].arguments` in `buildResponseJSON` (non-streaming) serializes `120000` instead of `120000.0` — i.e. the exact bytes Codex's serde layer would otherwise reject. Unit-level observable: `coerceIntegerToolArguments` returns a different string than its input only for allowlisted keys declaring numeric types.

## 6. RISK/BLOCKERS

- None blocking. The design deliberately avoids blanket `number` coercion; `temperature: 1.0` stays untouched because it is not in `U64_NUMBER_FIELDS` (existing test remains the guard).
- The allowlist is hand-maintained: future Codex tools advertising `number` for u64 fields will need entries added. That is the accepted trade-off versus silently rewriting arbitrary floats.
- If Grok emits the v2 namespaced form `collaboration__wait_agent` instead of `multi_agent_v1__wait_agent`, Defect B's alias fix covers any namespace since the bare alias is registered per declared tool regardless of namespace value.
- Per the triage comment, sibling field Cursor `yield_time_ms` (`src/adapters/cursor/tool-definitions.ts:49`, still `type:"number"`) is explicitly out of scope for this ticket — do not widen the change.
- Do not let PR #2320 carry `Closes #2316`; it touches unrelated Cursor error classification.


---

# AMENDMENT (A-phase round 1, blockers B1+B2) — authoritative over the body above

The round-1 auditor found, and the main agent independently confirmed, that the
"Defect B" half of the research lane's diagnosis is **wrong for this bug**. This section
overrides the body wherever they disagree.

## What was struck

The proposed edit to `src/server/responses/collaboration.ts` (register the bare logical
name as a schema alias) is **removed from this work-phase**. Two independent reasons:

**1. It is unreachable.** `src/bridge.ts:1041` (streaming) and `src/bridge.ts:1788`
(non-streaming) reject any tool name absent from `declaredToolNames` with a 502 *before*
argument repair runs:

```ts
if (options?.declaredToolNames && !options.declaredToolNames.has(event.name)) {
  const failure = responseError(502, "upstream_error",
    `routed provider emitted undeclared client tool "${event.name}"; only request-declared tools may be called`);
```

A schema registered under a bare key that is not also in `declaredToolNames` can never be
consulted, because the call is already dead. The proposed wiring test injected the schema
map by hand and bypassed the guard, which is why it looked like it would work.

**2. The reported bug never involved a bare name.** Issue #2316's body reports the
failing call as `multi_agent_v1__wait_agent` — namespaced — and the error text
(`invalid type: floating point \`120000.0\`, expected u64`) comes from **Codex's own
deserializer**, which only sees the call after it passed our bridge. The schema lookup
hit; the repair simply declined to act because the field declares `number`, not
`integer`. Defect A is the entire bug.

## Policy recorded for any future unit (B2)

If bare-name repair is ever genuinely wanted, the alias must be admitted **atomically**
into `declaredToolNames`, `toolNsMap`, and `toolParameterSchemas` together, under the
uniqueness rule that already governs that path at
`src/server/responses/collaboration.ts:154` (`bareNameCounts.get(t.name) !== 1` refuses
the alias). Registering into the schema map alone bypasses a deliberate collision policy
and can hand one tool's schema to a different, legitimately-authorized tool.

## Amended scope of WP3

**One file changes:** `src/lib/tool-argument-integers.ts` (plus its test).

- Add `U64_NUMBER_FIELDS = new Set(["timeout_ms"])`.
- Thread the property key into `coerceValue` and repair an integral float when the key is
  allowlisted and the field declares a numeric type.
- `temperature: 1.0` must remain byte-identical (existing test
  `tests/tool-argument-integers.test.ts:59-62` is the guard).
- Fractional values (`1.5`) must still pass through unrepaired and fail upstream.

## Amended verifier (B5)

Run as its own invocation, with an existence gate, so a missing file fails the phase:

```bash
test -f tests/tool-argument-integers.test.ts || exit 1
bun test tests/tool-argument-integers.test.ts
```

Baseline before the change: 24 pass / 0 fail. After: 24 + the new cases, 0 fail.

## Amended activation scenario

Unit-level, no bridge injection required: `coerceIntegerToolArguments` with the real
`wait_agent` schema shape (`timeout_ms: {type: "number"}`) returns
`'{"timeout_ms":120000}'` for input `'{"timeout_ms":120000.0}'` — a different string than
its input — while `'{"temperature":1.0}'` under the same call returns byte-identical.

