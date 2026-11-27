import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { fetchOpenDesignAccountQuota } from "../../src/providers/quota/opendesign-account";
import { TERMINAL_QUOTA_FAILURE } from "../../src/providers/quota/report-cache";
import { listOpenDesignWorkspaces } from "../../src/oauth/opendesign";

const CONTROL_API = "https://amr-api.open-design.ai";
const WORKSPACES_URL = `${CONTROL_API}/api/v1/workspaces`;
const CONTROL_KEY = "vela_ctrl_synthetic0123456789abcdef";
const originalFetch = globalThis.fetch;

beforeEach(() => {
  globalThis.fetch = originalFetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function workspacesResponse(): Response {
  return Response.json({
    items: [
      { workspaceId: "ws-design-team", workspaceName: "Design Team", workspaceMemberId: "member-0123456789", role: "owner", memberStatus: "active", lifecycleState: "active", workspaceType: "team" },
      { workspaceId: "ws-iteractive", workspaceName: "Iteractive Development", workspaceMemberId: "member-0123456789", role: "owner", memberStatus: "active", lifecycleState: "active", workspaceType: "team" },
    ],
  });
}

function preflightResponse(overrides: Record<string, unknown> = {}): Response {
  return Response.json({
    preflight: {
      schemaVersion: 1,
      workspaceId: "ws-design-team",
      workspaceMemberId: "member-0123456789",
      modelId: null,
      generatedAt: "2026-11-27T13:00:00.000Z",
      balanceUsd: "12.50",
      modelCovered: null,
      funding: "coding_plan",
      codingPlan: {
        workspaceId: "ws-design-team",
        generatedAt: "2026-11-27T13:00:00.000Z",
        eligible: true,
        tier: "go",
        windows: [
          {
            policyId: "policy-5h",
            durationSeconds: 18000,
            resetMode: "anchored_recurring",
            usedCredits: "45",
            limitCredits: "500",
            remainingCredits: "455",
            windowStart: "2026-11-27T10:00:00.000Z",
            resetsAt: "2026-11-27T15:00:00.000Z",
          },
          {
            policyId: "policy-7d",
            durationSeconds: 604800,
            resetMode: "anchored_recurring",
            usedCredits: "45",
            limitCredits: "2000",
            remainingCredits: "1955",
            windowStart: "2026-11-23T10:00:00.000Z",
            resetsAt: "2026-11-30T10:00:00.000Z",
          },
        ],
      },
      ...overrides,
    },
  });
}

/** Fixture fetch: no network, every URL recorded. */
function fixtureFetch(routes: Array<{ match: (url: string) => boolean; respond: (url: string) => Response }>): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input);
    const route = routes.find(route => route.match(url));
    if (!route) return new Response(null, { status: 404 });
    return route.respond(url);
  }) as typeof fetch;
}

const routes = (respond: (url: string) => Response): Array<{ match: (url: string) => boolean; respond: (url: string) => Response }> => [
  { match: url => url === WORKSPACES_URL, respond: () => workspacesResponse() },
  { match: url => url.endsWith("/billing/preflight"), respond },
];

const passthrough = (url: string): Response => preflightResponse();

function passthroughWithWorkspace() {
  return fixtureFetch(routes(passthrough));
}

