import { describe, expect, test } from "bun:test";
import { PROVIDER_REGISTRY } from "../../src/providers/registry";

// A preset that ships both a static seed and a default must default to a model it seeds.
// When a vendor retires a model, the seed row is the one people delete; a defaultModel left
// pointing at the removed id then hands every fresh install a dead first request. Presets
// without a seed (live-only, local) or without a default are out of scope by construction.
const SEEDED_WITH_DEFAULT = PROVIDER_REGISTRY
  .filter(entry => entry.defaultModel && (entry.models?.length ?? 0) > 0)
  .map(entry => [entry.id, entry.defaultModel!, entry.models!] as const);

describe("registry defaultModel", () => {
  test("covers a meaningful share of the registry", () => {
    expect(SEEDED_WITH_DEFAULT.length).toBeGreaterThan(40);
  });

  test.each(SEEDED_WITH_DEFAULT)("%s defaults to %s, which its seed lists", (_id, defaultModel, models) => {
    expect(models).toContain(defaultModel);
  });
});
