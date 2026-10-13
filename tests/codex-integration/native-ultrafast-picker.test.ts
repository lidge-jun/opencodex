/**
 * Native Ultrafast in the Codex speed picker.
 *
 * Users reported that Ultrafast never appeared in the Codex Desktop speed menu for
 * gpt-6-astra or gpt-6.1-sol, even with the Ultra Fast switch on. Codex builds that menu from
 * the model's service_tiers in model_catalog_json, and our generated catalog only ever
 * carried the bundled priority tier. These tests pin the catalog projection on both real
 * writers and the request path that carries the chosen tier to the ChatGPT backend.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repoRoot } from "../helpers/repo-root";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import type { RawEntry } from "../../src/codex/catalog/parsing";
import { mergeCatalogEntriesFromObservedState, type ObservedCatalogMergeInput } from "../../src/codex/catalog/build-entries";
import { applyNativeUltraFastTier, NATIVE_ULTRAFAST_SERVICE_TIER } from "../../src/codex/catalog/native-ultrafast";
import type { RequestLogContext } from "../../src/server/request-log";
import { handleResponses } from "../../src/server/responses/core";
import type { OcxConfig } from "../../src/types";

const ULTRAFAST = { id: "ultrafast", name: "Ultrafast", description: "Lower latency, increased usage; requires an eligible plan" };
const fastTier = (description: string) => ({ id: "priority", name: "Fast", description });
const nativeRow = (slug: string, extra: Partial<RawEntry> = {}): RawEntry => ({
  // A display name equal to the slug marks a fallback row the merge replaces with the pinned
  // upstream entry, so fixtures carry a real one to exercise preserved operator rows.
  slug, display_name: `Test ${slug}`, visibility: "list", base_instructions: "You are Codex.",
  context_window: 272_000, supported_reasoning_levels: [{ effort: "high", description: "High" }],
  service_tiers: [fastTier("2x speed, increased usage")], additional_speed_tiers: ["fast"], ...extra,
});

function merge(catalogModels: RawEntry[], ultraFastTier: boolean, extra: Partial<ObservedCatalogMergeInput> = {}): RawEntry[] {
  return mergeCatalogEntriesFromObservedState({
    catalogModels, routedEntries: [], baselineCatalogModels: [], baseline: new Map(), featured: [],
    wsEnabled: false, template: null, disabledModels: new Set(), selectedModelsByProvider: new Map(),
    gatheredProviderNames: new Set(), degradedProviderNames: new Set(), legacyCustomModelSlugs: new Set(),
    multiAgentMode: "default", multiAgentV2Enabled: false, exactComboSlugs: new Set(),
    hasPhysicalComboProvider: false, includeNativeOpenAi: true, accountBoundEntries: [], ultraFastTier,
    policy: { nativeBackfillSlugs: [], unsupportedNativeEntries: "preserve", warningPolicy: "suppress" },
    ...extra,
  });
}
const row = (rows: RawEntry[], slug: string) => rows.find(entry => entry.slug === slug)!;

describe("native Ultrafast catalog projection", () => {
  const catalog = () => [nativeRow("gpt-6-astra"), nativeRow("gpt-6.1-sol"), nativeRow("gpt-6-sol", {
    service_tiers: [fastTier("1.5x speed")], default_service_tier: "priority",
  })];

  test("the descriptor is the exact picker copy", () => {
    expect(NATIVE_ULTRAFAST_SERVICE_TIER).toEqual(ULTRAFAST);
  });

  test("enabled: Astra and 6.1 Sol gain Ultrafast after Fast, and nothing else on any row moves", () => {
    const off = merge(catalog(), false);
    const on = merge(catalog(), true);
    for (const slug of ["gpt-6-astra", "gpt-6.1-sol"]) {
      expect(row(on, slug).service_tiers).toEqual([fastTier("2x speed, increased usage"), ULTRAFAST]);
      expect(row(on, slug).additional_speed_tiers).toEqual(["fast", "ultrafast"]);
      expect(row(on, slug).opencodex_generated_service_tiers).toEqual(["additional_speed_tiers", "service_tiers"]);
      const { service_tiers: _a, additional_speed_tiers: _b, opencodex_generated_service_tiers: _m, ...restOn } = row(on, slug);
      const { service_tiers: _c, additional_speed_tiers: _d, ...restOff } = row(off, slug);
      expect(restOn).toEqual(restOff);
      expect(row(on, slug).default_service_tier ?? null).toBeNull();
    }
    expect(row(on, "gpt-6-sol")).toEqual(row(off, "gpt-6-sol"));
    expect(on.map(entry => entry.slug)).toEqual(off.map(entry => entry.slug));
  });

  test("repeated syncs never duplicate, and disabling withdraws only the generated tier", () => {
    const once = merge(catalog(), true);
    const twice = merge(once, true);
    expect(twice).toEqual(once);
    const withdrawn = merge(twice, false);
    expect(withdrawn).toEqual(merge(catalog(), false));
    expect(row(withdrawn, "gpt-6.1-sol").service_tiers).toEqual([fastTier("2x speed, increased usage")]);
    expect(row(withdrawn, "gpt-6.1-sol").additional_speed_tiers).toEqual(["fast"]);
  });

  test("an operator-written Ultrafast entry wins and survives disabling", () => {
    const operator = { id: "ultrafast", name: "Ultra Fast", description: "operator supplied" };
    const custom = [nativeRow("gpt-6.1-sol", {
      service_tiers: [fastTier("2x speed, increased usage"), operator], additional_speed_tiers: ["fast", "ultrafast"],
    })];
    for (const enabled of [true, false]) {
      const result = row(merge(custom, enabled), "gpt-6.1-sol");
      expect(result.service_tiers).toEqual([fastTier("2x speed, increased usage"), operator]);
      expect(result.additional_speed_tiers).toEqual(["fast", "ultrafast"]);
    }
  });

  test("routed rows that borrow the model name are not native rows", () => {
    const routed = { slug: "gateway/gpt-6.1-sol", service_tiers: [fastTier("x")], additional_speed_tiers: ["fast"] };
    const entry = structuredClone(routed);
    applyNativeUltraFastTier(entry, true);
    expect(entry).toEqual(routed);
  });

  test("a row missing the tier arrays still gets a well-formed declaration", () => {
    const entry: RawEntry = { slug: "gpt-6-astra" };
    applyNativeUltraFastTier(entry, true);
    expect(entry).toEqual({
      slug: "gpt-6-astra", service_tiers: [ULTRAFAST], additional_speed_tiers: ["ultrafast"],
      opencodex_generated_service_tiers: ["additional_speed_tiers", "service_tiers"],
    });
    applyNativeUltraFastTier(entry, false);
    expect(entry).toEqual({ slug: "gpt-6-astra" });
  });

  test("ownership comes from the provenance marker, never from matching text", () => {
    // An operator may have written the generated descriptor verbatim before this switch existed.
    const handWritten = nativeRow("gpt-6.1-sol", {
      service_tiers: [fastTier("2x speed, increased usage"), { ...ULTRAFAST }], additional_speed_tiers: ["fast", "ultrafast"],
    });
    const off = row(merge([handWritten], false), "gpt-6.1-sol");
    expect(off.service_tiers).toEqual([fastTier("2x speed, increased usage"), ULTRAFAST]);
    expect(off.additional_speed_tiers).toEqual(["fast", "ultrafast"]);
    // Enabling over it claims nothing, so a later disable still leaves it alone.
    const on = row(merge([handWritten], true), "gpt-6.1-sol");
    expect(on.opencodex_generated_service_tiers).toBeUndefined();
    expect(row(merge([on], false), "gpt-6.1-sol").service_tiers).toEqual(off.service_tiers);
    // Only the field the switch filled is withdrawn when the operator supplied the other.
    const speedsOnly = nativeRow("gpt-6.1-sol", { additional_speed_tiers: ["fast", "ultrafast"] });
    const claimed = row(merge([speedsOnly], true), "gpt-6.1-sol");
    expect(claimed.opencodex_generated_service_tiers).toEqual(["service_tiers"]);
    const released = row(merge([claimed], false), "gpt-6.1-sol");
    expect(released.service_tiers).toEqual([fastTier("2x speed, increased usage")]);
    expect(released.additional_speed_tiers).toEqual(["fast", "ultrafast"]);
    expect(released.opencodex_generated_service_tiers).toBeUndefined();
  });
});

for (const writer of ["retained-sync", "convergence"] as const) {
  test(writer + " writes native Ultrafast into the catalog and models cache, and removes it when disabled", () => {
    const root = mkdtempSync(join(tmpdir(), "ocx-native-ultrafast-"));
    const codexHome = join(root, "codex");
    const ocxHome = join(root, "ocx");
    mkdirSync(codexHome); mkdirSync(ocxHome);
    const config = {
      port: 10100, defaultProvider: "openai", ultraFastTier: true,
      providers: { openai: {
        adapter: "openai-responses", authMode: "forward", baseUrl: "https://chatgpt.com/backend-api/codex", liveModels: false,
      } },
    };
    writeFileSync(join(ocxHome, "config.json"), JSON.stringify(config));
    writeFileSync(join(codexHome, "config.toml"), 'model_catalog_json = "opencodex-catalog.json"\n');
    writeFileSync(join(codexHome, "opencodex-catalog.json"), JSON.stringify({ models: [
      { slug: "gpt-5.5", visibility: "list", base_instructions: "You are Codex." },
    ] }));
    const script = `
      const { readFileSync } = require("node:fs");
      const { join } = require("node:path");
      const { saveConfig } = require("./src/config");
      const config = JSON.parse(readFileSync(join(process.env.OPENCODEX_HOME, "config.json"), "utf8"));
      const { syncCatalogModels, invalidateCodexModelsCache } = require("./src/codex/catalog");
      const { captureCatalogAdmissionSnapshot } = require("./src/codex/catalog-admission");
      const { gatherCodexCatalogCandidate, commitCodexCatalogCandidate } = require("./src/codex/convergence");
      const passes = [];
      for (const enabled of [true, true, false]) {
        config.ultraFastTier = enabled;
        saveConfig(config);
        if (${writer === "retained-sync"}) {
          const result = await syncCatalogModels(config, { allowWhenDesiredDisabled: true });
          if (result.refreshOutcome !== "committed") throw new Error(JSON.stringify(result));
          invalidateCodexModelsCache({ allowWhenDesiredDisabled: true });
        } else {
          const gathered = await gatherCodexCatalogCandidate(captureCatalogAdmissionSnapshot(config));
          if (gathered.kind !== "candidate") throw new Error(JSON.stringify(gathered));
          const result = await commitCodexCatalogCandidate(gathered.candidate, 1000);
          if (result.kind !== "committed") throw new Error(JSON.stringify(result));
        }
        passes.push(["opencodex-catalog.json", "models_cache.json"].map(file =>
          JSON.parse(readFileSync(join(process.env.CODEX_HOME, file), "utf8")).models
            .filter(row => ["gpt-6-astra", "gpt-6.1-sol", "gpt-6-sol", "gpt-6-luna"].includes(row.slug))
            .map(row => ({ slug: row.slug, tiers: row.service_tiers, speeds: row.additional_speed_tiers }))));
      }
      console.log("NATIVE_ULTRAFAST=" + JSON.stringify(passes));
    `;
    try {
      const result = spawnSync(process.execPath, ["--eval", script], {
        cwd: repoRoot(), env: { ...process.env, CODEX_HOME: codexHome, OPENCODEX_HOME: ocxHome },
        encoding: "utf8", maxBuffer: 8 * 1024 * 1024, timeout: 30_000,
      });
      expect({ status: result.status, stderr: result.stderr }).toMatchObject({ status: 0 });
      const marker = "NATIVE_ULTRAFAST=";
      const passes = JSON.parse(result.stdout.split("\n").find(line => line.startsWith(marker))!.slice(marker.length)) as
        Array<Array<Array<{ slug: string; tiers: Array<{ id: string }>; speeds: string[] }>>>;
      for (const [index, pass] of passes.entries()) for (const rows of pass) {
        const bySlug = new Map(rows.map(entry => [entry.slug, entry]));
        expect([...bySlug.keys()].sort()).toEqual(["gpt-6-astra", "gpt-6-luna", "gpt-6-sol", "gpt-6.1-sol"]);
        for (const slug of ["gpt-6-astra", "gpt-6.1-sol"]) {
          const entry = bySlug.get(slug)!;
          expect(entry.tiers).toEqual(index < 2
            ? [expect.objectContaining({ id: "priority" }), ULTRAFAST]
            : [expect.objectContaining({ id: "priority" })]);
          expect(entry.speeds).toEqual(index < 2 ? ["fast", "ultrafast"] : ["fast"]);
        }
        for (const slug of ["gpt-6-sol", "gpt-6-luna"]) {
          expect(bySlug.get(slug)!.tiers.map(tier => tier.id)).toEqual(["priority"]);
          expect(bySlug.get(slug)!.speeds).toEqual(["fast"]);
        }
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}

/**
 * The picker choice is only useful if the request carries it. Drive the real Responses
 * handler to the canonical ChatGPT backend and read the outbound body.
 */
