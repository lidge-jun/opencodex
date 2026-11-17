# 010 Phase 1: export and registry fix (C1, C2)

Depends on: 000, 001, 002. Criteria: C1, C2.

## Files

| Path | Change |
|---|---|
| `src/clients/config-export.ts` | MODIFY |
| `tests/clients/prime-client.test.ts` | MODIFY |
| `tests/providers/aside-client.test.ts` | MODIFY |
| `tests/clients/pi-family-developer-role.test.ts` | NEW |
| `src/providers/registry/entries-extended.ts` | MODIFY |
| `tests/providers/alibaba-token-plan-developer-role.test.ts` | NEW |
| `scripts/test-layout/layout-clients.json`, `scripts/test-layout/layout-providers.json`, `tests/fixtures/test-layout-expected.json` | MODIFY (register both new tests) |
| `docs-site/src/content/docs/guides/integrations.md` | MODIFY (Prime and Aside paragraphs) |

## Diffs

`src/clients/config-export.ts` after `PI_NATIVE_SELECTOR_OPTIONS` (:1159):

```ts
/**
 * Prime and Aside run the Pi runtime and read the same models.json, so they need Pi's developer-role
 * statement (#8864): without it they send their system prompt as `developer`, which DashScope and
 * Moonshot reject with a 400. Session affinity stays Pi's alone (eb8cc9ab73).
 */
const PI_DEVELOPER_ROLE_OPTIONS: PiExportOptions = { foldDeveloperRole: true };
```

`buildPrimeContribution` (:1416) and `buildAsideContribution` (:1439):

```diff
-  const doc = buildPiClientConfig(ctx);
+  const doc = buildPiClientConfig(ctx, PI_DEVELOPER_ROLE_OPTIONS);
```

Client table `prime` (:1671) and `aside` (:1689):

```diff
-    build: buildPiClientConfig,
+    build: ctx => buildPiClientConfig(ctx, PI_DEVELOPER_ROLE_OPTIONS),
```

omo comment (:1450-1454): replace "which is the one thing Prime and Aside do not do. They pass the default on both paths, so they are consistent" with "the same rule Prime and Aside follow with their own options".

`tests/clients/prime-client.test.ts:40-48` becomes:

```ts
  test("shares Pi's model contract and developer-role statement without Pi's session headers", () => {
    const prime = buildClientConfig("prime", context()) as PiGeneratedConfig;
    const pi = buildClientConfig("pi", context()) as PiGeneratedConfig;
    expect(pi.providers[OPENCODE_PROVIDER_ID]!.compat).toEqual({ sendSessionAffinityHeaders: true, supportsDeveloperRole: false });
    expect(prime.providers[OPENCODE_PROVIDER_ID]!.compat).toEqual({ supportsDeveloperRole: false });
    const { compat: _primeCompat, ...primeBlock } = prime.providers[OPENCODE_PROVIDER_ID]!;
    const { compat: _piCompat, ...piBlock } = pi.providers[OPENCODE_PROVIDER_ID]!;
    expect(primeBlock).toEqual(piBlock);
    expect(buildClientContribution("prime", context()).fragments[0]!.value)
      .toEqual(prime.providers[OPENCODE_PROVIDER_ID]);
  });
```

`tests/providers/aside-client.test.ts:82`: the key set becomes `["baseUrl", "apiKey", "api", "compat", "models"]`, plus `expect(provider.compat).toEqual({ supportsDeveloperRole: false })`; the comment at :71-77 gains one sentence that `compat` was added by #8864 because Aside's Pi runtime otherwise sends `developer`.

