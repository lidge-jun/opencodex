import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fallbackCodexAccountLogLabel } from "../src/codex/account-label";
import { handleManagementAPI } from "../src/server/management-api";
import { ManagementRequest } from "./helpers/management-auth";
import type { OcxConfig } from "../src/types";

let testDir = "";
let previousHome: string | undefined;

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  testDir = mkdtempSync(join(tmpdir(), "ocx-profile-editor-"));
  process.env.OPENCODEX_HOME = testDir;
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  if (testDir) rmSync(testDir, { recursive: true, force: true });
});

function baseConfig(): OcxConfig {
  return {
    port: 10100,
    defaultProvider: "a",
    providers: {
      a: { adapter: "openai-chat", baseUrl: "https://a.example/v1", apiKey: "ka", models: ["m1", "m2"] },
      b: { adapter: "openai-chat", baseUrl: "https://b.example/v1", apiKey: "kb", models: ["m2"] },
    },
    routingProfiles: {
      fast: {
        alias: "ocx/fast",
        candidates: [{ provider: "a", model: "m1" }],
      },
    },
  };
}

function deps(onSave: () => void = () => {}, onRefresh: () => void = () => {}) {
  return {
    saveConfigPreservingClaudeCode: () => onSave(),
    createManagementConvergeCodex: () => async () => {
      onRefresh();
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
  };
}

describe("routing profile management editor API", () => {
  test("GET exposes the configured alias for editor round-trips", async () => {
    const config = baseConfig();
    const req = new ManagementRequest("http://localhost/api/routing-profiles", { method: "GET" });
    const response = await handleManagementAPI(req, new URL(req.url), config, deps());
    expect(response?.status).toBe(200);
    const body = await response!.json() as { profiles?: Array<{ id?: string; alias?: string | null }> };
    expect(body.profiles?.[0]).toMatchObject({ id: "fast", alias: "ocx/fast" });
  });

  test("PUT creates a validated normalized profile and refreshes the catalog", async () => {
    const config = baseConfig();
    let saves = 0;
    let refreshes = 0;
    const req = new ManagementRequest("http://localhost/api/routing-profiles", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "balanced",
        mode: "create",
        profile: {
          alias: "ocx/balanced",
          candidates: [
            { provider: "a", model: "m1" },
            { provider: "b", model: "m2" },
          ],
          require: { tools: false, minContextWindow: 64000 },
          optimize: { latency: 2, health: 1, cost: 1, quota: 0 },
          limits: { maxEstimatedCostUsd: 0.25 },
          unknownEvidence: {
            capability: "exclude",
            health: "penalize",
            quota: "allow",
            cost: "penalize",
          },
        },
      }),
    });
    const response = await handleManagementAPI(
      req,
      new URL(req.url),
      config,
      deps(() => { saves += 1; }, () => { refreshes += 1; }),
    );

    expect(response?.status).toBe(200);
    const body = await response!.json() as {
      success?: boolean;
      profile?: { alias?: string | null; optimize?: Record<string, number>; revision?: string };
    };
    expect(body.success).toBe(true);
    expect(body.profile?.alias).toBe("ocx/balanced");
    expect(body.profile?.optimize).toEqual({ latency: 0.5, health: 0.25, cost: 0.25, quota: 0 });
    expect(body.profile?.revision).toMatch(/^[0-9a-f]{16}$/);
    expect(config.routingProfiles?.balanced).toMatchObject({
      alias: "ocx/balanced",
      require: { tools: false, minContextWindow: 64000 },
    });
    expect(saves).toBe(1);
    expect(refreshes).toBe(1);
  });

  test("PUT round-trips compatibility controls through management API", async () => {
    const config = baseConfig();
    const req = new ManagementRequest("http://localhost/api/routing-profiles", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "compat",
        mode: "create",
        profile: {
          candidates: [{ provider: "a", model: "m1" }],
          compatibility: {
            requiredSuites: [{ suiteId: "responses-core", evidenceLayer: "live_route_compatibility" }],
            minStatus: "VERIFIED",
            maxEvidenceAgeMs: 3_600_000,
            unknownEvidence: "penalize",
            degradedEvidence: "exclude",
          },
        },
      }),
    });
    const response = await handleManagementAPI(req, new URL(req.url), config, deps());
    expect(response?.status).toBe(200);
    const body = await response!.json() as { profile?: { compatibility?: Record<string, unknown> } };
    expect(body.profile?.compatibility).toMatchObject({
      requiredSuites: [{ suiteId: "responses-core", evidenceLayer: "live_route_compatibility" }],
      minStatus: "VERIFIED",
      maxEvidenceAgeMs: 3_600_000,
      unknownEvidence: "penalize",
      degradedEvidence: "exclude",
    });
    expect(config.routingProfiles?.compat?.compatibility).toMatchObject({
      minStatus: "VERIFIED",
    });
  });

  test("GET /api/lab/catalog remains read-only after routing profile writes", async () => {
    const config = baseConfig();
    const putReq = new ManagementRequest("http://localhost/api/routing-profiles", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "compat-readonly",
        mode: "create",
        profile: {
          candidates: [{ provider: "a", model: "m1" }],
          compatibility: {
            requiredSuites: [{ suiteId: "responses-core", evidenceLayer: "protocol_conformance" }],
            minStatus: "PROBED",
          },
        },
      }),
    });
    const putRes = await handleManagementAPI(putReq, new URL(putReq.url), config, deps());
    expect(putRes?.status).toBe(200);

    const catalogReq = new ManagementRequest("http://localhost/api/lab/catalog", { method: "GET" });
    const catalogRes = await handleManagementAPI(catalogReq, new URL(catalogReq.url), config, deps());
    expect(catalogRes?.status).toBe(200);
    const catalogBody = await catalogRes!.json() as { scenarios?: unknown[] };
    expect(Array.isArray(catalogBody.scenarios)).toBe(true);
  });

  test("PUT rejects invalid candidates without mutating or persisting", async () => {
    const config = baseConfig();
    let saves = 0;
    const req = new ManagementRequest("http://localhost/api/routing-profiles", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "broken",
        mode: "create",
        profile: { candidates: [{ provider: "missing", model: "m1" }] },
      }),
    });
    const response = await handleManagementAPI(
      req,
      new URL(req.url),
      config,
      deps(() => { saves += 1; }),
    );

    expect(response?.status).toBe(400);
    const body = await response!.json() as { error?: { code?: string; issues?: unknown[] } };
    expect(body.error?.code).toBe("invalid_profile");
    expect(body.error?.issues?.length).toBeGreaterThan(0);
    expect(config.routingProfiles).not.toHaveProperty("broken");
    expect(saves).toBe(0);
  });

  test("PUT create rejects an account-selector namespace without side effects or private ids", async () => {
    const config = baseConfig();
    const privateAccountId = "private-stored-account-id";
    const privateEmail = "private-account@example.test";
    config.codexAccounts = [{ id: privateAccountId, email: privateEmail, isMain: false }];
    config.codexAccountNamespaces = { side: privateAccountId };
    const before = structuredClone(config);
    const profiles = config.routingProfiles;
    let saves = 0;
    let refreshes = 0;
    const req = new ManagementRequest("http://localhost/api/routing-profiles", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "colliding",
        mode: "create",
        profile: {
          alias: "side/gpt-5.5",
          candidates: [{ provider: "a", model: "m1" }],
        },
      }),
    });
    const response = await handleManagementAPI(
      req,
      new URL(req.url),
      config,
      deps(() => { saves += 1; }, () => { refreshes += 1; }),
    );

    expect(response?.status).toBe(400);
    const body = await response!.json();
    expect(body).toMatchObject({
      error: {
        code: "invalid_profile",
        message: expect.stringContaining("codex account namespace"),
      },
    });
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain(privateAccountId);
    expect(serialized).not.toContain(privateEmail);
    expect(serialized).not.toContain(fallbackCodexAccountLogLabel(privateAccountId));
    expect(config).toEqual(before);
    expect(config.routingProfiles).toBe(profiles);
    expect(saves).toBe(0);
    expect(refreshes).toBe(0);
  });

  test("PUT create refuses to overwrite an existing profile", async () => {
    const config = baseConfig();
    let saves = 0;
    const req = new ManagementRequest("http://localhost/api/routing-profiles", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "fast",
        mode: "create",
        profile: { candidates: [{ provider: "a", model: "m2" }] },
      }),
    });
    const response = await handleManagementAPI(
      req,
      new URL(req.url),
      config,
      deps(() => { saves += 1; }),
    );

    expect(response?.status).toBe(409);
    expect(await response!.json()).toMatchObject({ error: { code: "profile_exists" } });
    expect(config.routingProfiles?.fast?.candidates).toEqual([{ provider: "a", model: "m1" }]);
    expect(saves).toBe(0);
  });

  test("PUT update replaces an existing profile, persists once, and refreshes the catalog", async () => {
    const config = baseConfig();
    let saves = 0;
    let refreshes = 0;
    const req = new ManagementRequest("http://localhost/api/routing-profiles", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "fast",
        mode: "update",
        profile: {
          alias: "ocx/faster",
          candidates: [
            { provider: "a", model: "m1" },
            { provider: "b", model: "m2" },
          ],
          require: { tools: true, minContextWindow: 64000 },
          optimize: { latency: 2, health: 1, cost: 1, quota: 0 },
        },
      }),
    });
    const response = await handleManagementAPI(
      req,
      new URL(req.url),
      config,
      deps(() => { saves += 1; }, () => { refreshes += 1; }),
    );

    expect(response?.status).toBe(200);
    const body = await response!.json() as {
      success?: boolean;
      profile?: { alias?: string | null; candidates?: unknown[]; revision?: string };
    };
    expect(body.success).toBe(true);
    expect(body.profile?.alias).toBe("ocx/faster");
    expect(body.profile?.candidates).toEqual([
      { provider: "a", model: "m1" },
      { provider: "b", model: "m2" },
    ]);
    expect(body.profile?.revision).toMatch(/^[0-9a-f]{16}$/);
    expect(config.routingProfiles?.fast).toMatchObject({
      alias: "ocx/faster",
      candidates: [
        { provider: "a", model: "m1" },
        { provider: "b", model: "m2" },
      ],
      require: { tools: true, minContextWindow: 64000 },
    });
    expect(saves).toBe(1);
    expect(refreshes).toBe(1);
  });

  test("PUT update rejects a stale expectedRevision with 409 and does not persist", async () => {
    const config = baseConfig();
    let saves = 0;
    const current = await (async () => {
      const req = new ManagementRequest("http://localhost/api/routing-profiles", { method: "GET" });
      const res = await handleManagementAPI(req, new URL(req.url), config, deps());
      const body = await res!.json() as { profiles?: Array<{ id: string; revision: string }> };
      return body.profiles!.find(p => p.id === "fast")!;
    })();

    const req = new ManagementRequest("http://localhost/api/routing-profiles", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "fast",
        mode: "update",
        expectedRevision: "definitely-stale-revision",
        profile: { candidates: [{ provider: "a", model: "m2" }] },
      }),
    });
    const response = await handleManagementAPI(
      req,
      new URL(req.url),
      config,
      deps(() => { saves += 1; }),
    );

    expect(response?.status).toBe(409);
    expect(await response!.json()).toMatchObject({ error: { code: "profile_revision_conflict" } });
    expect(config.routingProfiles?.fast?.candidates).toEqual([{ provider: "a", model: "m1" }]);
    expect(saves).toBe(0);
    expect(current.revision).toMatch(/^[0-9a-f]{16}$/);
  });

  test("PUT update migrates config references when the profile alias changes", async () => {
    const config = baseConfig();
    config.disabledModels = ["ocx/fast"];
    config.subagentModels = ["ocx/fast", "a/m1"];
    config.subagentModelFallback = ["ocx/fast", "a/m1"];
    config.injectionModel = "ocx/fast";
    config.shadowCallIntercept = { model: "ocx/fast" };
    config.claudeCode = {
      enabled: true,
      model: "ocx/fast",
      smallFastModel: "a/m1",
      modelMap: { "ocx/fast": "a/m1", "a/m2": "ocx/fast" },
    };
    let saves = 0;
    const req = new ManagementRequest("http://localhost/api/routing-profiles", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "fast",
        mode: "update",
        expectedRevision: (await (async () => {
          const getReq = new ManagementRequest("http://localhost/api/routing-profiles", { method: "GET" });
          const getRes = await handleManagementAPI(getReq, new URL(getReq.url), config, deps());
          const getBody = await getRes!.json() as { profiles?: Array<{ revision: string }> };
          return getBody.profiles![0]!.revision;
        })()),
        profile: {
          alias: "ocx/faster",
          candidates: [{ provider: "a", model: "m1" }],
        },
      }),
    });
    const response = await handleManagementAPI(
      req,
      new URL(req.url),
      config,
      deps(() => { saves += 1; }),
    );

    expect(response?.status).toBe(200);
    expect(config.disabledModels).toEqual(["ocx/faster"]);
    expect(config.subagentModels).toEqual(["ocx/faster", "a/m1"]);
    expect(config.subagentModelFallback).toEqual(["ocx/faster", "a/m1"]);
    expect(config.injectionModel).toBe("ocx/faster");
    expect(config.shadowCallIntercept?.model).toBe("ocx/faster");
    expect(config.claudeCode?.model).toBe("ocx/faster");
    expect(config.claudeCode?.smallFastModel).toBe("a/m1");
    expect(config.claudeCode?.modelMap).toEqual({ "ocx/faster": "a/m1", "a/m2": "ocx/faster" });
    expect(saves).toBe(1);
  });

  test("PUT update rejects an account-selector namespace before reference migration", async () => {
    const config = baseConfig();
    const privateAccountId = "private-stored-account-id";
    const privateEmail = "private-account@example.test";
    config.codexAccounts = [{ id: privateAccountId, email: privateEmail, isMain: false }];
    config.codexAccountNamespaces = { side: privateAccountId };
    const disabledModels = ["ocx/fast"];
    const subagentModels = ["ocx/fast", "a/m1"];
    config.disabledModels = disabledModels;
    config.subagentModels = subagentModels;
    config.injectionModel = "ocx/fast";
    const before = structuredClone(config);
    const profiles = config.routingProfiles;
    const fastProfile = config.routingProfiles!.fast;
    let saves = 0;
    let refreshes = 0;
    const req = new ManagementRequest("http://localhost/api/routing-profiles", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "fast",
        mode: "update",
        profile: {
          alias: "side/gpt-5.5",
          candidates: [{ provider: "a", model: "m1" }],
        },
      }),
    });
    const response = await handleManagementAPI(
      req,
      new URL(req.url),
      config,
      deps(() => { saves += 1; }, () => { refreshes += 1; }),
    );

    expect(response?.status).toBe(400);
    const body = await response!.json();
    expect(body).toMatchObject({
      error: {
        code: "invalid_profile",
        message: expect.stringContaining("codex account namespace"),
      },
    });
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain(privateAccountId);
    expect(serialized).not.toContain(privateEmail);
    expect(serialized).not.toContain(fallbackCodexAccountLogLabel(privateAccountId));
    expect(config).toEqual(before);
    expect(config.routingProfiles).toBe(profiles);
    expect(config.routingProfiles!.fast).toBe(fastProfile);
    expect(config.disabledModels).toBe(disabledModels);
    expect(config.subagentModels).toBe(subagentModels);
    expect(saves).toBe(0);
    expect(refreshes).toBe(0);
  });

  test("PUT update rejects a modelMap key collision instead of silently dropping a mapping", async () => {
    const config = baseConfig();
    config.claudeCode = {
      enabled: true,
      modelMap: {
        "ocx/fast": "a/m1",
        "ocx/faster": "a/m2",
      },
    };
    let saves = 0;
    const req = new ManagementRequest("http://localhost/api/routing-profiles", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "fast",
        mode: "update",
        expectedRevision: (await (async () => {
          const getReq = new ManagementRequest("http://localhost/api/routing-profiles", { method: "GET" });
          const getRes = await handleManagementAPI(getReq, new URL(getReq.url), config, deps());
          const getBody = await getRes!.json() as { profiles?: Array<{ revision: string }> };
          return getBody.profiles![0]!.revision;
        })()),
        profile: {
          alias: "ocx/faster",
          candidates: [{ provider: "a", model: "m1" }],
        },
      }),
    });
    const response = await handleManagementAPI(
      req,
      new URL(req.url),
      config,
      deps(() => { saves += 1; }),
    );

    expect(response?.status).toBe(409);
    expect(await response!.json()).toMatchObject({ error: { code: "alias_reference_conflict" } });
    expect(config.routingProfiles?.fast).toMatchObject({ alias: "ocx/fast" });
    expect(config.claudeCode?.modelMap).toEqual({ "ocx/fast": "a/m1", "ocx/faster": "a/m2" });
    expect(saves).toBe(0);
  });

  test("DELETE removes a profile, persists, and refreshes the catalog", async () => {
    const config = baseConfig();
    let saves = 0;
    let refreshes = 0;
    const req = new ManagementRequest("http://localhost/api/routing-profiles?id=fast", { method: "DELETE" });
    const response = await handleManagementAPI(
      req,
      new URL(req.url),
      config,
      deps(() => { saves += 1; }, () => { refreshes += 1; }),
    );

    expect(response?.status).toBe(200);
    expect(await response!.json()).toMatchObject({ success: true, id: "fast" });
    expect(config.routingProfiles).toBeUndefined();
    expect(saves).toBe(1);
    expect(refreshes).toBe(1);
  });
});
