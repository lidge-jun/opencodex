import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleManagementAPI } from "../src/server/management-api";
import { ManagementRequest } from "./helpers/management-auth";
import { appendUsageEntry, resetUsageReadCacheForTests, type PersistedUsageEntry } from "../src/usage/log";
import { closeRequestHistoryIndex } from "../src/routing/history/indexer";
import { candidateCapabilityEvidence } from "../src/routing/capability";
import type { OcxConfig } from "../src/types";

let testDir = "";
let previousHome: string | undefined;

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  testDir = mkdtempSync(join(tmpdir(), "ocx-explain-"));
  process.env.OPENCODEX_HOME = testDir;
  resetUsageReadCacheForTests();
  closeRequestHistoryIndex();
});

afterEach(() => {
  closeRequestHistoryIndex();
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  if (testDir) rmSync(testDir, { recursive: true, force: true });
});

function config(): OcxConfig {
  return {
    port: 10100,
    defaultProvider: "a",
    providers: {
      a: {
        adapter: "openai-chat",
        baseUrl: "https://a.example/v1",
        apiKey: "ka",
        models: ["m1"],
        modelContextWindows: { m1: 200_000 },
        parallelToolCalls: true,
      },
    },
    routingProfiles: {
      fast: { candidates: [{ provider: "a", model: "m1" }] },
    },
  };
}

function tracedEntry(requestId: string): PersistedUsageEntry {
  return {
    requestId,
    timestamp: 1_700_000_000_000,
    provider: "a",
    model: "m1",
    requestedModel: "policy/fast",
    status: 200,
    durationMs: 1234,
    usageStatus: "reported",
    routeDecision: {
      version: 1,
      decisionId: "abc123def456",
      createdAt: 1_700_000_000_000,
      requestedModel: "policy/fast",
      routeKind: "policy",
      profile: { id: "fast", revision: "0123456789abcdef" },
      requirements: [],
      candidates: [{
        provider: "a",
        model: "m1",
        eligible: true,
        exclusions: [],
        score: { total: 1, components: { configuredPriority: 1 } },
      }],
      selected: { candidateIndex: 0, provider: "a", model: "m1", reason: "policy-selected" },
    },
    attempts: [
      { ordinal: 1, provider: "a", model: "m1", adapter: "openai-chat", status: 200, durationMs: 1200, sendCount: 1, recoveryKinds: [], usageStatus: "reported" },
    ],
  };
}

async function apiGet(path: string, cfg: OcxConfig): Promise<Response> {
  const req = new ManagementRequest(`http://localhost${path}`, { method: "GET" });
  const response = await handleManagementAPI(req, new URL(req.url), cfg, { refreshCodexCatalog: async () => {} });
  expect(response).not.toBeNull();
  return response!;
}

