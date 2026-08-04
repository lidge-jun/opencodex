# 020 — WP2: `rewriteProviderReferences` (the reference inventory)

The inventory of every config location that names a provider id, and why each
shape matters: `002_research_alibaba_region_split.md`. WP3 consumes this module;
this phase ships and proves it alone.

## Why this is its own phase

Renaming a provider id in a config is a self-contained problem with a
self-contained failure mode: miss one reference and the config either loses a
setting silently or — for a combo target — fails validation entirely, at which
point `loadConfig` backs the file up as invalid and starts from defaults
(`src/config.ts:764`). That risk lives in the inventory, not in the Alibaba
migration that will call it, so it earns its own verification.

## Collision policy

Two of the sites are *keys*, and a key move can land on an occupied slot:
`providerContextCaps[to]` and `desktopProfile.assignments[<to>/model]` may
already exist independently of whether `providers[to]` does — context-cap keys
are not constrained to configured providers, and desktop routes are validated
syntactically without consulting the provider map.

Silently overwriting either destroys a value the user set deliberately. The
rewriter therefore **reports collisions and changes nothing at those sites**,
leaving the decision to its caller:

```ts
export interface ProviderRewriteResult {
  /** Number of references re-pointed. */
  changed: number;
  /**
   * Sites where the destination key already held a value, left untouched. A
   * non-empty list means the caller must not treat the rewrite as complete —
   * merging two users' settings is not a decision this function can make.
   */
  collisions: string[];
}
```

WP3 aborts its migration when `collisions` is non-empty, by the same reasoning
that makes it refuse when the destination provider row already exists.

## NEW `src/providers/provider-id-rewrite.ts`

