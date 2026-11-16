/**
 * Per-provider opt-in that skips individually invalid /models rows (#7910).
 *
 * The reduced listing from the issue — one empty-id row plus one valid row — must keep failing
 * by default, with a diagnostic that counts the invalid rows and names the opt-in, and must
 * publish the valid row once `providers.<name>.modelDiscovery.skipInvalidRows` is true. A listing
 * with no surviving row stays malformed: it never becomes an authoritative empty roster.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as configStore from "../../src/config";
import { flushConfigDirHardeningForTests } from "../../src/config/paths";
import { gatherRoutedModels } from "../../src/codex/catalog";
import { clearModelCache, getProviderDiscoveryStatus } from "../../src/codex/model-cache";
import { extractProviderModelItems, resolveProviderModelDiscovery } from "../../src/providers/model-discovery";
import { invalidModelDiscoveryHint } from "../../src/providers/model-discovery-diagnostic";
import { initializeProviderModelSelection } from "../../src/providers/initial-model-selection";
import { handleManagementAPI } from "../../src/server/management-api";
import type { OcxConfig, OcxProviderConfig } from "../../src/types";
import { catalogConvergenceFactory } from "../helpers/catalog-convergence";
import { withStubbedProviderFetch } from "../helpers/catalog-provider-fetch";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "../helpers/isolated-codex-home";
import { ManagementRequest } from "../helpers/management-auth";
import { removeTreeWithRetry } from "../helpers/remove-tree";

/** The issue's reduced two-row example. */
const ISSUE_LISTING = {
  object: "list",
  data: [
    { id: "", object: "model" },
    { id: "example-chat-model", object: "model" },
  ],
};

const BASE_URL = "https://gateway.example.test/v1";
const originalFetch = globalThis.fetch;

function resolved(skipInvalidRows?: boolean) {
  return resolveProviderModelDiscovery("gateway", {
    adapter: "openai-chat",
    baseUrl: BASE_URL,
    ...(skipInvalidRows === undefined ? {} : { modelDiscovery: { skipInvalidRows } }),
  });
}

function gatewayProvider(overrides: Partial<OcxProviderConfig> = {}): OcxProviderConfig {
  return { adapter: "openai-chat", baseUrl: BASE_URL, authMode: "key", apiKey: "fixture-key", ...overrides };
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  clearModelCache();
});

describe("row extraction with modelDiscovery.skipInvalidRows (#7910)", () => {
  test("unset keeps rejecting the listing and counts every invalid row", () => {
    const discovery = resolved();
    expect(Object.hasOwn(discovery, "skipInvalidRows")).toBe(false);
    expect(extractProviderModelItems(ISSUE_LISTING, discovery))
      .toEqual({ ok: false, reason: "invalid_shape", diagnostic: "row 0 has an empty id; 1 of 2 rows invalid" });
    expect(extractProviderModelItems(ISSUE_LISTING, resolved(false)))
      .toEqual({ ok: false, reason: "invalid_shape", diagnostic: "row 0 has an empty id; 1 of 2 rows invalid" });
    expect(extractProviderModelItems({ data: [{ id: "a" }, { id: 7 }, null, { id: "" }] }, discovery))
      .toEqual({ ok: false, reason: "invalid_shape", diagnostic: "row 1 has a non-string id; 3 of 4 rows invalid" });
  });

  test("a clean listing is unchanged whether or not the opt-in is set", () => {
    const listing = { data: [{ id: "a" }, { id: "b" }] };
    const expected = { ok: true, rawCount: 2, items: [{ id: "a" }, { id: "b" }] };
    expect(extractProviderModelItems(listing, resolved())).toStrictEqual(expected);
    expect(extractProviderModelItems(listing, resolved(true))).toStrictEqual(expected);
  });

  test("the opt-in skips the empty-id row and keeps the valid one", () => {
    expect(extractProviderModelItems(ISSUE_LISTING, resolved(true))).toStrictEqual({
      ok: true,
      rawCount: 2,
      skippedInvalidRows: 1,
      items: [{ id: "example-chat-model", object: "model" }],
    });
  });

  test("missing, non-string, blank and unsafe ids and non-object rows are all skipped", () => {
    const data = [
      { object: "model" },
      { id: 7 },
      { id: null },
      { id: "   " },
      { id: " padded" },
      { id: "line\nbreak" },
      null,
      "string-row",
      ["array-row"],
      { id: "kept" },
    ];
    expect(extractProviderModelItems({ data }, resolved(true))).toStrictEqual({
      ok: true,
      rawCount: data.length,
      skippedInvalidRows: data.length - 1,
      items: [{ id: "kept" }],
    });
  });

  test("an all-invalid listing stays malformed under the opt-in", () => {
    expect(extractProviderModelItems({ data: [{ id: "" }, { id: null }] }, resolved(true)))
      .toEqual({ ok: false, reason: "invalid_shape", diagnostic: "row 0 has an empty id; 2 of 2 rows invalid" });
  });

  test("a partly invalid listing with no admitted row never becomes an authoritative empty roster", () => {
    const discovery = {
      ...resolved(true),
      spec: { filter: { anyOf: [{ path: ["kind"], equalsAny: ["chat"] }] } },
    };
    expect(extractProviderModelItems({ data: [{ id: "" }, { id: "embed", kind: "embedding" }] }, discovery))
      .toEqual({ ok: false, reason: "invalid_shape", diagnostic: "row 0 has an empty id; 1 of 2 rows invalid" });
    // An empty listing with nothing skipped keeps today's authoritative-empty result.
    expect(extractProviderModelItems({ data: [] }, resolved(true))).toStrictEqual({ ok: true, rawCount: 0, items: [] });
  });

  test("deduplication, filters, stripIdPrefix and preferFirst apply to the surviving rows", () => {
    const discovery = {
      ...resolved(true),
      spec: {
        stripIdPrefix: "vendor/",
        filter: { noneOf: [{ path: ["kind"], equalsAny: ["embedding"] }] },
        preferFirst: [{ path: ["featured"], equalsAny: [true] }],
      },
    };
    expect(extractProviderModelItems({
      data: [
        { id: "" },
        { id: "vendor/chat-a" },
        { id: "chat-a" },
        { id: "vendor/" },
        { id: "embed", kind: "embedding" },
        { id: 3 },
        { id: "chat-b", featured: true },
      ],
    }, discovery)).toStrictEqual({
      ok: true,
      rawCount: 7,
      skippedInvalidRows: 2,
      items: [{ id: "chat-b", featured: true }, { id: "chat-a" }],
    });
  });

  test("the row-count limit counts invalid rows as received", () => {
    expect(extractProviderModelItems({ data: [{ id: "" }, { id: "a" }, { id: "b" }] }, { ...resolved(true), maxModels: 2 }))
      .toEqual({ ok: false, reason: "too_many_models" });
  });
});

