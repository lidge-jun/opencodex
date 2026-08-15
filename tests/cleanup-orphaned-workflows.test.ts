import { describe, expect, test } from "bun:test";
import { cleanupOrphanedWorkflowRuns } from "../scripts/ci/cleanup-orphaned-workflows.mjs";

interface MockRoute {
  method?: string;
  path: string;
  status?: number;
  body?: unknown;
}

function mockFetch(routes: MockRoute[], calls: string[]) {
  return async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input : input.url);
    const method = init?.method ?? "GET";
    const key = `${method} ${url.pathname}${url.search}`;
    calls.push(key);

    const index = routes.findIndex(route =>
      (route.method ?? "GET") === method
      && route.path === `${url.pathname}${url.search}`,
    );
    if (index < 0) return new Response(`Unexpected request: ${key}`, { status: 500 });

    const [route] = routes.splice(index, 1);
    const status = route!.status ?? 200;
    if (status === 204) return new Response(null, { status });
    return Response.json(route!.body ?? {}, { status });
  };
}

function baseRoutes(extra: MockRoute[]): MockRoute[] {
  return [
    { path: "/repos/lidge-jun/opencodex", body: { default_branch: "main" } },
    {
      path: "/repos/lidge-jun/opencodex/contents/.github/workflows?ref=main",
      body: [
        { type: "file", path: ".github/workflows/ci.yml" },
        { type: "file", path: ".github/workflows/cleanup-orphaned-workflows.yml" },
      ],
    },
    ...extra,
  ];
}

