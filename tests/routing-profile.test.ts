import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateConfigCandidate } from "../src/config";
import { updateAccountQuota } from "../src/codex/quota";
import { clearAccountQuotaCache } from "../src/providers/quota";
import { handleManagementAPI } from "../src/server/management-api";
import { ManagementRequest } from "./helpers/management-auth";
import { closeRequestHistoryIndex } from "../src/routing/history/indexer";
import {
  getRoutingProfile,
  listRoutingProfileIds,
  normalizeRoutingProfile,
  parsePolicyModelId,
  policyPublicModelId,
  resolvePolicyProfileId,
  routingProfileIssues,
} from "../src/routing/profile";
import { evaluatePolicyProfile } from "../src/routing/evaluator";
import type { OcxConfig } from "../src/types";
import { removeTreeWithRetry } from "./helpers/remove-tree";

let testDir = "";
let previousHome: string | undefined;

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  testDir = mkdtempSync(join(tmpdir(), "ocx-profile-"));
  process.env.OPENCODEX_HOME = testDir;
});

afterEach(() => {
  clearAccountQuotaCache();
  closeRequestHistoryIndex();
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  if (testDir) removeTreeWithRetry(testDir);
});

function baseConfig(overrides: Partial<OcxConfig> = {}): OcxConfig {
  return {
    port: 10100,
    defaultProvider: "a",
    providers: {
      a: { adapter: "openai-chat", baseUrl: "https://a.example/v1", apiKey: "ka", models: ["m1", "m2"] },
      b: { adapter: "openai-chat", baseUrl: "https://b.example/v1", apiKey: "kb", models: ["m2"] },
    },
    combos: { free: { strategy: "failover", targets: [{ provider: "a", model: "m1" }] } },
    codexAccountNamespaces: { work: "acct-1" },
    routingProfiles: {
      fast: {
        alias: "ocx/fast",
        candidates: [
          { provider: "a", model: "m1" },
          { provider: "b", model: "m2" },
        ],
        require: { tools: true, minContextWindow: 128000 },
        optimize: { latency: 0.55, health: 0.25, cost: 0.10, quota: 0.10 },
        limits: { maxEstimatedCostUsd: 0.5 },
        unknownEvidence: { capability: "exclude", health: "penalize", quota: "penalize", cost: "penalize" },
      },
    },
    ...overrides,
  };
}

