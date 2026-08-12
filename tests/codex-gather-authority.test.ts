import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";

import {
  clearGatherRoutedModelsInflight,
  gatherRoutedModels,
} from "../src/codex/catalog";
import { clearModelCache } from "../src/codex/model-cache";
import { PROVIDER_REGISTRY, type ProviderModelDiscoverySpec } from "../src/providers/registry";
import type { OcxConfig } from "../src/types";
import { withStubbedProviderFetch } from "./helpers/catalog-provider-fetch";
import { withRegistryDiscovery } from "./helpers/provider-registry-discovery";

const originalFetch = globalThis.fetch;

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

function togetherConfig(apiKey = "together-authority-secret"): OcxConfig {
  return withStubbedProviderFetch({
    port: 10100,
    defaultProvider: "together",
    modelCacheTtlMs: 0,
    providers: {
      together: {
        adapter: "openai-chat",
        baseUrl: "https://api.together.xyz/v1",
        authMode: "key",
        apiKey,
        models: ["safe-fallback"],
      },
    },
  });
}

const strictDiscovery: ProviderModelDiscoverySpec = {
  maxModels: 2,
  filter: {
    allOf: [{ path: ["type"], equalsAny: ["chat"] }],
  },
};

afterEach(() => {
  globalThis.fetch = originalFetch;
  clearModelCache();
  clearGatherRoutedModelsInflight();
});