describe("orphaned GitHub Actions cleanup", () => {
  test("workflow is default-branch-only, least-privilege, bounded, and pinned", async () => {
    const text = await Bun.file(
      new URL("../.github/workflows/cleanup-orphaned-workflows.yml", import.meta.url),
    ).text();
    const workflow = Bun.YAML.parse(text) as {
      on?: Record<string, unknown>;
      permissions?: Record<string, string>;
      jobs?: Record<string, {
        "timeout-minutes"?: number;
        steps?: Array<{ uses?: string; run?: string }>;
      }>;
    };

    expect(Object.keys(workflow.on ?? {}).sort()).toEqual(["push", "schedule"]);
    expect(workflow.permissions).toEqual({
      actions: "write",
      contents: "read",
    });
    expect(workflow.jobs?.cleanup?.["timeout-minutes"]).toBe(10);

    const steps = workflow.jobs?.cleanup?.steps ?? [];
    expect(steps.some(step =>
      step.uses === "actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0"
    )).toBe(true);
    expect(steps.some(step =>
      step.uses === "oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6"
    )).toBe(true);
    expect(steps.some(step =>
      step.run === "bun scripts/ci/cleanup-orphaned-workflows.mjs"
    )).toBe(true);
    expect(text).not.toContain("workflow_dispatch");
    expect(text).not.toMatch(/uses:\s+\S+@(?:v\d+|main|master)\b/);
  });

  test("deletes runs only for local workflows absent from the default branch", async () => {
    const calls: string[] = [];
    const routes = baseRoutes([
      {
        path: "/repos/lidge-jun/opencodex/actions/workflows?per_page=100&page=1",
        body: {
          workflows: [
            { id: 1, name: "CI", path: ".github/workflows/ci.yml" },
            { id: 2, name: "Temporary rebase", path: ".github/workflows/tmp-rebase.yml" },
            { id: 3, name: "Dependabot", path: "dynamic/dependabot/dependabot-updates" },
          ],
        },
      },
      {
        path: "/repos/lidge-jun/opencodex/actions/workflows/2/runs?per_page=100&page=1",
        body: { workflow_runs: [{ id: 201, status: "completed", pull_requests: [] }] },
      },
      { method: "DELETE", path: "/repos/lidge-jun/opencodex/actions/runs/201", status: 204 },
    ]);

    const result = await cleanupOrphanedWorkflowRuns({
      token: "test-token",
      repository: "lidge-jun/opencodex",
      fetchImpl: mockFetch(routes, calls) as typeof fetch,
      log: () => {},
    });

    expect(result.orphanCandidates).toBe(1);
    expect(result.deletedRuns).toBe(1);
    expect(calls.some(call => call.includes("dynamic/dependabot"))).toBe(false);
    expect(routes).toHaveLength(0);
  });

  test("preserves an orphan while a live run head branch still contains its workflow file", async () => {
    const calls: string[] = [];
    const routes = baseRoutes([
      {
        path: "/repos/lidge-jun/opencodex/actions/workflows?per_page=100&page=1",
        body: {
          workflows: [{ id: 2, name: "Temporary PR check", path: ".github/workflows/tmp-pr.yml" }],
        },
      },
      {
        path: "/repos/lidge-jun/opencodex/actions/workflows/2/runs?per_page=100&page=1",
        body: {
          workflow_runs: [{
            id: 202,
            status: "completed",
            pull_requests: [],
            head_branch: "agent/pr-77",
            head_repository: { full_name: "lidge-jun/opencodex" },
          }],
        },
      },
      {
        path: "/repos/lidge-jun/opencodex/contents/.github/workflows/tmp-pr.yml?ref=agent%2Fpr-77",
        body: { type: "file", path: ".github/workflows/tmp-pr.yml" },
      },
    ]);

    const result = await cleanupOrphanedWorkflowRuns({
      token: "test-token",
      repository: "lidge-jun/opencodex",
      fetchImpl: mockFetch(routes, calls) as typeof fetch,
      log: () => {},
    });

    expect(result.approvedWorkflows).toBe(0);
    expect(result.deletedRuns).toBe(0);
    expect(calls.some(call => call.startsWith("DELETE "))).toBe(false);
    expect(routes).toHaveLength(0);
  });

  test("cleans an orphan after its run head branch no longer contains the workflow file", async () => {
    const calls: string[] = [];
    const routes = baseRoutes([
      {
        path: "/repos/lidge-jun/opencodex/actions/workflows?per_page=100&page=1",
        body: {
          workflows: [{ id: 2, name: "Temporary PR check", path: ".github/workflows/tmp-pr.yml" }],
        },
      },
      {
        path: "/repos/lidge-jun/opencodex/actions/workflows/2/runs?per_page=100&page=1",
        body: {
          workflow_runs: [{
            id: 202,
            status: "completed",
            pull_requests: [],
            head_branch: "agent/pr-77",
            head_repository: { full_name: "lidge-jun/opencodex" },
          }],
        },
      },
      {
        path: "/repos/lidge-jun/opencodex/contents/.github/workflows/tmp-pr.yml?ref=agent%2Fpr-77",
        status: 404,
        body: { message: "Not Found" },
      },
      { method: "DELETE", path: "/repos/lidge-jun/opencodex/actions/runs/202", status: 204 },
    ]);

    const result = await cleanupOrphanedWorkflowRuns({
      token: "test-token",
      repository: "lidge-jun/opencodex",
      fetchImpl: mockFetch(routes, calls) as typeof fetch,
      log: () => {},
    });

    expect(result.approvedWorkflows).toBe(1);
    expect(result.deletedRuns).toBe(1);
    expect(routes).toHaveLength(0);
  });

  test("does not delete anything when an orphan still has a non-completed run", async () => {
    const calls: string[] = [];
    const routes = baseRoutes([
      {
        path: "/repos/lidge-jun/opencodex/actions/workflows?per_page=100&page=1",
        body: {
          workflows: [{ id: 2, name: "Temporary PR check", path: ".github/workflows/tmp-pr.yml" }],
        },
      },
      {
        path: "/repos/lidge-jun/opencodex/actions/workflows/2/runs?per_page=100&page=1",
        body: { workflow_runs: [{ id: 203, status: "in_progress", pull_requests: [] }] },
      },
    ]);

    const result = await cleanupOrphanedWorkflowRuns({
      token: "test-token",
      repository: "lidge-jun/opencodex",
      fetchImpl: mockFetch(routes, calls) as typeof fetch,
      log: () => {},
    });

    expect(result.approvedWorkflows).toBe(0);
    expect(result.deletedRuns).toBe(0);
    expect(calls.some(call => call.startsWith("DELETE "))).toBe(false);
    expect(routes).toHaveLength(0);
  });

  test("preflights every candidate before issuing the first delete", async () => {
    const calls: string[] = [];
    const routes = baseRoutes([
      {
        path: "/repos/lidge-jun/opencodex/actions/workflows?per_page=100&page=1",
        body: {
          workflows: [
            { id: 2, name: "Old temp A", path: ".github/workflows/tmp-a.yml" },
            { id: 3, name: "Old temp B", path: ".github/workflows/tmp-b.yml" },
          ],
        },
      },
      {
        path: "/repos/lidge-jun/opencodex/actions/workflows/2/runs?per_page=100&page=1",
        body: { workflow_runs: [{ id: 204, status: "completed", pull_requests: [] }] },
      },
      {
        path: "/repos/lidge-jun/opencodex/actions/workflows/3/runs?per_page=100&page=1",
        status: 503,
        body: { message: "Service Unavailable" },
      },
    ]);

    await expect(cleanupOrphanedWorkflowRuns({
      token: "test-token",
      repository: "lidge-jun/opencodex",
      fetchImpl: mockFetch(routes, calls) as typeof fetch,
      log: () => {},
    })).rejects.toThrow("HTTP 503");

    expect(calls.some(call => call.startsWith("DELETE "))).toBe(false);
  });

  test("caps deletion volume and prefers clearing smaller histories first", async () => {
    const calls: string[] = [];
    const routes = baseRoutes([
      {
        path: "/repos/lidge-jun/opencodex/actions/workflows?per_page=100&page=1",
        body: {
          workflows: [
            { id: 2, name: "Large temp", path: ".github/workflows/tmp-large.yml" },
            { id: 3, name: "Small temp", path: ".github/workflows/tmp-small.yml" },
          ],
        },
      },
      {
        path: "/repos/lidge-jun/opencodex/actions/workflows/2/runs?per_page=100&page=1",
        body: {
          workflow_runs: [
            { id: 205, status: "completed", pull_requests: [] },
            { id: 206, status: "completed", pull_requests: [] },
          ],
        },
      },
      {
        path: "/repos/lidge-jun/opencodex/actions/workflows/3/runs?per_page=100&page=1",
        body: { workflow_runs: [{ id: 207, status: "completed", pull_requests: [] }] },
      },
      { method: "DELETE", path: "/repos/lidge-jun/opencodex/actions/runs/207", status: 204 },
    ]);

    const result = await cleanupOrphanedWorkflowRuns({
      token: "test-token",
      repository: "lidge-jun/opencodex",
      fetchImpl: mockFetch(routes, calls) as typeof fetch,
      maxDeletions: 1,
      log: () => {},
    });

    expect(result.deletedRuns).toBe(1);
    expect(result.capped).toBe(true);
    expect(calls.at(-1)).toBe("DELETE /repos/lidge-jun/opencodex/actions/runs/207");
    expect(routes).toHaveLength(0);
  });
});