```ts
import type { OcxConfig } from "../types";

export interface ProviderRewriteResult {
  changed: number;
  collisions: string[];
}

/**
 * Re-point every config reference from one provider id to another.
 *
 * Three shapes exist and the difference matters: routed model strings
 * (`"<provider>/<model>"`), bare provider ids (`customModels[].provider`,
 * `combos[*].targets[].provider`), and keys that ARE provider ids or routes
 * (`providerContextCaps`, `desktopProfile.assignments`). A rewrite that handles
 * only the first leaves an orphaned context cap and — worse — a combo target
 * naming a provider that no longer exists, which fails validation at
 * `src/combos/types.ts:220` and makes `loadConfig` discard the whole config.
 *
 * `providers[*].selectedModels` is deliberately NOT rewritten: those are
 * per-provider native model ids, and upstream ids may contain a slash
 * (`src/types.ts:808`), so a prefix rewrite could mangle an unrelated provider's
 * allowlist. A caller that moves a provider row handles its own allowlist, where
 * the destination catalog is known.
 */
export function rewriteProviderReferences(config: OcxConfig, from: string, to: string): ProviderRewriteResult {
  const prefix = `${from}/`;
  const collisions: string[] = [];
  let changed = 0;

  /** Routed string: rewrite only an exact `<from>/…` prefix, never a longer id. */
  const route = (value: unknown): string | undefined => {
    if (typeof value !== "string" || !value.startsWith(prefix)) return undefined;
    changed += 1;
    return `${to}/${value.slice(prefix.length)}`;
  };
  /**
   * Rewrite a routed-string list in place. Assigning the result unconditionally
   * would add an own property with value `undefined` where the field was absent,
   * which breaks the no-op contract (`structuredClone` deep-equality sees the new
   * key). The key type is an explicit union rather than `keyof OcxConfig`: the
   * latter also admits `customModels`, `apiKeys` and `codexAccounts`, so `map`
   * would infer a union array that is not assignable back.
   */
  type RoutedListKey = "disabledModels" | "subagentModels" | "subagentModelFallback";
  const routeListAt = (key: RoutedListKey): void => {
    const list = config[key];
    if (!list) return;
    config[key] = list.map(id => route(id) ?? id);
  };
  const routeRecordValues = (record: Record<string, string> | undefined): void => {
    if (!record) return;
    for (const [key, value] of Object.entries(record)) {
      const next = route(value);
      if (next) record[key] = next;
    }
  };

  if (config.defaultProvider === from) { config.defaultProvider = to; changed += 1; }

  routeListAt("disabledModels");
  routeListAt("subagentModels");
  routeListAt("subagentModelFallback");

  const scalarOwners: Array<[Record<string, unknown> | undefined, string]> = [
    [config as unknown as Record<string, unknown>, "injectionModel"],
    [config.shadowCallIntercept as Record<string, unknown> | undefined, "model"],
    [config.webSearchSidecar as Record<string, unknown> | undefined, "model"],
    [config.visionSidecar as Record<string, unknown> | undefined, "model"],
    [config.claudeCode as Record<string, unknown> | undefined, "model"],
    [config.claudeCode as Record<string, unknown> | undefined, "smallFastModel"],
    [config.claudeCode?.webSearchSidecar as Record<string, unknown> | undefined, "model"],
    [config.claudeCode?.visionSidecar as Record<string, unknown> | undefined, "model"],
  ];
  for (const [owner, key] of scalarOwners) {
    if (!owner) continue;
    const next = route(owner[key]);
    if (next) owner[key] = next;
  }

  routeRecordValues(config.claudeCode?.tierModels as Record<string, string> | undefined);
  routeRecordValues(config.claudeCode?.modelMap as Record<string, string> | undefined);

  // Bare provider ids.
  for (const model of config.customModels ?? []) {
    if (model.provider === from) { model.provider = to; changed += 1; }
  }
  for (const [id, combo] of Object.entries(config.combos ?? {})) {
    combo.targets.forEach((target, i) => {
      if (target.provider !== from) return;
      target.provider = to;
      changed += 1;
      void id; void i;
    });
  }

  // Keys. `providerContextCaps` is KEYED by provider id — a prefix rewrite would
  // silently orphan the cap — and a destination key may already be occupied.
  const caps = config.providerContextCaps;
  if (caps && Object.hasOwn(caps, from)) {
    if (Object.hasOwn(caps, to)) collisions.push(`providerContextCaps.${to}`);
    else { caps[to] = caps[from]!; delete caps[from]; changed += 1; }
  }

  // desktopProfile is nested and asymmetric: `assignments` is KEYED by route
  // while `defaults` holds routes as VALUES (src/types.ts:437-445).
  const profile = config.claudeCode?.desktopProfile;
  if (profile) {
    for (const key of Object.keys(profile.assignments ?? {})) {
      const next = route(key);
      if (!next) continue;
      if (Object.hasOwn(profile.assignments, next)) {
        changed -= 1; // `route` counted it; the move did not happen.
        collisions.push(`claudeCode.desktopProfile.assignments.${next}`);
        continue;
      }
      profile.assignments[next] = profile.assignments[key]!;
      delete profile.assignments[key];
    }
    const defaults = profile.defaults as Record<string, string | null> | undefined;
    if (defaults) {
      for (const [family, value] of Object.entries(defaults)) {
        const next = route(value);
        if (next) defaults[family] = next;
      }
    }
  }

  return { changed, collisions };
}
```

## Tests — NEW `tests/provider-id-rewrite.test.ts`