describe("routing profiles (RI-04)", () => {
  test("normalizes a valid profile with deterministic weights and revision", () => {
    const profile = getRoutingProfile(baseConfig(), "fast")!;
    expect(profile.id).toBe("fast");
    expect(profile.alias).toBe("ocx/fast");
    expect(profile.candidates).toEqual([
      { provider: "a", model: "m1" },
      { provider: "b", model: "m2" },
    ]);
    expect(profile.require).toMatchObject({ tools: true, minContextWindow: 128000 });
    expect(profile.optimize.latency + profile.optimize.health + profile.optimize.cost + profile.optimize.quota).toBeCloseTo(1);
    expect(profile.limits.maxEstimatedCostUsd).toBe(0.5);
    expect(profile.revision).toMatch(/^[0-9a-f]{16}$/);
  });

  test("revision digest is stable and changes with the profile", () => {
    const config = baseConfig();
    const first = getRoutingProfile(config, "fast")!.revision;
    const second = getRoutingProfile(config, "fast")!.revision;
    expect(first).toBe(second);
    const changed = baseConfig({
      routingProfiles: {
        fast: {
          ...config.routingProfiles!.fast!,
          candidates: [{ provider: "a", model: "m1" }],
        },
      },
    });
    expect(getRoutingProfile(changed, "fast")!.revision).not.toBe(first);
  });

  test("weights default and normalize deterministically", () => {
    const config = baseConfig({
      routingProfiles: { only: { candidates: [{ provider: "a", model: "m1" }] } },
    });
    const profile = getRoutingProfile(config, "only")!;
    expect(profile.optimize).toEqual({ latency: 0.55, health: 0.25, cost: 0.1, quota: 0.1 });
    const weighted = baseConfig({
      routingProfiles: { w: { candidates: [{ provider: "a", model: "m1" }], optimize: { latency: 1, cost: 3 } } },
    });
    const normalized = getRoutingProfile(weighted, "w")!;
    // Unspecified weights keep their defaults: latency 1, health 0.25,
    // cost 3, quota 0.1 => sum 4.35, normalized deterministically.
    expect(normalized.optimize.latency).toBeCloseTo(1 / 4.35);
    expect(normalized.optimize.cost).toBeCloseTo(3 / 4.35);
    const sum = normalized.optimize.latency + normalized.optimize.health
      + normalized.optimize.cost + normalized.optimize.quota;
    expect(sum).toBeCloseTo(1);

    const allZero = routingProfileIssues("z", {
      candidates: [{ provider: "a", model: "m1" }],
      optimize: { latency: 0, health: 0, cost: 0, quota: 0 },
    }, config);
    expect(allZero.some(issue => issue.path.join(".") === "optimize")).toBe(true);
    // A partial zero is fine: unspecified weights keep their positive defaults.
    const partialZero = routingProfileIssues("p", {
      candidates: [{ provider: "a", model: "m1" }],
      optimize: { latency: 0 },
    }, config);
    expect(partialZero.some(issue => issue.path.join(".") === "optimize")).toBe(false);
  });

  test("alias collision validation covers providers, combos, account namespaces, native families", () => {
    const config = baseConfig();
    const providerCollision = routingProfileIssues("p", {
      candidates: [{ provider: "a", model: "m1" }],
      alias: "a",
    }, config);
    expect(providerCollision.some(issue => issue.message.includes("provider name"))).toBe(true);

    const comboCollision = routingProfileIssues("p", {
      candidates: [{ provider: "a", model: "m1" }],
      alias: "combo/free",
    }, config);
    expect(comboCollision.some(issue => issue.message.includes("reserved"))).toBe(true);

    const comboAliasCollision = routingProfileIssues("p", {
      candidates: [{ provider: "a", model: "m1" }],
      alias: "faster",
    }, {
      ...config,
      combos: { ...config.combos, free: { strategy: "failover", targets: [{ provider: "a", model: "m1" }], alias: "faster" } },
    });
    expect(comboAliasCollision.some(issue => issue.message.includes("combo selector"))).toBe(true);

    const nativeCollision = routingProfileIssues("p", {
      candidates: [{ provider: "a", model: "m1" }],
      alias: "gpt-5.6",
    }, config);
    expect(nativeCollision.some(issue => issue.message.includes("native family"))).toBe(true);

    const providerNamespaceCollision = routingProfileIssues("p", {
      candidates: [{ provider: "a", model: "m1" }],
      alias: "a/m1",
    }, config);
    // Exactly one issue: the first-segment provider collision must not be
    // reported twice with different wordings.
    const namespaceIssues = providerNamespaceCollision.filter(
      issue => issue.message.includes("provider routing namespace"),
    );
    expect(namespaceIssues.length).toBe(1);
    expect(providerNamespaceCollision.length).toBe(1);

    const accountNamespaceCollision = routingProfileIssues("p", {
      candidates: [{ provider: "a", model: "m1" }],
      alias: "work/anything",
    }, config);
    expect(accountNamespaceCollision.some(
      issue => issue.message.includes("codex account namespace"),
    )).toBe(true);

    const siblingCollision = routingProfileIssues("p", {
      candidates: [{ provider: "a", model: "m1" }],
      alias: "ocx/fast",
    }, config);
    expect(siblingCollision.some(issue => issue.message.includes("already used"))).toBe(true);
  });

  test("candidate validation rejects unconfigured/disabled providers and duplicates", () => {
    const config = baseConfig();
    const unconfigured = routingProfileIssues("p", {
      candidates: [{ provider: "ghost", model: "m1" }],
    }, config);
    expect(unconfigured.some(issue => issue.message.includes("not configured"))).toBe(true);

    const disabled = baseConfig({
      providers: { ...baseConfig().providers, c: { adapter: "openai-chat", baseUrl: "https://c.example/v1", apiKey: "kc", models: ["m3"], disabled: true } },
      routingProfiles: { p: { candidates: [{ provider: "c", model: "m3" }] } },
    });
    expect(routingProfileIssues("p", disabled.routingProfiles!.p, disabled).some(issue => issue.message.includes("disabled"))).toBe(true);

    const duplicates = routingProfileIssues("p", {
      candidates: [
        { provider: "a", model: "m1" },
        { provider: "a", model: "m1" },
      ],
    }, config);
    expect(duplicates.some(issue => issue.message.includes("duplicate"))).toBe(true);
  });

  test("require rejects the reserved unknown service tier", () => {
    const config = baseConfig();
    const reservedTier = routingProfileIssues("p", {
      candidates: [{ provider: "a", model: "m1" }],
      require: { serviceTier: "unknown" },
    }, config);
    expect(reservedTier.some(issue => issue.path.join(".") === "require.serviceTier")).toBe(true);
  });

  test("config load accepts valid profiles and rejects broken ones", () => {
    const valid = validateConfigCandidate(baseConfig());
    expect(valid.ok).toBe(true);

    const broken = validateConfigCandidate(baseConfig({
      routingProfiles: { bad: { candidates: [{ provider: "ghost", model: "m1" }] } },
    }));
    expect(broken.ok).toBe(false);
    if (!broken.ok) expect(broken.error).toContain("routingProfiles");
  });

  test("policy id/alias resolution follows canonical-id-first", () => {
    const config = baseConfig();
    expect(resolvePolicyProfileId(config, "policy/fast")).toBe("fast");
    expect(resolvePolicyProfileId(config, "ocx/fast")).toBe("fast");
    expect(resolvePolicyProfileId(config, "policy/missing")).toBe("missing");
    expect(resolvePolicyProfileId(config, "unknown")).toBeNull();
    expect(parsePolicyModelId("policy/fast")).toBe("fast");
    expect(parsePolicyModelId("a/m1")).toBeNull();
    expect(policyPublicModelId("fast", getRoutingProfile(config, "fast")!)).toBe("ocx/fast");
  });

  test("dry-run evaluator: hard requirements gate eligibility", () => {
    const config = baseConfig();
    const result = evaluatePolicyProfile(config, "fast", { contextWindow: 200000, toolsRequired: true }, [
      { provider: "a", model: "m1", capability: { contextWindow: 200000, tools: true } },
      { provider: "b", model: "m2", capability: { contextWindow: 64000, tools: true } },
    ]);
    expect(result.candidates.length).toBe(2);
    expect(result.candidates[0]).toMatchObject({ eligible: true });
    expect(result.candidates[1]).toMatchObject({ eligible: false });
    expect(result.candidates[1]!.exclusions[0]!.code).toBe("capability-unsatisfied");
    expect(result.selectedIndex).toBe(0);
    expect(result.trace.routeKind).toBe("policy");
    expect(result.trace.profile).toEqual({ id: "fast", revision: result.profileRevision });
    expect(result.trace.selected.provider).toBe("a");
    expect(result.trace.selected.model).toBe("m1");
    expect(result.trace.selected.reason).toBe("policy-selected");
  });

  test("dry-run evaluator: unknown capability follows the profile's unknownEvidence", () => {
    const config = baseConfig();
    const unknownEvidence = { capability: "exclude", health: "penalize", quota: "penalize", cost: "penalize" };
    const strict = baseConfig({
      routingProfiles: { strict: { candidates: [{ provider: "a", model: "m1" }], require: { tools: true }, unknownEvidence } },
      providers: baseConfig().providers,
    });
    const excluded = evaluatePolicyProfile(strict, "strict", { toolsRequired: true }, [
      { provider: "a", model: "m1", capability: { contextWindow: 200000 } },
    ]);
    expect(excluded.candidates[0]!.eligible).toBe(false);
    expect(excluded.candidates[0]!.exclusions.some(exclusion => exclusion.code === "unknown-capability")).toBe(true);
    expect(excluded.selectedIndex).toBeNull();

    const permissive = baseConfig({
      routingProfiles: { permissive: { candidates: [{ provider: "a", model: "m1" }], require: { tools: true }, unknownEvidence: { ...unknownEvidence, capability: "allow" } } },
    });
    const allowed = evaluatePolicyProfile(permissive, "permissive", { toolsRequired: true }, [
      { provider: "a", model: "m1", capability: { contextWindow: 200000 } },
    ]);
    expect(allowed.candidates[0]!.eligible).toBe(true);
    expect(allowed.selectedIndex).toBe(0);
  });

  test("dry-run evaluator: request evidence joins profile requirements", () => {
    const config = baseConfig();
    // Profile `fast` requires tools + 128k context; the request also needs 256k.
    const result = evaluatePolicyProfile(config, "fast", { contextWindow: 256000, toolsRequired: true }, [
      { provider: "a", model: "m1", capability: { contextWindow: 200000, tools: true } },
      { provider: "b", model: "m2", capability: { contextWindow: 300000, tools: true } },
    ]);
    expect(result.candidates[0]!.eligible).toBe(false);
    expect(result.candidates[0]!.exclusions.some(exclusion => exclusion.detail === "request-context-window")).toBe(true);
    expect(result.candidates[1]!.eligible).toBe(true);
    expect(result.selectedIndex).toBe(1);
    expect(result.trace.selected.model).toBe("m2");
  });

  test("dry-run evaluator: absent request flags add no requirements", () => {
    const config = baseConfig();
    const result = evaluatePolicyProfile(config, "fast", { toolsRequired: false }, [
      { provider: "a", model: "m1", capability: { contextWindow: 200000, tools: true } },
    ]);
    expect(result.candidates[0]!.requirements.some(requirement => requirement.id === "request-tools")).toBe(false);
    // Profile `fast` still requires tools; the candidate satisfies it.
    expect(result.candidates[0]!.eligible).toBe(true);
    expect(result.selectedIndex).toBe(0);
  });

  test("dry-run evaluator: cost limit excludes over-limit candidates", () => {
    const config = baseConfig();
    const result = evaluatePolicyProfile(config, "fast", {}, [
      { provider: "a", model: "m1", capability: { contextWindow: 200000, tools: true }, cost: { estimatedUsd: 1.2 } },
      { provider: "b", model: "m2", capability: { contextWindow: 200000, tools: true }, cost: { estimatedUsd: 0.2 } },
    ]);
    expect(result.candidates[0]!.eligible).toBe(false);
    expect(result.candidates[0]!.exclusions.some(exclusion => exclusion.code === "cost-limit")).toBe(true);
    expect(result.candidates[1]!.eligible).toBe(true);
    expect(result.selectedIndex).toBe(1);
  });

  test("dry-run evaluator: deterministic priority picks the earlier candidate", () => {
    const config = baseConfig({
      routingProfiles: { tie: { candidates: [
        { provider: "a", model: "m1" },
        { provider: "b", model: "m2" },
      ], require: { minContextWindow: 1000 } } },
    });
    const result = evaluatePolicyProfile(config, "tie", { contextWindow: 2000 }, [
      { provider: "a", model: "m1", capability: { contextWindow: 5000 } },
      { provider: "b", model: "m2", capability: { contextWindow: 5000 } },
    ]);
    expect(result.selectedIndex).toBe(0);
    // RI-06/07/08: unknown health/quota/cost under the default "penalize"
    // policy folds penalized floors into the score. #1837: an unmeasured
    // candidate takes the NEUTRAL latency score, so both tie and declaration
    // order still decides -- which is correct when nothing distinguishes them.
    expect(result.trace.candidates[0]!.score).toMatchObject({
      components: { configuredPriority: 1, health: 0.3, quota: 0.3, cost: 0.3, latency: 0.5 },
    });
  });

  test("dry-run evaluator: optimize.latency actually prefers the faster candidate (#1837)", () => {
    // The knob was normalized into the weight sum but never spent, so whatever was
    // allocated to latency silently became configuredPriority -- i.e. declaration order.
    // A latency-weighted profile must be able to pick a LATER-declared faster candidate.
    const config = baseConfig({
      routingProfiles: { fastest: {
        candidates: [{ provider: "a", model: "m1" }, { provider: "b", model: "m2" }],
        optimize: { latency: 1, health: 0, cost: 0, quota: 0 },
      } },
    });
    const result = evaluatePolicyProfile(config, "fastest", {}, [
      { provider: "a", model: "m1", health: { sampleCount: 10, successRate: 1, recentLatencyMs: 50_000 } },
      { provider: "b", model: "m2", health: { sampleCount: 10, successRate: 1, recentLatencyMs: 1_000 } },
    ]);

    expect(result.selectedIndex).toBe(1);
    expect(result.trace.candidates[1]!.score!.components.latency)
      .toBeGreaterThan(result.trace.candidates[0]!.score!.components.latency!);
  });

  test("dry-run evaluator: an unmeasured candidate is not punished below a slow one (#1837)", () => {
    // Scoring an unknown p50 as 0 would make selection depend on which candidate happened
    // to be exercised first, reintroducing the order-dependence by another name.
    const config = baseConfig({
      routingProfiles: { fastest: {
        candidates: [{ provider: "a", model: "m1" }, { provider: "b", model: "m2" }],
        optimize: { latency: 1, health: 0, cost: 0, quota: 0 },
      } },
    });
    const result = evaluatePolicyProfile(config, "fastest", {}, [
      { provider: "a", model: "m1", health: { sampleCount: 10, successRate: 1, recentLatencyMs: 55_000 } },
      { provider: "b", model: "m2" },
    ]);

    expect(result.trace.candidates[1]!.score!.components.latency)
      .toBeGreaterThan(result.trace.candidates[0]!.score!.components.latency!);
  });

  test("dry-run evaluator: latency:0 leaves declaration-order behavior unchanged (#1837)", () => {
    // Existing profiles that never set the knob must not change behavior.
    const config = baseConfig({
      routingProfiles: { ordered: {
        candidates: [{ provider: "a", model: "m1" }, { provider: "b", model: "m2" }],
        optimize: { latency: 0, health: 0, cost: 0, quota: 1 },
      } },
    });
    const result = evaluatePolicyProfile(config, "ordered", {}, [
      { provider: "a", model: "m1", health: { sampleCount: 10, successRate: 1, recentLatencyMs: 50_000 } },
      { provider: "b", model: "m2", health: { sampleCount: 10, successRate: 1, recentLatencyMs: 1_000 } },
    ]);

    expect(result.selectedIndex).toBe(0);
    expect(result.trace.candidates[0]!.score!.components.latency).toBeUndefined();
  });

  test("API lists profiles and dry-runs deterministically", async () => {
    const config = baseConfig();
    const listReq = new ManagementRequest("http://localhost/api/routing-profiles", { method: "GET" });
    const listResponse = await handleManagementAPI(listReq, new URL(listReq.url), config, { refreshCodexCatalog: async () => {} });
    expect(listResponse).not.toBeNull();
    expect(listResponse!.status).toBe(200);
    const listBody = await listResponse!.json() as { profiles?: Array<{ id?: string; revision?: string }> };
    expect(listBody.profiles?.length).toBe(1);
    expect(listBody.profiles![0]).toMatchObject({
      id: "fast",
      model: "ocx/fast",
      revision: getRoutingProfile(config, "fast")!.revision,
    });

    const dryReq = new ManagementRequest("http://localhost/api/routing-profiles/dry-run", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        profile: "fast",
        evidence: { contextWindow: 200000, toolsRequired: true },
        candidates: [
          { provider: "a", model: "m1", capability: { contextWindow: 200000, tools: true } },
          { provider: "b", model: "m2", capability: { contextWindow: 64000, tools: true } },
        ],
      }),
    });
    const dryResponse = await handleManagementAPI(dryReq, new URL(dryReq.url), config, { refreshCodexCatalog: async () => {} });
    expect(dryResponse!.status).toBe(200);
    const dryBody = await dryResponse!.json() as { selectedIndex?: number | null; trace?: { selected?: { provider?: string } } };
    expect(dryBody.selectedIndex).toBe(0);
    expect(dryBody.trace?.selected?.provider).toBe("a");
  });

  test("API dry-run rejects unknown profiles and invalid evidence", async () => {
    const config = baseConfig();
    const unknownReq = new ManagementRequest("http://localhost/api/routing-profiles/dry-run", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ profile: "nope", evidence: {} }),
    });
    const unknownResponse = await handleManagementAPI(unknownReq, new URL(unknownReq.url), config, { refreshCodexCatalog: async () => {} });
    expect(unknownResponse!.status).toBe(404);

    const badReq = new ManagementRequest("http://localhost/api/routing-profiles/dry-run", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ profile: "fast", evidence: "junk" }),
    });
    const badResponse = await handleManagementAPI(badReq, new URL(badReq.url), config, { refreshCodexCatalog: async () => {} });
    expect(badResponse!.status).toBe(400);
  });

  test("API dry-run without explicit candidates fills the same evidence as execution", async () => {
    const config = baseConfig({
      providers: {
        a: { adapter: "openai-chat", baseUrl: "https://a.example/v1", apiKey: "ka", models: ["m1"], modelContextWindows: { m1: 200_000 }, parallelToolCalls: true },
        b: { adapter: "openai-chat", baseUrl: "https://b.example/v1", apiKey: "kb", models: ["m2"], modelContextWindows: { m2: 64_000 } },
      },
      routingProfiles: {
        fast: {
          alias: "ocx/fast",
          candidates: [
            { provider: "a", model: "m1" },
            { provider: "b", model: "m2" },
          ],
          require: { tools: true, minContextWindow: 128000 },
        },
      },
    });
    const req = new ManagementRequest("http://localhost/api/routing-profiles/dry-run", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ profile: "fast", evidence: {} }),
    });
    const response = await handleManagementAPI(req, new URL(req.url), config, { refreshCodexCatalog: async () => {} });
    expect(response).not.toBeNull();
    expect(response!.status).toBe(200);
    const body = await response!.json() as { selectedIndex?: number | null; candidates?: Array<{ provider?: string; eligible?: boolean }> };
    // a: 200k context + openai-chat tools => eligible; b: 64k below the hard
    // minimum => excluded, exactly like real routing would report.
    expect(body.selectedIndex).toBe(0);
    expect(body.candidates?.[0]).toMatchObject({ provider: "a", eligible: true });
    expect(body.candidates?.[1]).toMatchObject({ provider: "b", eligible: false });
  });

  test("API dry-run mirrors live codex cooldown for openai candidates", async () => {
    const { clearCodexUpstreamHealth, recordCodexUpstreamOutcome } = await import("../src/codex/routing");
    clearCodexUpstreamHealth();
    const now = Date.now();
    const config = baseConfig({
      providers: {
        a: { adapter: "openai-chat", baseUrl: "https://a.example/v1", apiKey: "ka", models: ["m1"], modelContextWindows: { m1: 200_000 }, parallelToolCalls: true },
        openai: { adapter: "openai-responses", authMode: "forward", baseUrl: "https://chatgpt.com/backend-api/codex" },
      },
      codexAccounts: [{ id: "pool-a", email: "pool-a@example.test", isMain: false }],
      activeCodexAccountId: "pool-a",
      routingProfiles: {
        only: { candidates: [{ provider: "openai", model: "gpt-5.6" }] },
      },
    });
    recordCodexUpstreamOutcome(config, "pool-a", 429, { retryAfter: "3600", now });
    const req = new ManagementRequest("http://localhost/api/routing-profiles/dry-run", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ profile: "only", evidence: {} }),
    });
    const response = await handleManagementAPI(req, new URL(req.url), config, { refreshCodexCatalog: async () => {} });
    expect(response).not.toBeNull();
    expect(response!.status).toBe(200);
    const body = await response!.json() as { candidates?: Array<{ eligible?: boolean; exclusions?: Array<{ code: string }> }> };
    expect(body.candidates?.[0]?.eligible).toBe(false);
    expect(body.candidates?.[0]?.exclusions?.some(exclusion => exclusion.code === "cooldown")).toBe(true);
  });

  test("API dry-run derives quota evidence from candidates[].codexAccountId", async () => {
    updateAccountQuota("pool-a", 30, 1_800_000_000_000, 20, 1_900_000_000_000);
    const config = baseConfig({
      providers: {
        openai: { adapter: "openai-responses", authMode: "forward", baseUrl: "https://chatgpt.com/backend-api/codex" },
      },
      routingProfiles: {
        only: { candidates: [{ provider: "openai", model: "gpt-5.6" }] },
      },
    });
    const req = new ManagementRequest("http://localhost/api/routing-profiles/dry-run", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        profile: "only",
        evidence: {},
        candidates: [{ provider: "openai", model: "gpt-5.6", codexAccountId: "pool-a" }],
      }),
    });
    const response = await handleManagementAPI(req, new URL(req.url), config, { refreshCodexCatalog: async () => {} });
    expect(response).not.toBeNull();
    expect(response!.status).toBe(200);
    const body = await response!.json() as { candidates?: Array<{ quota?: { known?: boolean; headroom?: number } }> };
    // The documented candidates[].codexAccountId ref derives the cached pool
    // quota (30% weekly / 20% monthly => 0.7 headroom) instead of unknown.
    expect(body.candidates?.[0]?.quota?.known).toBe(true);
    expect(body.candidates?.[0]?.quota?.headroom).toBeCloseTo(0.7, 2);
  });

  test("API dry-run leaves an unbound Codex candidate quota unknown despite an active pool account", async () => {
    updateAccountQuota("pool-a", 30, 1_800_000_000_000, 20, 1_900_000_000_000);
    const config = baseConfig({
      providers: {
        openai: { adapter: "openai-responses", authMode: "forward", baseUrl: "https://chatgpt.com/backend-api/codex" },
      },
      codexAccounts: [{ id: "pool-a", email: "pool-a@example.test", isMain: false }],
      activeCodexAccountId: "pool-a",
      routingProfiles: {
        only: { candidates: [{ provider: "openai", model: "gpt-5.6" }] },
      },
    });
    const req = new ManagementRequest("http://localhost/api/routing-profiles/dry-run", {
      method: "POST",
      headers: { "content-type": "application/json" },
      // No candidates[] override: the candidate is unbound, so the dry-run must
      // not reach for the process-global active pool account. Policy evaluation
      // runs before Pool/Direct identity and thread affinity resolve, so an
      // account attached here can differ from the one that executes.
      body: JSON.stringify({ profile: "only", evidence: {} }),
    });
    const response = await handleManagementAPI(req, new URL(req.url), config, { refreshCodexCatalog: async () => {} });
    expect(response).not.toBeNull();
    expect(response!.status).toBe(200);
    const body = await response!.json() as {
      candidates?: Array<{ accountRef?: string; quota?: { known?: boolean; headroom?: number } }>;
    };
    expect(body.candidates?.[0]?.accountRef).toBeUndefined();
    expect(body.candidates?.[0]?.quota?.known).toBe(false);
    expect(body.candidates?.[0]?.quota?.headroom).toBeUndefined();
  });

  test("API dry-run leaves an unbound Anthropic candidate quota unknown despite an active account", async () => {
    const { saveCredential, getAccountSet } = await import("../src/oauth/store");
    const { setCachedProviderAccountQuotaForTests } = await import("../src/providers/quota");
    await saveCredential("anthropic", {
      access: "access-a",
      refresh: "refresh-a",
      expires: Date.now() + 3_600_000,
      accountId: "uuid-a",
      email: "a@example.test",
    });
    const activeId = getAccountSet("anthropic")!.activeAccountId;
    setCachedProviderAccountQuotaForTests("anthropic", activeId, {
      fiveHourPercent: 40,
      updatedAt: Date.now(),
    });
    const config = baseConfig({
      providers: {
        anthropic: {
          adapter: "anthropic",
          baseUrl: "https://api.anthropic.com",
          authMode: "oauth",
          models: ["claude-sonnet-5"],
        },
      },
      routingProfiles: {
        only: { candidates: [{ provider: "anthropic", model: "claude-sonnet-5" }] },
      },
    });
    const req = new ManagementRequest("http://localhost/api/routing-profiles/dry-run", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ profile: "only", evidence: {} }),
    });
    const response = await handleManagementAPI(req, new URL(req.url), config, { refreshCodexCatalog: async () => {} });
    expect(response).not.toBeNull();
    expect(response!.status).toBe(200);
    const body = await response!.json() as {
      candidates?: Array<{ accountRef?: string; quota?: { known?: boolean; headroom?: number } }>;
    };
    expect(body.candidates?.[0]?.accountRef).toBeUndefined();
    expect(body.candidates?.[0]?.quota?.known).toBe(false);
  });
});