describe("an Ultrafast request on the native route", () => {
  const originalFetch = globalThis.fetch;
  const previousHomes = { ocx: process.env.OPENCODEX_HOME, codex: process.env.CODEX_HOME };
  let home = "";
  let releaseSpendHome: (() => void) | undefined;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "ocx-native-ultrafast-req-"));
    process.env.OPENCODEX_HOME = home;
    process.env.CODEX_HOME = home;
    releaseSpendHome = acquireOwnedSpendHome();
  });
  afterEach(() => {
    releaseSpendHome?.();
    releaseSpendHome = undefined;
    globalThis.fetch = originalFetch;
    removeTreeWithRetry(home);
    for (const [key, value] of [["OPENCODEX_HOME", previousHomes.ocx], ["CODEX_HOME", previousHomes.codex]] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  async function outboundTier(fastMode: boolean | undefined, callerTier: string | undefined): Promise<unknown> {
    const token = `header.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1_000) + 86_400 })).toString("base64url")}.signature`;
    writeFileSync(join(home, "auth.json"), JSON.stringify({ tokens: { access_token: token, account_id: "ultrafast-main" } }));
    const sent: Record<string, unknown>[] = [];
    const upstream = {
      id: "resp_ultrafast", object: "response", status: "completed", model: "gpt-6.1-sol",
      output: [], usage: { input_tokens: 10, output_tokens: 2 },
    };
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      sent.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify(upstream), { headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const config: OcxConfig = {
      port: 0, defaultProvider: "openai", ...(fastMode === undefined ? {} : { fastMode }),
      providers: { openai: {
        adapter: "openai-responses", authMode: "forward", baseUrl: "https://chatgpt.com/backend-api/codex", codexAccountMode: "direct",
      } },
    };
    const log: RequestLogContext = { model: "", provider: "" };
    const response = await handleResponses(new Request("http://localhost/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer ultrafast-admission" },
      body: JSON.stringify({
        model: "gpt-6.1-sol", input: "ping", stream: false,
        ...(callerTier === undefined ? {} : { service_tier: callerTier }),
      }),
    }), config, log, {
      admission: { kind: "environment", source: "bearer" },
      turnAdmissionLease: {
        release() {},
        beginCodexAccountSelection() {
          return { mainProfileDraining: false, claimMainProfile: () => true, release() {} };
        },
      },
    });
    await response.text();
    expect(response.status).toBe(200);
    expect(sent).toHaveLength(1);
    return sent[0]?.service_tier;
  }

  test("fastMode absent passes ultrafast through unchanged", async () => {
    expect(await outboundTier(undefined, "ultrafast")).toBe("ultrafast");
  });

  test("fastMode true forces priority, replacing the caller's tier", async () => {
    expect(await outboundTier(true, "ultrafast")).toBe("priority");
    expect(await outboundTier(true, undefined)).toBe("priority");
  });

  test("fastMode false strips every tier", async () => {
    expect(await outboundTier(false, "ultrafast")).toBeUndefined();
    expect(await outboundTier(false, "priority")).toBeUndefined();
  });
});