NEW `tests/clients/pi-family-developer-role.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { EXPORT_CLIENT_IDS, OPENCODE_PROVIDER_ID, buildClientConfig, buildClientContribution, type ExportContext, type PiProviderBlock } from "../../src/clients/config-export";

// Every client whose document is Pi's models.json (an opencodex provider block on an openai-* dialect whose
// rows carry thinkingLevelMap) must tell its runtime to send system instead of developer (#5664, #8864).
const ctx: ExportContext = { baseUrl: "http://127.0.0.1:10100/v1", models: [
  { namespaced: "openai/gpt-5.6-sol", provider: "openai", id: "gpt-5.6-sol", contextWindow: 922_000, reasoningEfforts: ["low", "high"] },
] };
function piBlock(doc: unknown): PiProviderBlock | undefined {
  const block = (doc as { providers?: Record<string, PiProviderBlock> } | undefined)?.providers?.[OPENCODE_PROVIDER_ID];
  if (!block || typeof block.api !== "string" || !block.api.startsWith("openai-") || !Array.isArray(block.models)) return undefined;
  return block.models.some(model => model.thinkingLevelMap !== undefined) ? block : undefined;
}
const family = EXPORT_CLIENT_IDS.filter(id => piBlock(buildClientConfig(id, ctx)) !== undefined);

describe("Pi-family clients send system instead of developer", () => {
  test("discovery finds at least the known Pi-runtime clients", () => {
    expect(family).toEqual(expect.arrayContaining(["pi", "prime", "aside", "omo", "gentle-shell"]));
  });
  test.each(family)("%s export and managed contribution both write supportsDeveloperRole: false", id => {
    expect(piBlock(buildClientConfig(id, ctx))!.compat?.supportsDeveloperRole).toBe(false);
    const fragment = buildClientContribution(id, ctx).fragments.find(f => f.path.join(".") === "providers." + OPENCODE_PROVIDER_ID);
    expect((fragment?.value as PiProviderBlock | undefined)?.compat?.supportsDeveloperRole).toBe(false);
  });
});
```

(`EXPORT_CLIENT_IDS` `config-export.ts:1810` and `PiProviderBlock` `:894` are exported. Limit: discovery keys on `thinkingLevelMap`, which the builder emits only for reasoning rows (`:1117`); the ctx model has a reasoning ladder, and the floor assertion keeps the five known clients covered. A new Pi-builder client that emits no reasoning rows for this ctx would be invisible; recorded as residual risk.)

`src/providers/registry/entries-extended.ts`: in `alibaba-token-plan` after `promptCacheKey: true,` (~:965) and in `alibaba-token-plan-intl` after `promptCacheKey: true,` (~:1012):

```ts
    // DashScope compatible-mode answers `400 developer is not one of ['system','assistant','user','tool','function']`
    // (#5664, #8864). The native /v1/chat/completions passthrough folds only on an explicit record.
    foldDeveloperRoleToSystem: true,
```

NEW `tests/providers/alibaba-token-plan-developer-role.test.ts`: `describe.each(["alibaba-token-plan", "alibaba-token-plan-intl"])` with the four moonshot cases (fresh seed records the fold; config saved before the record resolves with it through `routedProviderConfig`; explicit `false` wins; native passthrough `buildOpenAIChatPassthroughRequest(routedProviderConfig(id, saved), { messages: [developer, user] }, "qwen3.8-max", false)` body sends `system` first). Saved config uses the registry base URL (`getProviderRegistryEntry(id)!.baseUrl`), plus one intl case with the base URL overridden to `https://dashscope-intl.aliyuncs.com/compatible-mode/v1`, the configuration in #8864 (backfill applies: `src/providers/registry.ts:109`, `routed-config.ts:356-358`).

`docs-site/src/content/docs/guides/integrations.md`: Prime paragraph (:264) and Aside paragraph (:276) each gain: "The generated block sets `compat.supportsDeveloperRole` to `false`, so the agent sends its system prompt as `system`; several OpenAI-compatible upstreams reject `developer` with a 400."

## Verification (wp1 C)

- Before the source change: `bun test tests/clients/pi-family-developer-role.test.ts` fails for prime and aside; `bun test tests/providers/alibaba-token-plan-developer-role.test.ts` fails on the seed/backfill/passthrough cases.
- After: `bun test tests/clients/pi-family-developer-role.test.ts tests/clients/prime-client.test.ts tests/providers/aside-client.test.ts tests/clients/omo-client.test.ts tests/config/client-config-export.test.ts tests/config/client-config-export-new-clients.test.ts tests/providers/alibaba-token-plan-developer-role.test.ts tests/providers/moonshot-developer-role.test.ts tests/test-layout.test.ts tests/test-layout-tooling.test.ts` exits 0; `bun run typecheck` exits 0.