describe("fetchOpenDesignAccountQuota", () => {
  test("aggregates every workspace's coding-plan windows into one report", async () => {
    const fetchImpl = passthroughWithWorkspace();
    const result = await fetchOpenDesignAccountQuota("opendesign", CONTROL_KEY, { fetchImpl });
    expect(result).not.toBeNull();
    expect(typeof result).not.toBe("symbol");
    if (!result || typeof result === "symbol") return;
    expect(result.provider).toBe("opendesign");
    expect(result.label).toBe("Open Design");
    expect(result.source).toBe("Open Design coding plan");
    expect(result.reverseEngineered).toBe(true);
    expect(result.quota.customWindows).toHaveLength(4); // 2 workspaces × 2 windows
    const fiveHour = result.quota.customWindows!.find(w => w.label.startsWith("5-hour"))!;
    expect(fiveHour).toBeDefined();
    expect(fiveHour.percent).toBe(9); // 45/500
    expect(fiveHour.resetAt).toBe(Date.parse("2026-11-27T15:00:00.000Z"));
    // Anchored: reset is the reported anchor, never now-plus-duration.
    expect(fiveHour.resetAt).toBeLessThan(Date.now());
  });

  test("windows are labeled per workspace so rows stay distinguishable", async () => {
    const fetchImpl = passthroughWithWorkspace();
    const result = await fetchOpenDesignAccountQuota("opendesign", CONTROL_KEY, { fetchImpl });
    if (!result || typeof result === "symbol") throw new Error("expected a report");
    for (const window of result.quota.customWindows!) {
      expect(window.label).toMatch(/^5-hour|weekly/);
      expect(window.label).toContain("ws-");
    }
  });

  test("a workspace that answers 403 is skipped; the account still reports", async () => {
    const fetchImpl = fixtureFetch(routes((url: string) =>
      url.includes("ws-iteractive") ? new Response(null, { status: 403 }) : passthrough(url)));
    const result = await fetchOpenDesignAccountQuota("opendesign", CONTROL_KEY, { fetchImpl });
    if (!result || typeof result === "symbol") throw new Error("expected a report");
    expect(result.quota.customWindows).toHaveLength(2);
    for (const window of result.quota.customWindows!) {
      expect(window.label).toContain("ws-design-team");
    }
  });

  test("transport failure degrades to null, never an exception", async () => {
    const throwingFetch = (async () => { throw new Error("synthetic transport failure"); }) as typeof fetch;
    const result = await fetchOpenDesignAccountQuota("opendesign", CONTROL_KEY, { fetchImpl: throwingFetch });
    expect(result).toBeNull();
  });

  test("malformed preflight windows are dropped, not fatal", async () => {
    const fetchImpl = fixtureFetch(routes(() => Response.json({ preflight: { codingPlan: { windows: [
      { policyId: "x", durationSeconds: "18000", usedCredits: "45", limitCredits: "500", resetsAt: "2026-11-27T15:00:00.000Z" },
      { policyId: "y", durationSeconds: 604800, usedCredits: "nan", limitCredits: "2000", resetsAt: "2026-11-30T10:00:00.000Z" },
    ] } } })));
    const result = await fetchOpenDesignAccountQuota("opendesign", CONTROL_KEY, { fetchImpl });
    expect(result).toBeNull(); // every window failed validation → no evidence
  });

  test("a non-string control key is not probed", async () => {
    const fetchImpl = passthroughWithWorkspace();
    const result = await fetchOpenDesignAccountQuota("opendesign", "sk-amr-not-a-control-key", { fetchImpl });
    expect(result).toBeNull();
  });

  test("an empty workspace list is no evidence, not a failure", async () => {
    const fetchImpl = fixtureFetch([{ match: url => url === WORKSPACES_URL, respond: () => Response.json({ items: [] }) }]);
    const result = await fetchOpenDesignAccountQuota("opendesign", CONTROL_KEY, { fetchImpl });
    expect(result).toBeNull();
  });

  test("a 401 workspace directory is a terminal credential failure", async () => {
    const fetchImpl = fixtureFetch([{ match: url => url === WORKSPACES_URL, respond: () => new Response(null, { status: 401 }) }]);
    const result = await fetchOpenDesignAccountQuota("opendesign", CONTROL_KEY, { fetchImpl });
    expect(result).toBe(TERMINAL_QUOTA_FAILURE);
  });
});

describe("listOpenDesignWorkspaces (probe entry read)", () => {
  test("the workspace list read is what the probe consumes", async () => {
    const fetchImpl = passthroughWithWorkspace();
    const workspaces = await listOpenDesignWorkspaces(CONTROL_KEY, { fetchImpl });
    expect(workspaces).toHaveLength(2);
    expect(workspaces[0]!.workspaceId).toBe("ws-design-team");
  });
});
