import { beforeEach, describe, expect, test } from "bun:test";
import { handleManagementAPI } from "../../src/server/management-api";
import { ManagementRequest as Request } from "../helpers/management-auth";
import type { OcxConfig } from "../../src/types";
import {
  admitWorkflowTurn,
  chargeWorkflowSends,
  resetWorkflowBudgetsForTest,
} from "../../src/lib/workflow-budget";

const config = { providers: [] } as unknown as OcxConfig;

beforeEach(() => {
  resetWorkflowBudgetsForTest();
});

async function call(path: string, init?: RequestInit): Promise<Response> {
  const url = new URL("http://localhost" + path);
  const response = await handleManagementAPI(new Request(url, init), url, config);
  if (!response) throw new Error("management API did not handle " + (init?.method ?? "GET") + " " + path);
  return response;
}

function seedChargedRoot(rootId: string, sends = 3): void {
  const decision = admitWorkflowTurn(rootId, "interactive");
  if (decision?.admitted !== true) throw new Error("failed to admit " + rootId);
  chargeWorkflowSends(rootId, sends);
}

describe("GET /api/workflow-budget", () => {
  test("?root= returns the snapshot for a root that was admitted and charged", async () => {
    seedChargedRoot("root-a", 3);

    const response = await call("/api/workflow-budget?root=root-a");
    expect(response.status).toBe(200);
    const body = await response.json() as {
      root: { rootId: string; sends: number } | null;
      events: unknown[];
    };
    expect(body.root).not.toBeNull();
    expect(body.root?.rootId).toBe("root-a");
    expect(body.root?.sends).toBe(3);
    expect(Array.isArray(body.events)).toBe(true);
  });

  test("an unknown root returns root: null rather than 404", async () => {
    const response = await call("/api/workflow-budget?root=never-seen");
    expect(response.status).toBe(200);
    const body = await response.json() as { root: unknown; events: unknown[] };
    expect(body.root).toBeNull();
    expect(body.events).toEqual([]);
  });
});

describe("POST /api/workflow-budget/clear", () => {
  test("a tracked root returns cleared: true and the before-snapshot, and a following GET shows sends at 0", async () => {
    seedChargedRoot("root-a", 4);

    const cleared = await call("/api/workflow-budget/clear", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ root: "root-a" }),
    });
    expect(cleared.status).toBe(200);
    const payload = await cleared.json() as {
      cleared: boolean;
      root: string;
      before: { sends: number };
    };
    expect(payload.cleared).toBe(true);
    expect(payload.root).toBe("root-a");
    expect(payload.before.sends).toBe(4);

    const after = await call("/api/workflow-budget?root=root-a");
    expect(after.status).toBe(200);
    const body = await after.json() as { root: { sends: number } | null };
    expect(body.root?.sends).toBe(0);
  });

  test("an untracked root is 404 unknown_root", async () => {
    const response = await call("/api/workflow-budget/clear", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ root: "never-seen" }),
    });
    expect(response.status).toBe(404);
    const body = await response.json() as { error: { code: string } };
    expect(body.error.code).toBe("unknown_root");
  });

  test("a missing or blank root is 400 invalid_root", async () => {
    const missing = await call("/api/workflow-budget/clear", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(missing.status).toBe(400);
    expect((await missing.json() as { error: { code: string } }).error.code).toBe("invalid_root");

    const blank = await call("/api/workflow-budget/clear", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ root: "   " }),
    });
    expect(blank.status).toBe(400);
    expect((await blank.json() as { error: { code: string } }).error.code).toBe("invalid_root");
  });
});