describe("malformed-listing hint (#7910)", () => {
  test("names the opt-in alongside liveModels: false and keeps the row count", () => {
    const hint = invalidModelDiscoveryHint("row 0 has an empty id; 1 of 2 rows invalid");
    expect(hint).toContain("(row 0 has an empty id; 1 of 2 rows invalid)");
    expect(hint).toContain("modelDiscovery.skipInvalidRows: true");
    expect(hint).toContain("liveModels: false");
    expect(hint).toContain("pending");
  });

  test("with the opt-in already on, it reports that no row survived instead of suggesting it again", () => {
    const hint = invalidModelDiscoveryHint("row 0 has an empty id; 2 of 2 rows invalid", true);
    expect(hint).toContain("2 of 2 rows invalid");
    expect(hint).toContain("modelDiscovery.skipInvalidRows");
    expect(hint).not.toContain("skipInvalidRows: true");
    expect(hint).toContain("liveModels: false");
  });

  test("an envelope failure without a row diagnostic keeps the original guidance", () => {
    expect(invalidModelDiscoveryHint()).toBe(
      ". A newly added API-key provider can keep its model selection pending while discovery fails; a static models list with liveModels: false avoids discovery for gateways publishing invalid rows.",
    );
  });
});

describe("catalog discovery with the opt-in (#7910)", () => {
  function stubListing(): void {
    const listing = structuredClone(ISSUE_LISTING) as { data: Array<Record<string, unknown>> };
    listing.data[0]!.private_note = "private-row-value";
    globalThis.fetch = (async () => Response.json(listing)) as unknown as typeof fetch;
  }

  function gatewayConfig(provider: OcxProviderConfig): OcxConfig {
    return withStubbedProviderFetch({ port: 10100, defaultProvider: "gateway", providers: { gateway: provider } });
  }

  test("publishes the valid row and warns once with the skipped count, without row contents", async () => {
    stubListing();
    const warning = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const config = gatewayConfig(gatewayProvider({ modelDiscovery: { skipInvalidRows: true } }));
      const first = await gatherRoutedModels(config);
      expect(first.filter(model => model.provider === "gateway").map(model => model.id)).toEqual(["example-chat-model"]);
      expect(getProviderDiscoveryStatus("gateway")).toEqual({ status: "ok" });
      clearModelCache("gateway");
      const second = await gatherRoutedModels(config);
      expect(second.filter(model => model.provider === "gateway").map(model => model.id)).toEqual(["example-chat-model"]);
      const messages = warning.mock.calls.map(call => call.join(" "));
      const skipped = messages.filter(message => message.includes("skipped"));
      expect(skipped).toHaveLength(1);
      expect(skipped[0]).toContain("\"gateway\"");
      expect(skipped[0]).toContain("1 invalid of 2 rows");
      expect(skipped[0]).toContain("modelDiscovery.skipInvalidRows");
      expect(messages.join(" ")).not.toContain("private-row-value");
      expect(messages.join(" ")).not.toContain("malformed");
    } finally { warning.mockRestore(); }
  });

  test("without the opt-in the warning counts the rows and names the opt-in, and the fallback stays", async () => {
    stubListing();
    const warning = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const models = await gatherRoutedModels(gatewayConfig(gatewayProvider({ models: ["fallback-model"] })));
      const ids = models.filter(model => model.provider === "gateway").map(model => model.id);
      expect(ids).toContain("fallback-model");
      expect(ids).not.toContain("example-chat-model");
      const message = warning.mock.calls.flat().join(" ");
      expect(message).toContain("row 0 has an empty id; 1 of 2 rows invalid");
      expect(message).toContain("modelDiscovery.skipInvalidRows: true");
      expect(message).toContain("liveModels: false");
      expect(message).not.toContain("private-row-value");
    } finally { warning.mockRestore(); }
  });

  test("with the opt-in an all-invalid listing keeps the configured fallback", async () => {
    globalThis.fetch = (async () => Response.json({ data: [{ id: "" }, { id: 9 }] })) as unknown as typeof fetch;
    const warning = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const config = gatewayConfig(gatewayProvider({ models: ["fallback-model"], modelDiscovery: { skipInvalidRows: true } }));
      const models = await gatherRoutedModels(config);
      expect(models.filter(model => model.provider === "gateway").map(model => model.id)).toEqual(["fallback-model"]);
      expect(getProviderDiscoveryStatus("gateway")?.status).toBe("failed");
      const message = warning.mock.calls.flat().join(" ");
      expect(message).toContain("2 of 2 rows invalid");
      expect(message).not.toContain("skipInvalidRows: true");
    } finally { warning.mockRestore(); }
  });
});