describe("route explainability (RI-09)", () => {
  test("route-decision endpoint merges trace, attempts, and outcome", async () => {
    appendUsageEntry(tracedEntry("explain-me"));
    const response = await apiGet("/api/request-history/explain-me/route-decision", config());
    expect(response.status).toBe(200);
    const body = await response.json() as {
      requestId?: string;
      routeDecision?: { routeKind?: string; profile?: { id?: string; revision?: string } };
      attemptSequence?: Array<{ ordinal?: number }>;
      outcome?: { status?: number; durationMs?: number };
      summary?: { requestedModel?: string; routeKind?: string | null; profileId?: string; finalProvider?: string; finalModel?: string };
    };
    expect(body.requestId).toBe("explain-me");
    expect(body.routeDecision?.routeKind).toBe("policy");
    expect(body.routeDecision?.profile).toEqual({ id: "fast", revision: "0123456789abcdef" });
    expect(body.attemptSequence).toHaveLength(1);
    expect(body.attemptSequence![0]!.ordinal).toBe(1);
    expect(body.outcome).toMatchObject({ status: 200, durationMs: 1234 });
    expect(body.summary).toMatchObject({
      requestedModel: "policy/fast",
      routeKind: "policy",
      profileId: "fast",
      finalProvider: "a",
      finalModel: "m1",
    });
  });

  test("unknown request ids return 404", async () => {
    const response = await apiGet("/api/request-history/missing/route-decision", config());
    expect(response.status).toBe(404);
  });

  test("pre-trace rows explain with null routeDecision and their attempts", async () => {
    appendUsageEntry({
      requestId: "legacy-row",
      timestamp: 1_700_000_000_000,
      provider: "a",
      model: "m1",
      status: 503,
      durationMs: 50,
      usageStatus: "unreported",
      attempts: [
        { ordinal: 1, provider: "a", model: "m1", adapter: "openai-chat", status: 503, durationMs: 50, sendCount: 1, recoveryKinds: ["transient-5xx"], usageStatus: "unreported" },
      ],
    });
    const response = await apiGet("/api/request-history/legacy-row/route-decision", config());
    expect(response.status).toBe(200);
    const body = await response.json() as { routeDecision?: unknown; summary?: { routeKind?: string | null } };
    expect(body.routeDecision).toBeNull();
    expect(body.summary?.routeKind).toBeNull();
  });

  test("combo rows report the physical final attempt, not the virtual combo model", async () => {
    appendUsageEntry({
      requestId: "combo-row",
      timestamp: 1_700_000_000_000,
      provider: "combo",
      model: "fast-fallback",
      requestedModel: "combo/fast-fallback",
      status: 200,
      durationMs: 900,
      usageStatus: "reported",
      attempts: [
        { ordinal: 1, provider: "a", model: "m1", adapter: "openai-chat", status: 503, durationMs: 100, sendCount: 1, recoveryKinds: ["transient-5xx"], usageStatus: "unreported" },
        { ordinal: 2, provider: "b", model: "m2", adapter: "openai-chat", status: 200, durationMs: 800, sendCount: 1, recoveryKinds: [], usageStatus: "reported" },
      ],
    });
    const response = await apiGet("/api/request-history/combo-row/route-decision", config());
    expect(response.status).toBe(200);
    const body = await response.json() as {
      summary?: { finalProvider?: string; finalModel?: string };
      attemptSequence?: Array<{ provider?: string; model?: string }>;
    };
    expect(body.attemptSequence).toHaveLength(2);
    expect(body.summary).toMatchObject({ finalProvider: "b", finalModel: "m2" });
  });

  test("dry-run without candidate evidence assembles canonical evidence", async () => {
    const cfg = config();
    const req = new ManagementRequest("http://localhost/api/routing-profiles/dry-run", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ profile: "fast", evidence: {} }),
    });
    const response = await handleManagementAPI(req, new URL(req.url), cfg, { refreshCodexCatalog: async () => {} });
    expect(response!.status).toBe(200);
    const body = await response!.json() as {
      candidates?: Array<{ capability?: { contextWindow?: number; encryptedCodexTasks?: boolean }; health?: object; quota?: object; cost?: object }>;
    };
    expect(body.candidates?.[0]?.capability?.contextWindow).toBe(200_000);
    expect(body.candidates?.[0]?.health).toBeDefined();
    expect(body.candidates?.[0]?.quota).toBeDefined();
    expect(body.candidates?.[0]?.cost).toBeDefined();
  });

  test("malformed candidates remain invalid_candidates 400", async () => {
    const cfg = config();
    const req = new ManagementRequest("http://localhost/api/routing-profiles/dry-run", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ profile: "fast", candidates: [{ model: "m1" }] }),
    });
    const response = await handleManagementAPI(req, new URL(req.url), cfg, { refreshCodexCatalog: async () => {} });
    expect(response!.status).toBe(400);
    const body = await response!.json() as { error?: { code?: string } };
    expect(body.error?.code).toBe("invalid_candidates");
  });

  test("absent provider leaves encryptedCodexTasks unknown", () => {
    const evidence = candidateCapabilityEvidence(config(), "missing-provider", "m1");
    expect(Object.prototype.hasOwnProperty.call(evidence, "encryptedCodexTasks")).toBe(false);
  });

  test("providerContextCaps.openai ceilings native openai capability evidence (#1430)", () => {
    const evidence = candidateCapabilityEvidence({
      ...config(),
      providers: {
        openai: {
          adapter: "openai-responses",
          baseUrl: "https://chatgpt.com/backend-api/codex",
          authMode: "forward",
          codexAccountMode: "pool",
        },
      },
      providerContextCaps: { openai: 272_000 },
    }, "openai", "gpt-5.6-sol");
    expect(evidence.contextWindow).toBe(272_000);
    expect(evidence.encryptedCodexTasks).toBe(true);
  });

  test("native openai capability evidence keeps the 372k default without a cap", () => {
    const evidence = candidateCapabilityEvidence({
      ...config(),
      providers: {
        openai: {
          adapter: "openai-responses",
          baseUrl: "https://chatgpt.com/backend-api/codex",
          authMode: "forward",
          codexAccountMode: "pool",
        },
      },
    }, "openai", "gpt-5.6-sol");
    expect(evidence.contextWindow).toBe(272_000);
  });

  test("CLI logs explain encodes request ids and supports --json", async () => {
    const { handleObserveCommand } = await import("../src/cli/observe");
    const calls: Array<{ path: string; init?: RequestInit }> = [];
    const payload = {
      requestId: "id with spaces",
      summary: { finalProvider: "a", finalModel: "m1" },
    };
    const code = await handleObserveCommand(["logs", "explain", "id with spaces", "--json"], {
      baseUrl: "http://cli.test",
      fetchImpl: async (input, init) => {
        const path = String(input).replace("http://cli.test", "");
        calls.push({ path, init });
        return new Response(JSON.stringify(payload), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });
    expect(code).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.path).toBe("/api/request-history/id%20with%20spaces/route-decision");
  });

  test("CLI logs explain rejects missing request ids", async () => {
    const { handleObserveCommand } = await import("../src/cli/observe");
    const code = await handleObserveCommand(["logs", "explain"], {
      baseUrl: "http://cli.test",
      fetchImpl: async () => {
        throw new Error("should not request");
      },
    });
    expect(code).toBe(2);
  });

  test("CLI route policy evaluate posts dry-run evidence and rejects option-like ids", async () => {
    const { handleRoutePolicyCommand } = await import("../src/cli/route-policy");
    const calls: Array<{ path: string; init?: RequestInit }> = [];
    const ok = await handleRoutePolicyCommand(["evaluate", "fast", "--tools", "--json"], {
      baseUrl: "http://cli.test",
      fetchImpl: async (input, init) => {
        const path = String(input).replace("http://cli.test", "");
        calls.push({ path, init });
        return new Response(JSON.stringify({ selectedIndex: 0, candidates: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });
    expect(ok).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.path).toBe("/api/routing-profiles/dry-run");
    expect(calls[0]!.init?.method).toBe("POST");
    const body = JSON.parse(String(calls[0]!.init?.body ?? "{}")) as {
      profile?: string;
      evidence?: { toolsRequired?: boolean };
    };
    expect(body).toEqual({ profile: "fast", evidence: { toolsRequired: true } });

    const bad = await handleRoutePolicyCommand(["evaluate", "--json"], {
      baseUrl: "http://cli.test",
      fetchImpl: async () => {
        throw new Error("should not request");
      },
    });
    expect(bad).toBe(2);
  });
});