describe("catalog gather discovery-policy authority", () => {
  test("different live registry policies cannot share a flight", async () => {
    const config = togetherConfig();
    const body = {
      data: [
        { id: "chat-one", type: "chat" },
        { id: "chat-two", type: "chat" },
        { id: "embedding-three", type: "embedding" },
      ],
    };
    const warning = spyOn(console, "warn").mockImplementation(() => {});
    try {
      globalThis.fetch = (async () => Response.json(body)) as typeof fetch;
      const control = await withRegistryDiscovery(
        "together",
        strictDiscovery,
        () => gatherRoutedModels(config),
        { preserveCustomDestination: true },
      );
      expect(control.filter(model => model.provider === "together").map(model => model.id))
        .toEqual(["safe-fallback"]);
      expect(warning.mock.calls.flat().join(" ")).toContain("2-row model limit");

      clearModelCache("together");
      clearGatherRoutedModelsInflight();
      warning.mockClear();
      const firstResponse = deferred();
      let fetchCount = 0;
      globalThis.fetch = (async () => {
        fetchCount += 1;
        if (fetchCount === 1) await firstResponse.promise;
        return Response.json(body);
      }) as typeof fetch;
      try {
        let first!: Promise<Awaited<ReturnType<typeof gatherRoutedModels>>>;
        await withRegistryDiscovery(
          "together",
          { maxModels: 3 },
          () => { first = gatherRoutedModels(config); },
          { preserveCustomDestination: true },
        );
        expect(fetchCount).toBe(1);

        let second!: Promise<Awaited<ReturnType<typeof gatherRoutedModels>>>;
        await withRegistryDiscovery(
          "together",
          strictDiscovery,
          () => { second = gatherRoutedModels(config); },
          { preserveCustomDestination: true },
        );
        expect(fetchCount).toBe(2);

        firstResponse.resolve();
        const [permissive, strict] = await Promise.all([first, second]);
        expect(fetchCount).toBe(2);
        expect(permissive.filter(model => model.provider === "together").map(model => model.id))
          .toEqual(["chat-one", "chat-two", "embedding-three"]);
        expect(strict.filter(model => model.provider === "together").map(model => model.id))
          .toEqual(["safe-fallback"]);
        expect(warning.mock.calls.flat().join(" ")).toContain("2-row model limit");
      } finally {
        firstResponse.resolve();
      }
    } finally {
      warning.mockRestore();
    }
  });

  test("a flight uses its captured transport non-match after the registry override is restored", async () => {
    const config = withStubbedProviderFetch({
      port: 10100,
      defaultProvider: "openai-apikey",
      modelCacheTtlMs: 0,
      providers: {
        "openai-apikey": {
          adapter: "openai-responses",
          baseUrl: "https://custom-openai.example/v1",
          authMode: "key",
          apiKey: "custom-openai-secret",
        },
      },
    });
    const responseGate = deferred();
    let fetchCount = 0;
    globalThis.fetch = (async () => {
      fetchCount += 1;
      await responseGate.promise;
      return Response.json({ data: [{ id: "custom-only" }] });
    }) as typeof fetch;

    let pending!: Promise<Awaited<ReturnType<typeof gatherRoutedModels>>>;
    await withRegistryDiscovery(
      "openai-apikey",
      {},
      () => { pending = gatherRoutedModels(config); },
      { preserveCustomDestination: true },
    );
    expect(fetchCount).toBe(1);

    const originalFind = PROVIDER_REGISTRY.find;
    PROVIDER_REGISTRY.find = function forbiddenPostLookupRegistryRead() {
      throw new Error("post-lookup provider registry read");
    } as typeof PROVIDER_REGISTRY.find;
    try {
      responseGate.resolve();
      const models = await pending;
      expect(models.filter(model => model.provider === "openai-apikey").map(model => model.id))
        .toEqual(["custom-only"]);
    } finally {
      PROVIDER_REGISTRY.find = originalFind;
      responseGate.resolve();
    }
  });

  test("credentials and private authority identities stay out of logs and serialized results", async () => {
    const credential = "catalog-authority-privacy-secret";
    const plainDigest = createHash("sha256").update(credential).digest("hex");
    const config = togetherConfig(credential);
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    const error = spyOn(console, "error").mockImplementation(() => {});
    const log = spyOn(console, "log").mockImplementation(() => {});
    globalThis.fetch = (async () => Response.json({ data: [{ id: "privacy-model" }] })) as typeof fetch;
    try {
      const models = await withRegistryDiscovery(
        "together",
        { filter: { allOf: [{ path: ["id"], equalsAny: ["privacy-model"] }] } },
        () => gatherRoutedModels(config),
        { preserveCustomDestination: true },
      );
      const observable = JSON.stringify({
        models,
        logs: [warn, error, log].map(spy => spy.mock.calls),
      });
      expect(observable).not.toContain(credential);
      expect(observable).not.toContain(plainDigest);
      expect(observable).not.toMatch(/[a-f0-9]{64}/i);
    } finally {
      warn.mockRestore();
      error.mockRestore();
      log.mockRestore();
    }
  });

  /**
   * Two admissions that differ ONLY in credential must not share a flight.
   *
   * The flight key's fingerprint carries endpoints and model lists but no
   * `authMode`, key or headers, and discovery policy does not carry them either.
   * So a key rotated through `/api/providers/keys` mid-flight left the second
   * admission joining the first, receiving rows the OLD key had fetched, and
   * reporting `committed` — the catalog ended up holding the old key's models
   * under the new key's admission.
   *
   * Removing `authIdentity` from the join comparison collapses the two fetches
   * back into one and turns this red.
   */
  test("a rotated credential cannot join the flight it did not authorize", async () => {
    clearModelCache("together");
    clearGatherRoutedModelsInflight();

    const firstResponse = deferred();
    const seenKeys: string[] = [];
    let fetchCount = 0;
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      fetchCount += 1;
      const headers = new Headers((init?.headers ?? {}) as HeadersInit);
      seenKeys.push(headers.get("authorization") ?? headers.get("x-api-key") ?? "none");
      if (fetchCount === 1) await firstResponse.promise;
      return Response.json({ data: [{ id: `model-for-call-${fetchCount}` }] });
    }) as unknown as typeof fetch;

    try {
      const oldKey = gatherRoutedModels(togetherConfig("old-key"));
      // The flight claims its slot synchronously, but the request itself starts a
      // few microtasks later; yield until it is actually in flight.
      await Bun.sleep(20);
      expect(fetchCount).toBe(1);

      // The rotation: same provider, same endpoint, same discovery policy — only
      // the credential moved.
      const newKey = gatherRoutedModels(togetherConfig("new-key"));
      await Bun.sleep(20);
      expect(fetchCount).toBe(2);

      firstResponse.resolve();
      await Promise.all([oldKey, newKey]);

      // Each admission fetched under its own credential; neither borrowed the other's.
      expect(seenKeys.some(value => value.includes("old-key"))).toBe(true);
      expect(seenKeys.some(value => value.includes("new-key"))).toBe(true);
    } finally {
      clearGatherRoutedModelsInflight();
      clearModelCache("together");
    }
  });

  /**
   * The general form of the same defect, found after credentials were fixed.
   *
   * `providerCatalogFingerprint` is an allow-list, so every provider field it
   * does not name was treated as equivalence. Credentials leaked a flight until
   * `authIdentity` landed; `reasoningEfforts` leaked one after that, and it
   * changes catalog rows. Enumerating fields cannot converge — the next field
   * added to a provider row inherits the defect — so the join now compares the
   * whole admitted provider graph.
   *
   * This test uses `reasoningEfforts` because that is what the verifier
   * reproduced against real routes, but it is really a test of the general rule:
   * dropping `providerGraphIdentity` from the comparison turns it red.
   */
  test("a provider field outside the legacy fingerprint cannot join another admission's flight", async () => {
    clearModelCache("together");
    clearGatherRoutedModelsInflight();

    const firstResponse = deferred();
    let fetchCount = 0;
    globalThis.fetch = (async () => {
      fetchCount += 1;
      if (fetchCount === 1) await firstResponse.promise;
      return Response.json({ data: [{ id: `model-${fetchCount}` }] });
    }) as typeof fetch;

    const withEfforts = (efforts: readonly string[]): OcxConfig => {
      const config = togetherConfig();
      (config.providers.together as Record<string, unknown>).reasoningEfforts = [...efforts];
      return config;
    };

    try {
      const first = gatherRoutedModels(withEfforts(["low"]));
      await Bun.sleep(20);
      expect(fetchCount).toBe(1);

      // Same provider, same endpoint, same credential, same discovery policy —
      // only a field the legacy fingerprint never listed has moved.
      const second = gatherRoutedModels(withEfforts(["low", "high"]));
      await Bun.sleep(20);
      expect(fetchCount).toBe(2);

      firstResponse.resolve();
      await Promise.all([first, second]);
    } finally {
      clearGatherRoutedModelsInflight();
      clearModelCache("together");
    }
  });

  test("different combo retention sets cannot join another admission's flight (OCX-111)", async () => {
    // retainConfiguredModelIds is part of providerGraphIdentity. Concurrent gathers that
    // share providers but differ in combo targets must not coalesce onto the wrong retain set.
    clearModelCache("or-flight");
    clearGatherRoutedModelsInflight();

    const firstResponse = deferred();
    let fetchCount = 0;
    globalThis.fetch = (async () => {
      fetchCount += 1;
      if (fetchCount === 1) await firstResponse.promise;
      return Response.json({ data: [{ id: "or-flight/other-model" }] });
    }) as typeof fetch;

    const provider = {
      adapter: "openai-chat" as const,
      baseUrl: "https://or-flight.example.test/v1",
      authMode: "key" as const,
      apiKey: "sk-flight",
      liveModels: true as const,
      models: ["openai/gpt-5.6-luna"],
      modelContextWindows: { "openai/gpt-5.6-luna": 200_000 },
    };
    const withoutCombo = withStubbedProviderFetch({
      port: 10100,
      defaultProvider: "or-flight",
      modelCacheTtlMs: 0,
      providers: { "or-flight": provider },
    });
    const withCombo = withStubbedProviderFetch({
      port: 10100,
      defaultProvider: "or-flight",
      modelCacheTtlMs: 0,
      providers: { "or-flight": provider },
      combos: {
        failover: {
          strategy: "failover",
          stickyLimit: 1,
          defaultEffort: "medium",
          alias: null,
          nativeAlias: false,
          displayName: null,
          targets: [
            { provider: "or-flight", model: "openai/gpt-5.6-luna", weight: 1 },
            { provider: "or-flight", model: "or-flight/other-model", weight: 1 },
          ],
        },
      },
    });

    try {
      const first = gatherRoutedModels(withoutCombo);
      await Bun.sleep(20);
      expect(fetchCount).toBe(1);

      const second = gatherRoutedModels(withCombo);
      await Bun.sleep(20);
      expect(fetchCount).toBe(2);

      firstResponse.resolve();
      const [noComboRows, comboRows] = await Promise.all([first, second]);
      expect(noComboRows.some(r => r.provider === "or-flight" && r.id === "openai/gpt-5.6-luna")).toBe(false);
      expect(comboRows.some(r => r.provider === "or-flight" && r.id === "openai/gpt-5.6-luna")).toBe(true);
    } finally {
      clearGatherRoutedModelsInflight();
      clearModelCache("or-flight");
    }
  });
});
