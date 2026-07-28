# 030 — Regression coverage

Work phase: `wp4-tests` · Criteria: `c4-tests`, `c5-typecheck`

Two files change: the parity list gets the new id, and a new focused test file
carries the behavioral assertions. The parity append alone is what the reviewers
rejected (B5), so it never stands on its own here.

## `tests/provider-registry-parity.test.ts`

```diff
-  "huggingface", "nvidia", "venice", "zai", "nanogpt", "synthetic", ...
+  "huggingface", "nvidia", "venice", "zai", "zhipu-bigmodel", "nanogpt", "synthetic", ...
```

Position matters: `EXPECTED_KEY_PROVIDER_IDS` is compared with `toEqual` against
`Object.keys(KEY_LOGIN_PROVIDERS)`, so the array order must match registry
order, and `020` places the entry directly after `zai`.

## New file: `tests/zhipu-bigmodel-provider.test.ts`

Modeled on `tests/tencent-siliconflow-providers.test.ts` — same imports, same
shape, so it reads as part of the existing family.

### Test 1 — the provider contract

```ts
const entry = PROVIDER_REGISTRY.find(provider => provider.id === "zhipu-bigmodel");
expect(entry).toMatchObject({
  label: "Zhipu AI — BigModel",
  baseUrl: "https://open.bigmodel.cn/api/paas/v4",
  adapter: "openai-chat",
  authKind: "key",
  defaultModel: "glm-4.6",
  jawcodeBundle: "zai",
});
expect(entry?.modelContextWindows?.["glm-4.6"]).toBe(204_800);
expect(entry?.modelInputModalities?.["glm-4.6v"]).toEqual(["text", "image"]);
expect(entry?.modelInputModalities?.["glm-4.6"]).toEqual(["text"]);
// See 001 §A3: noVisionModels is a vision-sidecar routing claim, not a denial.
expect(entry?.noVisionModels).toBeUndefined();
expect(entry?.liveModels).toBeUndefined();
```

### Test 2 — the id cannot hijack a saved credential

This is the regression guard for B1, and it is the assertion that would have
failed on the original PR head:

```ts
const directoryIds = new Set(FREE_PROVIDER_DIRECTORY.map(row => row.id));
expect(directoryIds.has("zhipu-bigmodel")).toBe(false);
// the ids this provider must never claim, because they already resolve elsewhere
expect(entry?.id).not.toBe("glm");
expect(entry?.id).not.toBe("glm-cn");
```

Plus the routing proof that a saved `glm` config is still untouched by the new
entry:

```ts
const route = routeModel(configWithSavedGlmProvider, "glm/glm-4.6");
expect(route.provider.baseUrl).toBe("https://api.z.ai/api/coding/paas/v4");
```

`glm` is not in `PROVIDER_REGISTRY`, so `routedProviderConfig()` returns the
saved config unchanged — asserting it here pins the behavior the collision would
have broken.

### Test 3 — request shaping emits the thinking toggle

The behavioral assertion AGENTS.md asks for. Signature confirmed in `001` §A1:
`buildRequest` is async, takes one `OcxParsedRequest`, and returns a JSON
**string** body; the provider binds at adapter construction.

```ts
const route = routeModel(config, "zhipu-bigmodel/glm-4.6");
const adapter = createOpenAIChatAdapter(route.provider);
const request = await adapter.buildRequest({
  modelId: route.modelId,
  context: { messages: [{ role: "user", content: "hi" }] },
  stream: true,
  options: { reasoning: "high" },
});
const body = JSON.parse(request.body) as { thinking?: { type: string }; reasoning_effort?: string };
expect(body.thinking).toEqual({ type: "enabled" });
expect(body.reasoning_effort).toBeUndefined();
```

And the disabled half, since a one-sided toggle test passes even if the map is
stuck on one value: `reasoning: "low"` maps to `disabled` through
`THINKING_TOGGLE_MAP`, so the same build with `low` must yield
`{ type: "disabled" }` and still no `reasoning_effort`.

### Test 5 — the directory/registry collision guard, generalized

From `001` §A4: the existing isolation test at
`tests/provider-registry-parity.test.ts:796-812` only checks directory rows with
`supportLevel === "reference"`, so it would have stayed green on the original
`glm` collision. Add a case in `tests/provider-registry-parity.test.ts` covering
every directory row:

```ts
test("a directory id shared with the registry must agree on its endpoint", () => {
  const registryById = new Map(PROVIDER_REGISTRY.map(entry => [entry.id, entry]));
  for (const row of FREE_PROVIDER_DIRECTORY) {
    const registryEntry = registryById.get(row.id);
    if (!registryEntry) continue;
    // routedProviderConfig() canonicalizes a saved config onto the registry baseUrl,
    // so a shared id with a different host silently retargets the user's API key.
    expect(registryEntry.baseUrl).toBe(row.baseUrl);
  }
});
```

This is the durable half of the fix: the next contributor reaching for a taken id
gets a failing test instead of a review comment.

### Test 4 — derived surfaces

```ts
expect(KEY_LOGIN_PROVIDERS["zhipu-bigmodel"]).toMatchObject({
  baseUrl: "https://open.bigmodel.cn/api/paas/v4",
  defaultModel: "glm-4.6",
});
expect(deriveProviderPresets().find(p => p.id === "zhipu-bigmodel")).toMatchObject({ auth: "key" });
expect(deriveJawcodeAliases()["zhipu-bigmodel"]).toBe("zai");
```

## Verification

```bash
bun test tests/zhipu-bigmodel-provider.test.ts
bun test tests/provider-registry-parity.test.ts
bun run typecheck
```

Then the full `bun run test` once, with any pre-existing failures recorded as
baseline rather than attributed to this change.