```ts
import { expect, test } from "bun:test";
import { comboConfigError } from "../src/combos";
import { providerContextCap } from "../src/providers/context-cap";
import { rewriteProviderReferences } from "../src/providers/provider-id-rewrite";
import type { OcxConfig } from "../src/types";

const FROM = "alibaba-token-plan";
const TO = "alibaba-token-plan-intl";

test("rewrites every routed-string site", () => {
  const config = {
    defaultProvider: FROM,
    disabledModels: [`${FROM}/glm-5.2`, "anthropic/claude-sonnet-5"],
    subagentModels: [`${FROM}/qwen3.7-max`],
    subagentModelFallback: [`${FROM}/qwen3.6-flash`],
    injectionModel: `${FROM}/qwen3.7-plus`,
    shadowCallIntercept: { model: `${FROM}/qwen3.6-flash` },
    webSearchSidecar: { model: `${FROM}/qwen3.7-max` },
    visionSidecar: { model: `${FROM}/qwen3.7-max` },
    claudeCode: {
      model: `${FROM}/qwen3.7-max`,
      smallFastModel: `${FROM}/qwen3.6-flash`,
      tierModels: { opus: `${FROM}/qwen3.7-max` },
      modelMap: { "claude-opus-5": `${FROM}/qwen3.7-max` },
      webSearchSidecar: { model: `${FROM}/qwen3.7-max` },
      visionSidecar: { model: `${FROM}/qwen3.7-max` },
    },
  } as unknown as OcxConfig;

  // 14 sites: defaultProvider, one of two disabledModels, subagentModels,
  // subagentModelFallback, injectionModel, shadowCallIntercept.model,
  // webSearchSidecar.model, visionSidecar.model, and the six claudeCode entries.
  const result = rewriteProviderReferences(config, FROM, TO);
  expect(result).toEqual({ changed: 14, collisions: [] });
  expect(JSON.stringify(config)).not.toContain(`"${FROM}/`);
  expect(config.disabledModels).toContain("anthropic/claude-sonnet-5");
});

test("moves a providerContextCaps entry by key, not by prefix", () => {
  const config = { providerContextCaps: { [FROM]: 500_000, anthropic: 200_000 } } as unknown as OcxConfig;
  expect(rewriteProviderReferences(config, FROM, TO)).toEqual({ changed: 1, collisions: [] });
  // Asserted through the consumer, so a shape mistake cannot pass.
  expect(providerContextCap(config, TO)).toBe(500_000);
  expect(providerContextCap(config, FROM)).toBeUndefined();
  expect(providerContextCap(config, "anthropic")).toBe(200_000);
});

test("reports a providerContextCaps collision instead of overwriting it", () => {
  const config = { providerContextCaps: { [FROM]: 500_000, [TO]: 900_000 } } as unknown as OcxConfig;
  const result = rewriteProviderReferences(config, FROM, TO);
  expect(result.collisions).toEqual([`providerContextCaps.${TO}`]);
  expect(providerContextCap(config, TO)).toBe(900_000);
  expect(providerContextCap(config, FROM)).toBe(500_000);
});

test("re-points combo targets so the migrated config still validates", () => {
  const providers = { [TO]: { adapter: "openai-chat" } } as unknown as OcxConfig["providers"];
  const combo = { targets: [{ provider: FROM, model: "qwen3.7-max" }] };
  const config = { providers, combos: { fast: combo } } as unknown as OcxConfig;

  expect(comboConfigError("fast", combo, providers)).toContain("not configured");
  rewriteProviderReferences(config, FROM, TO);
  expect(comboConfigError("fast", config.combos!.fast!, providers)).toBeNull();
});

test("re-points customModels[].provider", () => {
  const config = {
    customModels: [
      { id: "a", provider: FROM, modelId: "qwen3.7-max" },
      { id: "b", provider: "anthropic", modelId: "claude-sonnet-5" },
    ],
  } as unknown as OcxConfig;
  expect(rewriteProviderReferences(config, FROM, TO).changed).toBe(1);
  expect(config.customModels!.map(m => m.provider)).toEqual([TO, "anthropic"]);
});

test("rewrites both halves of the Desktop profile", () => {
  const config = {
    claudeCode: {
      desktopProfile: {
        version: 1,
        assignments: { [`${FROM}/qwen3.7-max`]: { family: "opus", alias: "a" } },
        defaults: { opus: `${FROM}/qwen3.7-max`, fable: null, sonnet: null, haiku: null },
      },
    },
  } as unknown as OcxConfig;
  rewriteProviderReferences(config, FROM, TO);
  const profile = config.claudeCode!.desktopProfile!;
  expect(Object.keys(profile.assignments)).toEqual([`${TO}/qwen3.7-max`]);
  expect(profile.defaults.opus).toBe(`${TO}/qwen3.7-max`);
});

