# WP4 / PR3 — `fastMode` exposes `-fast` identities outside Codex

Stacked on PR2. Scope IN: `src/claude/model-info.ts`, `src/server/index.ts` (`/v1/models`
branches only), `src/server/management/agent-settings-routes.ts` (aliases only),
`src/adapters/cursor/request-builder.ts`, docs-site EN reference, tests.
Scope OUT: dashboard `/api/models` `namespaced` ids, Desktop 3P hashed aliases,
`ocx models` static output.

## The asymmetry this closes

Codex has a Fast toggle, so its rows stay umbrella rows and the toggle picks the dimension
(WP3). Claude Code, Pi, and other OpenAI-compatible clients have no toggle — they can only
pick a listed id. With `fastMode: true`, those surfaces list the fast identity instead.

```
config.fastMode = true
  ├─ Codex catalog ....... unchanged umbrella rows + service_tiers (WP3)
  ├─ Claude Code list .... claude-ocx-cursor--claude-opus-5-fast
  ├─ OpenAI /v1/models ... cursor/claude-opus-5-fast
  ├─ dashboard ........... unchanged (namespaced is the disable key)
  └─ request path ........ umbrella pick promotes to fast anyway
```

The last row is what makes an already-persisted client config behave consistently: a
Claude Code `settings.json` still naming the umbrella id gets fast treatment without
rediscovery.

## Change map

| File | Action |
|---|---|
| `src/adapters/cursor/catalog.ts` | MODIFY — export `cursorFastIdFor(baseId)` |
| `src/claude/model-info.ts` | MODIFY — `buildAnthropicModelInfos` takes `fastCursorBases` |
| `src/server/index.ts` | MODIFY — both list branches pass the fast id set |
| `src/server/management/agent-settings-routes.ts` | MODIFY — `aliases` follow the same rule |
| `src/adapters/cursor/request-builder.ts` | MODIFY — `fastMode` promotion fallback |
| `tests/cursor-fast-listing.test.ts` | NEW |
| `docs-site/src/content/docs/reference/configuration/providers.md` | MODIFY — brief `fastMode` note |

## 1. One id-composition helper

```diff
+/**
+ * The listed id for a base when the global fast switch is on. Returns undefined when the
+ * base has no fast dimension, so a caller cannot invent an unroutable id.
+ *
+ * Composed from the base's defaultVariant, NOT a bare \`-fast\` suffix (audit B11): the
+ * umbrella row for a Claude base routes THINKING, so \`claude-opus-5-fast\` would parse back
+ * as the regular-fast sibling — a different wire from what the Codex toggle sends, and for
+ * claude-opus-5 a QUARANTINED one. The listed id must round-trip to the same variant
+ * \`upgradeToFast\` picks.
+ */
+export function cursorFastIdFor(baseId: string): string | undefined {
+  const capability = CURSOR_CAPABILITIES[baseId];
+  if (!capability) return undefined;
+  const kind = upgradeToFast(baseId, capability.defaultVariant);
+  if (kind !== "fast" && kind !== "thinkingFast") return undefined;
+  return kind === "thinkingFast" ? \`\${baseId}-thinking-fast\` : \`\${baseId}-fast\`;
+}
```

Round-trip for the five fast-capable bases, to be re-measured at wp4 P:

| base | defaultVariant | listed id | parses back to |
|---|---|---|---|
| `claude-opus-4-7` | thinking | `claude-opus-4-7-thinking-fast` | thinkingFast |
| `claude-opus-4-8` | thinking | `claude-opus-4-8-thinking-fast` | thinkingFast |
| `claude-opus-5` | thinking | `claude-opus-5-thinking-fast` | thinkingFast |
| `grok-4.5` | regular | `grok-4.5-fast` | fast |
| `grok-4.6` | regular | `grok-4.6-fast` | fast |

`parseCursorVariantId` handles both spellings: the `-fast` strip runs before the thinking
grammar (`catalog.ts:360-371`), so `claude-opus-5-thinking-fast` lands on `thinkingFast`.
WP4's equivalence test asserts the listed id and the toggled umbrella id resolve to the SAME
wire id for every base in that table — the guard that keeps the two surfaces from drifting.

## 2. Claude Code discovery

`buildAnthropicModelInfos` already knows how to publish a dimension as a row
(`push1mVariant`). Fast is a *replacement*, not an addition: the point is that the client's
only pick is the fast one.

```diff
 export function buildAnthropicModelInfos(
   nativeSlugs: readonly string[],
   routedModels: readonly CatalogModel[],
   auto: AutoContextMode = AUTO_CONTEXT_OFF,
   idStyle: AnthropicIdStyle = "desktop3p",
   aliasForRoute: (provider: string, modelId: string) => string = desktop3pAlias,
   nativeContextCap?: NativeContextLimitsInput,
+  fastMode?: boolean,
 ): AnthropicModelInfo[] {
```

```diff
   for (const m of routedModels) {
-    const id = idStyle === "readable" ? claudeCodeAlias(m.provider, m.id) : aliasForRoute(m.provider, m.id);
+    // Global Fast has no toggle on this surface, so the fast identity is what gets listed.
+    // Desktop 3P ids are hashed from the model name, so changing them would strand a saved
+    // picker selection — the rewrite is limited to the readable CLI style.
+    const fastId = fastMode === true && m.provider === "cursor" && idStyle === "readable"
+      ? cursorFastIdFor(m.id)
+      : undefined;
+    const modelId = fastId ?? m.id;
+    const id = idStyle === "readable" ? claudeCodeAlias(m.provider, modelId) : aliasForRoute(m.provider, m.id);
```

