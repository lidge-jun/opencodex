import { afterEach, describe, expect, test } from "bun:test";
import {
  clearGatherRoutedModelsInflight,
  filterCatalogVisibleModels,
  gatherRoutedModels as gatherRoutedModelsDirect,
  resetCatalogRuntimeStateForTests,
  type ComboCatalogOmission,
} from "../src/codex/catalog";
import { clearModelCache } from "../src/codex/model-cache";
import { withStubbedProviderFetch } from "./helpers/catalog-provider-fetch";
import type { OcxConfig } from "../src/types";
import { CatalogGatherBusyError } from "../src/codex/catalog/provider-fetch";

const originalFetch = globalThis.fetch;

const gatherRoutedModels: typeof gatherRoutedModelsDirect = (config, options) =>
  gatherRoutedModelsDirect(withStubbedProviderFetch(config), options);

afterEach(() => {
  globalThis.fetch = originalFetch;
  clearModelCache();
  clearGatherRoutedModelsInflight();
  resetCatalogRuntimeStateForTests();
});

describe("gatherRoutedModels single-flight", () => {
  test("concurrent callers with the same provider set share one upstream discovery", async () => {
    let fetchCount = 0;
    let release!: () => void;
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });

    globalThis.fetch = (async () => {
      fetchCount += 1;
      await gate;
      return new Response(JSON.stringify({ data: [{ id: "model-a" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const config: OcxConfig = {
      port: 10100,
      defaultProvider: "slow",
      providers: {
        slow: {
          adapter: "openai-chat",
          baseUrl: "https://api.example.test/v1",
          models: [],
        },
      },
    };

    const first = gatherRoutedModels(config);
    const second = gatherRoutedModels(config);
    // Both must have joined before the live fetch resolves.
    await Promise.resolve();
    expect(fetchCount).toBe(1);
    release();
    const [a, b] = await Promise.all([first, second]);
    expect(fetchCount).toBe(1);
    expect(a.map(m => `${m.provider}/${m.id}`)).toEqual(["slow/model-a"]);
    expect(b).toEqual(a);
  });

  test("joiners still receive comboOmissions from the shared flight", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ data: [{ id: "m1" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as typeof fetch;

    const config: OcxConfig = {
      port: 10100,
      defaultProvider: "a",
      providers: {
        a: {
          adapter: "openai-chat",
          baseUrl: "https://api.example.test/v1",
          models: [],
        },
      },
      combos: {
        incomplete: {
          strategy: "failover",
          stickyLimit: 1,
          defaultEffort: "medium",
          alias: null,
          targets: [
            { provider: "a", model: "m1", weight: 1 },
            { provider: "missing", model: "x", weight: 1 },
          ],
        },
      },
    };

    const omissionsA: ComboCatalogOmission[] = [];
    const omissionsB: ComboCatalogOmission[] = [];
    const outcomesA: Array<{ provider: string; state: "authoritative" | "degraded" }> = [];
    const outcomesB: Array<{ provider: string; state: "authoritative" | "degraded" }> = [];
    await Promise.all([
      gatherRoutedModels(config, {
        comboOmissions: omissionsA,
        providerModelOutcomes: outcomesA,
      }),
      gatherRoutedModels(config, {
        comboOmissions: omissionsB,
        providerModelOutcomes: outcomesB,
      }),
    ]);
    expect(omissionsA.some(item => item.id === "incomplete")).toBe(true);
    expect(omissionsB).toEqual(omissionsA);
    expect(outcomesA).toEqual([{ provider: "a", state: "authoritative" }]);
    expect(outcomesB).toEqual(outcomesA);
  });

  test("distinct provider sets keep separate in-flight gathers (no slot eviction)", async () => {
    let releaseA!: () => void;
    let releaseB!: () => void;
    const gateA = new Promise<void>(resolve => { releaseA = resolve; });
    const gateB = new Promise<void>(resolve => { releaseB = resolve; });
    const fetchByHost = new Map<string, number>();

    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      const host = url.includes("provider-a") ? "a" : url.includes("provider-b") ? "b" : "other";
      fetchByHost.set(host, (fetchByHost.get(host) ?? 0) + 1);
      if (host === "a") await gateA;
      else await gateB;
      return new Response(JSON.stringify({ data: [{ id: `model-${host}` }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const configA: OcxConfig = {
      port: 10100,
      defaultProvider: "a",
      providers: {
        a: {
          adapter: "openai-chat",
          baseUrl: "https://provider-a.example.test/v1",
          models: [],
        },
      },
    };
    const configB: OcxConfig = {
      port: 10100,
      defaultProvider: "b",
      providers: {
        b: {
          adapter: "openai-chat",
          baseUrl: "https://provider-b.example.test/v1",
          models: [],
        },
      },
    };

    const firstA = gatherRoutedModels(configA);
    const firstB = gatherRoutedModels(configB);
    const secondA = gatherRoutedModels(configA);
    await Promise.resolve();
    expect(fetchByHost.get("a")).toBe(1);
    expect(fetchByHost.get("b")).toBe(1);

    releaseA();
    releaseB();
    const [a1, b1, a2] = await Promise.all([firstA, firstB, secondA]);
    expect(fetchByHost.get("a")).toBe(1);
    expect(fetchByHost.get("b")).toBe(1);
    expect(a1.map(m => `${m.provider}/${m.id}`)).toEqual(["a/model-a"]);
    expect(b1.map(m => `${m.provider}/${m.id}`)).toEqual(["b/model-b"]);
    expect(a2).toEqual(a1);
  });

  test("an omitted registry-static setting never shares a flight with explicit live discovery", async () => {
    let fetchCount = 0;
    globalThis.fetch = (async () => {
      fetchCount += 1;
      return new Response(JSON.stringify({ data: [{ id: "live-only" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const config = (liveModels?: true): OcxConfig => ({
      port: 10100,
      defaultProvider: "alibaba-token-plan",
      providers: {
        "alibaba-token-plan": {
          adapter: "openai-chat",
          baseUrl: "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
          apiKey: "test-key",
          models: ["configured-static"],
          ...(liveModels === undefined ? {} : { liveModels }),
        },
      },
    });

    const [registryStatic, explicitLive] = await Promise.all([
      gatherRoutedModels(config()),
      gatherRoutedModels(config(true)),
    ]);

    expect(fetchCount).toBe(1);
    expect(registryStatic.map(model => model.id)).toEqual(["configured-static"]);
    expect(explicitLive.map(model => model.id)).toEqual(["live-only"]);
  });

  test("concurrent distinct keys keep flight-local combo omissions", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ data: [{ id: "m1" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as typeof fetch;

    const mk = (comboId: string, provider: string, baseUrl: string): OcxConfig => ({
      port: 10100,
      defaultProvider: provider,
      providers: {
        [provider]: {
          adapter: "openai-chat",
          baseUrl,
          models: [],
        },
      },
      combos: {
        [comboId]: {
          strategy: "failover",
          stickyLimit: 1,
          defaultEffort: "medium",
          alias: null,
          targets: [
            { provider, model: "m1", weight: 1 },
            { provider: "missing", model: "x", weight: 1 },
          ],
        },
      },
    });

    const oA: ComboCatalogOmission[] = [];
    const oB: ComboCatalogOmission[] = [];
    await Promise.all([
      gatherRoutedModels(mk("incomplete-a", "a", "https://a.example.test/v1"), { comboOmissions: oA }),
      gatherRoutedModels(mk("incomplete-b", "b", "https://b.example.test/v1"), { comboOmissions: oB }),
    ]);
    expect(oA.some(item => item.id === "incomplete-a")).toBe(true);
    expect(oB.some(item => item.id === "incomplete-b")).toBe(true);
    expect(oA).not.toEqual(oB);
  });

  test("catalog-hint-only config changes do not join a prior flight", async () => {
    let fetchCount = 0;
    globalThis.fetch = (async () => {
      fetchCount += 1;
      return new Response(JSON.stringify({ data: [{ id: "m1" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const baseProv = {
      adapter: "openai-chat" as const,
      baseUrl: "https://hint.example.test/v1",
      models: [] as string[],
      liveModels: false as const,
    };
    // liveModels:false uses configured models — still fingerprints context hints.
    const configA: OcxConfig = {
      port: 10100,
      defaultProvider: "p",
      providers: {
        p: { ...baseProv, models: ["m1"], modelContextWindows: { m1: 100_000 } },
      },
    };
    const configB: OcxConfig = {
      port: 10100,
      defaultProvider: "p",
      providers: {
        p: { ...baseProv, models: ["m1"], modelContextWindows: { m1: 200_000 } },
      },
    };

    const [a, b] = await Promise.all([gatherRoutedModels(configA), gatherRoutedModels(configB)]);
    expect(fetchCount).toBe(0); // configured models, no live fetch
    expect(a.find(m => m.id === "m1")?.contextWindow).toBe(100_000);
    expect(b.find(m => m.id === "m1")?.contextWindow).toBe(200_000);
  });

  test("selectedModels-only config changes do not share a flight", async () => {
    let fetchCount = 0;
    let release!: () => void;
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });

    globalThis.fetch = (async () => {
      fetchCount += 1;
      await gate;
      return new Response(
        JSON.stringify({ data: [{ id: "keep-me" }, { id: "drop-me" }] }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;

    const base: OcxConfig = {
      port: 10100,
      defaultProvider: "p",
      providers: {
        p: {
          adapter: "openai-chat",
          baseUrl: "https://sel.example.test/v1",
          models: [],
        },
      },
    };
    const withSel: OcxConfig = {
      ...base,
      providers: {
        p: {
          ...base.providers.p,
          selectedModels: ["keep-me"],
        },
      },
    };

    const first = gatherRoutedModels(base);
    const second = gatherRoutedModels(withSel);
    await Promise.resolve();
    // Distinct flight keys => two live discoveries (cannot reuse unfiltered result).
    expect(fetchCount).toBe(2);
    release();
    const [all, withSelModels] = await Promise.all([first, second]);
    // gather itself is unfiltered; visibility is applied by callers.
    expect(all.map(m => m.id).sort()).toEqual(["drop-me", "keep-me"]);
    expect(withSelModels.map(m => m.id).sort()).toEqual(["drop-me", "keep-me"]);
    expect(filterCatalogVisibleModels(all, base).map(m => m.id).sort()).toEqual(["drop-me", "keep-me"]);
    expect(filterCatalogVisibleModels(withSelModels, withSel).map(m => m.id)).toEqual(["keep-me"]);
  });

  test("disabledModels-only config changes do not share a flight", async () => {
    let fetchCount = 0;
    let release!: () => void;
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });

    globalThis.fetch = (async () => {
      fetchCount += 1;
      await gate;
      return new Response(
        JSON.stringify({ data: [{ id: "keep-me" }, { id: "drop-me" }] }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;

    const base: OcxConfig = {
      port: 10100,
      defaultProvider: "p",
      providers: {
        p: {
          adapter: "openai-chat",
          baseUrl: "https://dis.example.test/v1",
          models: [],
        },
      },
    };
    const withDisabled: OcxConfig = {
      ...base,
      disabledModels: ["p/drop-me"],
    };

    const first = gatherRoutedModels(base);
    const second = gatherRoutedModels(withDisabled);
    await Promise.resolve();
    expect(fetchCount).toBe(2);
    release();
    const [all, withDisabledModels] = await Promise.all([first, second]);
    expect(all.map(m => m.id).sort()).toEqual(["drop-me", "keep-me"]);
    expect(withDisabledModels.map(m => m.id).sort()).toEqual(["drop-me", "keep-me"]);
    expect(filterCatalogVisibleModels(all, base).map(m => m.id).sort()).toEqual(["drop-me", "keep-me"]);
    expect(filterCatalogVisibleModels(withDisabledModels, withDisabled).map(m => m.id)).toEqual(["keep-me"]);
  });

  test("ninth distinct catalog gather is busy while same-fingerprint caller still joins", async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let fetchCount = 0;
    globalThis.fetch = (async () => {
      fetchCount += 1;
      await gate;
      return new Response(JSON.stringify({ data: [{ id: "model" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    const configs = Array.from({ length: 9 }, (_, index): OcxConfig => ({
      port: 10100,
      defaultProvider: `p${index}`,
      providers: {
        [`p${index}`]: {
          adapter: "openai-chat",
          baseUrl: `https://provider-${index}.example.test/v1`,
          models: [],
        },
      },
    }));
    const admitted = configs.slice(0, 8).map(config => gatherRoutedModels(config));
    const joiner = gatherRoutedModels(configs[0]!);
    await Promise.resolve();
    expect(fetchCount).toBe(8);
    await expect(gatherRoutedModels(configs[8]!)).rejects.toBeInstanceOf(CatalogGatherBusyError);
    release();
    const [first, joined] = await Promise.all([admitted[0]!, joiner]);
    await Promise.all(admitted.slice(1));
    expect(joined).toEqual(first);
  });

});