test("reports a Desktop assignment collision instead of overwriting it", () => {
  const config = {
    claudeCode: {
      desktopProfile: {
        version: 1,
        assignments: {
          [`${FROM}/qwen3.7-max`]: { family: "opus", alias: "from" },
          [`${TO}/qwen3.7-max`]: { family: "opus", alias: "already-there" },
        },
        defaults: { opus: null, fable: null, sonnet: null, haiku: null },
      },
    },
  } as unknown as OcxConfig;
  const result = rewriteProviderReferences(config, FROM, TO);
  expect(result.collisions).toEqual([`claudeCode.desktopProfile.assignments.${TO}/qwen3.7-max`]);
  expect(result.changed).toBe(0);
  expect(config.claudeCode!.desktopProfile!.assignments[`${TO}/qwen3.7-max`]!.alias).toBe("already-there");
});

test("leaves foreign prefixes and unrelated providers alone", () => {
  const config = {
    defaultProvider: `${FROM}-other`,
    disabledModels: [`${FROM}-other/x`, `${TO}/glm-5.2`],
    providerContextCaps: { [`${FROM}-other`]: 1000 },
  } as unknown as OcxConfig;
  const before = structuredClone(config);
  expect(rewriteProviderReferences(config, FROM, TO)).toEqual({ changed: 0, collisions: [] });
  expect(config).toEqual(before);
  // Absent fields must stay absent: an unconditional list assignment would add
  // `subagentModels: undefined` as an own property and deep-equality would miss it.
  expect(Object.keys(config).sort()).toEqual(Object.keys(before).sort());
});

test("does not touch providers[*].selectedModels", () => {
  // Native ids may contain a slash (src/types.ts:808), so a prefix rewrite here
  // could mangle an unrelated provider's allowlist.
  const config = {
    providers: { openrouter: { adapter: "openai-chat", selectedModels: [`${FROM}/qwen3.7-max`] } },
  } as unknown as OcxConfig;
  expect(rewriteProviderReferences(config, FROM, TO).changed).toBe(0);
  expect(config.providers.openrouter!.selectedModels).toEqual([`${FROM}/qwen3.7-max`]);
});
```

## Activation scenarios (C-ACTIVATION-GROUNDING-01)

| Branch | Reachable from | C triggers it via | Observable effect |
|--------|----------------|-------------------|-------------------|
| routed-string rewrite | any provider rename | test 1 | 14 sites re-pointed, foreign entries intact |
| context-cap key move | a user who set a cap on the renamed provider | test 2 | `providerContextCap(config, to)` returns the cap |
| context-cap collision | caps set on both ids | test 3 | nothing moved, collision reported |
| combo re-point | a config using a combo | test 4 | `comboConfigError` goes from non-null to null |
| desktop assignment collision | routes assigned on both ids | test 7 | nothing moved, existing alias survives |
| foreign-prefix no-op | any longer id sharing the prefix | test 8 | zero changes, config deep-equal |

## Scope boundary

IN: `src/providers/provider-id-rewrite.ts` and
`tests/provider-id-rewrite.test.ts`.

OUT: any caller. Nothing invokes the module in this phase — that is WP3. Shipping
an uncalled function is deliberate: it is fully verifiable on its own — it is
deterministic and touches nothing but the config object handed to it — and it
keeps the inventory's risk separate from the migration's policy decisions.

## Known limitation, documented on the API

The function mutates as it goes, so a config that reaches a collision has already
had its earlier reference sites rewritten. It is not transactional. The module
doc comment states the contract explicitly: **a caller that receives a non-empty
`collisions` must discard the mutated config**, which is why WP3 applies it to a
`structuredClone` and returns the original on collision. A two-pass
plan-then-apply implementation would be cleaner and is recorded as possible
follow-up; it is not needed for the only planned consumer.

## Accept criteria

- All nine tests pass; the file does not exist on the pre-change tree.
- `bun run typecheck` clean — in particular the casts over `claudeCode` and
  `desktopProfile` compile against the real types.
- Full gates green.