The `display_name` follows `modelId` so the picker reads `claude-opus-5-fast (cursor)`.
`push1mVariant` keeps using the same base info, so a 1M base still gets its `[1m]` row and
the two dimensions compose as `...-fast[1m]` — consistent with the existing marker rule
that `[1m]` is a suffix on whatever id precedes it.

Desktop 3P is deliberately excluded: `desktop3pAlias` hashes the model name, so a rewrite
would change every hash and strand saved selections. The objective says not to touch it.

Call site:

```diff
-          const data = buildAnthropicModelInfos(desktopNativeSlugs, goOrdered, resolveAutoContext(config.claudeCode), idStyle, activeDesktop3pAlias, nativeContextLimits(config));
+          const data = buildAnthropicModelInfos(desktopNativeSlugs, goOrdered, resolveAutoContext(config.claudeCode), idStyle, activeDesktop3pAlias, nativeContextLimits(config), config.fastMode);
```

## 3. OpenAI-compatible list

```diff
           ...await Promise.all(uniqueCatalogModelsForRawPublicList(goOrdered).map(async m => {
-            const publicId = m.alias ?? \`\${m.provider}/\${m.id}\`;
+            // Same rule as the anthropic branch: with the global fast switch on, a
+            // toggle-less client is offered the fast identity directly.
+            const fastModelId = config.fastMode === true && m.provider === "cursor"
+              ? cursorFastIdFor(m.id)
+              : undefined;
+            const publicId = m.alias ?? \`\${m.provider}/\${fastModelId ?? m.id}\`;
```

`m.alias` wins when an operator set one — an explicit alias is a user decision and the
switch does not override it.

`grokEffortFields` keeps reading `m.reasoningEfforts`, which is correct: the fast variant's
ladder can be shorter (`claude-opus-5-fast` stops at `high`), and advertising the base
ladder there would let a client request `max` on a fast id. Record this as a known residual
in the PR description; tightening it means threading the variant spec into the listing,
which is a follow-up rather than part of this slice.

## 4. Dashboard aliases

`GET /api/claude-code` builds `aliases` with the same `claudeCodeAlias` helper, so it uses
the identical rule to stay consistent with what Claude Code will actually discover. Its
`available` list (`provider/id`) and the Models tab `namespaced` id stay untouched, because
those are keys for `disabledModels` and export.

## 5. Request-time promotion

Listing alone leaves persisted client configs on the umbrella id. WP3 already promotes when
`decideTier` returns `{kind:"set"}`, and `fastMode: true` produces exactly that on an
eligible route.

**The planned `tierDecision === undefined` fallback is dropped (audit B6).** It was written
for "inbound paths that never build a tier decision", and that state does not exist for
Cursor: `src/server/claude-messages.ts:37,772` converts an anthropic request into a
Responses body and replays it through `handleResponses`, which is the same function that
runs `decideTier` at `responses/core.ts:2095`. Chat-native calls it directly
(`chat-native.ts:192`). A branch guarded on `tierDecision === undefined` would be
unreachable by construction — exactly the dead conditional
C-ACTIVATION-GROUNDING-01 forbids planning.

So PR3 adds no request-path code. Instead it adds the activation evidence that PR2's
promotion really fires on the non-Codex route:

```ts
test("anthropic-inbound reaches the cursor resolver with a set tier decision", async () => {
  // fastMode: true, model claude-ocx-cursor--claude-opus-5, no service_tier in the body
  const request = await captureCursorRequestVia(claudeMessagesHandler, { fastMode: true });
  expect(request.modelId).toMatch(/-fast$/);
});
```

If that test goes red, the correct fix is in the shared `decideTier` path, not a
Cursor-local fallback.

## 6. Tests (activation-grounded)

`tests/cursor-fast-listing.test.ts`:

```ts
test("fastMode off lists the umbrella id", () => {
  const rows = buildAnthropicModelInfos([], [cursorModel("claude-opus-5")], AUTO_CONTEXT_OFF, "readable", desktop3pAlias, undefined, false);
  expect(rows.map(r => r.id)).toContain("claude-ocx-cursor--claude-opus-5");
});

test("fastMode on lists the fast identity for a fast-capable base", () => {
  const rows = buildAnthropicModelInfos([], [cursorModel("claude-opus-5")], AUTO_CONTEXT_OFF, "readable", desktop3pAlias, undefined, true);
  expect(rows.map(r => r.id)).toContain("claude-ocx-cursor--claude-opus-5-fast");
});

test("fastMode on leaves a base without a fast variant alone", () => {
  const rows = buildAnthropicModelInfos([], [cursorModel("kimi-k3")], AUTO_CONTEXT_OFF, "readable", desktop3pAlias, undefined, true);
  expect(rows.map(r => r.id)).toContain("claude-ocx-cursor--kimi-k3");
});

test("the listed fast id still routes", () => {
  const request = createCursorRequest(parsedFor("cursor/claude-opus-5-fast", "high"));
  expect(request.modelId).toBe("claude-opus-5-high-fast");
});

test("desktop3p hashed aliases are untouched by the switch", () => { ... });
```

The third and fifth tests are the guards that make the first two safe: they prove the
rewrite is scoped to fast-capable bases and to the readable id style.

## 7. Docs

One short subsection under the providers reference: what `fastMode` does per surface, that
Codex keeps its toggle, and that only bases with a fast variant are affected. Brief, per
the user's instruction on documentation.

## 8. Residual risks

- Effort ladders on a listed fast id advertise the base ladder (§3). Known, documented.
- A client caching the old id keeps working — the umbrella id never stops routing.
- `fastMode` now means both "OpenAI priority tier" and "Cursor fast variant". That is a
  deliberate overload of one user-facing intent ("go faster"), recorded here so a future
  reader does not mistake it for an accident.
