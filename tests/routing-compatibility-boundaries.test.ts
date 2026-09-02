import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleManagementAPI } from "../src/server/management-api";
import { routeModel } from "../src/router";
import { readInstallationSalt } from "../src/lab/subject/installation-salt";
import {
  resetCompatibilityVersionCacheForTests,
  setCompatibilityVersionOverrideForTests,
} from "../src/routing/compatibility/version";
import { ManagementRequest } from "./helpers/management-auth";
import type { OcxConfig } from "../src/types";
import { removeTreeWithRetry } from "./helpers/remove-tree";

let testDir = "";
let previousHome: string | undefined;

function config(): OcxConfig {
  return {
    port: 10100,
    defaultProvider: "a",
    providers: {
      a: {
        adapter: "openai-responses",
        baseUrl: "https://a.example/v1",
        apiKey: "secret",
        models: ["m1"],
      },
    },
    routingProfiles: {
      compat: {
        candidates: [{ provider: "a", model: "m1" }],
        compatibility: {
          requiredSuites: [{ suiteId: "responses-core", evidenceLayer: "live_route_compatibility" }],
          unknownEvidence: "penalize",
          degradedEvidence: "penalize",
        },
      },
    },
  };
}

function managementDeps() {
  return {
    saveConfigPreservingClaudeCode: () => {},
    createManagementConvergeCodex: () => async () => ({
      kind: "catalog-only" as const,
      catalogRefresh: {
        status: "committed" as const,
        changed: false,
        degraded: false,
        notices: [],
      },
    }),
  };
}

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  testDir = mkdtempSync(join(tmpdir(), "ocx-cl06-boundaries-"));
  process.env.OPENCODEX_HOME = testDir;
  readInstallationSalt(testDir);
  setCompatibilityVersionOverrideForTests("f".repeat(64));
});

afterEach(() => {
  resetCompatibilityVersionCacheForTests();
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  // A shutting-down server can still hold a file here, and Windows answers EBUSY
  // rather than unlinking underneath it. Failing teardown would blame a test that
  // already asserted; the state that matters was reset above.
  if (testDir) {
    try {
      removeTreeWithRetry(testDir);
    } catch {
      // Left to the OS.
    }
  }
  testDir = "";
});

describe("CL-06 production/dry-run boundaries", () => {
  test("management dry-run and production routing agree on compatibility penalty and trace", async () => {
    const cfg = config();
    // Deliberately leave the SQLite projection absent. Both real boundaries must
    // assemble the same exact route subject, classify projection absence the same
    // way, and apply the same deterministic penalty without probing/rebuilding.
    const req = new ManagementRequest("http://localhost/api/routing-profiles/dry-run", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ profile: "compat" }),
    });
    const response = await handleManagementAPI(req, new URL(req.url), cfg, managementDeps());
    expect(response?.status).toBe(200);
    const dry = await response!.json() as {
      selectedIndex: number | null;
      candidates: Array<{
        provider: string;
        model: string;
        exclusions: Array<{ code: string; detail?: string }>;
        score?: { total: number; components: Record<string, number | undefined> };
        compatibility?: { suites: Array<Record<string, unknown>> };
      }>;
    };

    const production = routeModel(cfg, "policy/compat");
    const prodCandidate = production.routeDecision?.candidates[0];
    expect(production.providerName).toBe("a");
    expect(production.modelId).toBe("m1");
    expect(dry.selectedIndex).toBe(0);
    expect(dry.candidates[0]?.provider).toBe(prodCandidate?.provider);
    expect(dry.candidates[0]?.model).toBe(prodCandidate?.model);
    expect(dry.candidates[0]?.exclusions).toEqual(prodCandidate?.exclusions);
    expect(dry.candidates[0]?.score?.components.compatibility).toBe(0.3);
    expect(prodCandidate?.score?.components.compatibility).toBe(0.3);
    expect(dry.candidates[0]?.score?.total).toBe(prodCandidate?.score?.total);
    expect(dry.candidates[0]?.compatibility?.suites).toEqual(prodCandidate?.compatibility?.suites);
    expect(prodCandidate?.compatibility?.suites[0]).toMatchObject({
      suiteId: "responses-core",
      evidenceLayer: "live_route_compatibility",
      outcome: "penalized",
      reason: "projection-unavailable",
    });
  });

  test("lab catalog GET leaves config and management mutation hooks untouched", async () => {
    const cfg = config();
    let saves = 0;
    let catalogRefreshes = 0;
    const before = structuredClone(cfg);
    const req = new ManagementRequest("http://localhost/api/lab/catalog", { method: "GET" });
    const response = await handleManagementAPI(req, new URL(req.url), cfg, {
      saveConfigPreservingClaudeCode: () => { saves += 1; },
      createManagementConvergeCodex: () => async () => {
        catalogRefreshes += 1;
        return {
          kind: "catalog-only" as const,
          catalogRefresh: {
            status: "committed" as const,
            changed: false,
            degraded: false,
            notices: [],
          },
        };
      },
    });
    expect(response?.status).toBe(200);
    const body = await response!.json() as { scenarios?: unknown[] };
    expect(Array.isArray(body.scenarios)).toBe(true);
    expect(saves).toBe(0);
    expect(catalogRefreshes).toBe(0);
    expect(cfg).toEqual(before);
  });
});