describe("initial model selection for a newly registered provider (#7910)", () => {
  let home = "";
  let previousHome: string | undefined;
  let codex: IsolatedCodexHome;
  beforeEach(() => {
    previousHome = process.env.OPENCODEX_HOME;
    home = mkdtempSync(join(tmpdir(), "ocx-skip-invalid-rows-"));
    process.env.OPENCODEX_HOME = home;
    codex = installIsolatedCodexHome("ocx-skip-invalid-rows-codex-");
  });
  afterEach(async () => {
    await flushConfigDirHardeningForTests();
    codex.restore();
    if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = previousHome;
    removeTreeWithRetry(home);
  });

  async function listModels(provider: OcxProviderConfig): Promise<{ config: OcxConfig; rows: Array<{ provider: string; id: string }> }> {
    initializeProviderModelSelection("gateway", provider);
    expect(provider.initialModelSelection?.status).toBe("pending");
    const config = withStubbedProviderFetch<OcxConfig>({
      port: 0, defaultProvider: "gateway", providers: { gateway: provider }, clientIntegrations: { codex: false },
    });
    configStore.saveConfig(config);
    globalThis.fetch = (async () => Response.json(ISSUE_LISTING)) as unknown as typeof fetch;
    const url = new URL("http://localhost/api/models");
    const response = await handleManagementAPI(new ManagementRequest(url, {}), url, config, {
      createManagementConvergeCodex: catalogConvergenceFactory(),
    });
    if (!response) throw new Error("route missing");
    expect(response.status).toBe(200);
    const rows = (await response.json() as Array<{ provider: string; id: string }>)
      .filter(row => row.provider === "gateway");
    return { config, rows };
  }

  test("valid rows kept by the opt-in make the selection ready", async () => {
    const warning = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { config, rows } = await listModels(gatewayProvider({ modelDiscovery: { skipInvalidRows: true } }));
      expect(rows.map(row => row.id)).toEqual(["example-chat-model"]);
      expect(config.providers.gateway!.initialModelSelection).toEqual({
        version: 1, registrationId: expect.any(String), status: "ready", modelCount: 1,
      });
      expect(configStore.loadConfig().providers.gateway!.initialModelSelection?.status).toBe("ready");
    } finally { warning.mockRestore(); }
  });

  test("without the opt-in the same listing keeps the selection pending", async () => {
    const warning = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { config } = await listModels(gatewayProvider({ models: ["example-chat-model"] }));
      expect(config.providers.gateway!.initialModelSelection?.status).toBe("pending");
    } finally { warning.mockRestore(); }
  });
});
