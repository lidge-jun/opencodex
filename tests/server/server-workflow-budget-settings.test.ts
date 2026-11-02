import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { getDefaultConfig } from "../../src/config";
import { ConfigWritePublishedError } from "../../src/config/persist-unlocked";
import { configRebaseDeletionKeys } from "../../src/config/rebase-provenance";
import { handleManagementAPI } from "../../src/server/management-api";
import { handleWorkflowBudgetRoutes } from "../../src/server/management/workflow-budget-routes";
import type { ManagementContext } from "../../src/server/management/context";
import { admitHttpWorkflowTurn } from "../../src/server/workflow-refusal";
import { bindWorkflowBudgetConfig, currentWorkflowBudgetPolicy } from "../../src/lib/workflow-budget-config";
import {
  admitWorkflowTurn,
  chargeWorkflowSends,
  resetWorkflowBudgetsForTest,
  workflowSendCeilingReached,
  type WorkflowAdmission,
} from "../../src/lib/workflow-budget";
import type { OcxConfig } from "../../src/types";
import { ManagementRequest } from "../helpers/management-auth";

const defaults = { maxConcurrentChildren: 8, maxPhysicalSends: 256, maxDistinctChildren: 64 };
const PATH = "/api/workflow-budget/settings";

function harness(saveError?: Error) {
  const config = getDefaultConfig();
  const saved: OcxConfig[] = [];
  async function call(method: string, body?: unknown, rawBody?: string, pathname = PATH) {
    const url = new URL("http://localhost" + pathname);
    return handleWorkflowBudgetRoutes({
      url, req: new Request(url, { method, ...(method === "GET" ? {} : {
        headers: { "content-type": "application/json" }, body: rawBody ?? JSON.stringify(body),
      }) }),
      config, version: "test", deps: { saveConfigPreservingClaudeCode: (candidate: OcxConfig) => {
        saved.push(structuredClone(candidate));
        if (saveError) throw saveError;
      } },
    } as unknown as ManagementContext);
  }
  return { config, saved, call };
}

function workerHeaders(child: string): Headers {
  return new Headers({ "x-codex-parent-thread-id": "root-live", "thread-id": child });
}

beforeEach(() => { resetWorkflowBudgetsForTest(); });
afterEach(() => { bindWorkflowBudgetConfig(null); resetWorkflowBudgetsForTest(); });

describe("workflow budget settings route", () => {
  test("management dispatch serves the effective ceilings with defaults, bounds and the fixed window", async () => {
    const config = getDefaultConfig();
    const url = new URL("http://127.0.0.1:10100" + PATH);
    const response = await handleManagementAPI(new ManagementRequest(url), url, config, {});
    expect(response?.status).toBe(200);
    expect(await response!.json()).toEqual({
      ...defaults, interactiveReserve: 1, windowMs: 600_000, defaults,
      bounds: {
        maxConcurrentChildren: { min: 2, max: 64 },
        maxPhysicalSends: { min: 1, max: 10_000 },
        maxDistinctChildren: { min: 1, max: 1_024 },
      },
    });
  });

  test("PUT preserves omitted ceilings, persists the block and null restores the defaults", async () => {
    const h = harness();
    const original = structuredClone(h.config);
    expect((await h.call("PUT", { maxConcurrentChildren: 16 }))?.status).toBe(200);
    const second = await (await h.call("PUT", { maxPhysicalSends: 1_024 }))!.json() as Record<string, unknown>;
    expect(second).toMatchObject({ maxConcurrentChildren: 16, maxPhysicalSends: 1_024, maxDistinctChildren: 64 });
    expect(h.config.workflowBudget).toEqual({ maxConcurrentChildren: 16, maxPhysicalSends: 1_024 });
    const { workflowBudget: _budget, ...rest } = h.config;
    expect(rest).toEqual(original);
    const reset = await (await h.call("PUT", null))!.json() as Record<string, unknown>;
    expect(reset).toMatchObject(defaults);
    expect(h.config.workflowBudget).toBeUndefined();
    expect(configRebaseDeletionKeys(h.config).has("workflowBudget")).toBe(true);
    expect(h.saved).toHaveLength(3);
  });

  test("out-of-range, unknown and malformed bodies are refused before mutation or save", async () => {
    const h = harness();
    h.config.workflowBudget = { maxConcurrentChildren: 12 };
    const original = structuredClone(h.config);
    for (const body of [[], true, { maxConcurrentChildren: 1 }, { maxPhysicalSends: 10_001 },
      { maxDistinctChildren: 3.5 }, { windowMs: 1 }, { maxConcurrentChildren: "12" }]) {
      expect((await h.call("PUT", body))?.status).toBe(400);
    }
    expect((await h.call("PUT", undefined, "{"))?.status).toBe(400);
    expect(h.config).toEqual(original);
    expect(h.saved).toHaveLength(0);
  });

  test("a failed save restores the previous block; a published write keeps the new one", async () => {
    const failed = harness(new Error("fixture-save-failed"));
    const previous = { maxConcurrentChildren: 12 };
    failed.config.workflowBudget = previous;
    await expect(failed.call("PUT", { maxConcurrentChildren: 20 })).rejects.toThrow("fixture-save-failed");
    expect(failed.config.workflowBudget).toBe(previous);
    await expect(failed.call("PUT", null)).rejects.toThrow("fixture-save-failed");
    expect(failed.config.workflowBudget).toBe(previous);
    expect(configRebaseDeletionKeys(failed.config).has("workflowBudget")).toBe(false);
    const published = harness(new ConfigWritePublishedError(new Error("fixture-bookkeeping-failed")));
    await expect(published.call("PUT", { maxConcurrentChildren: 20 })).rejects.toBeInstanceOf(ConfigWritePublishedError);
    expect(published.config.workflowBudget).toEqual({ maxConcurrentChildren: 20 });
  });

  test("unsupported methods fall through", async () => {
    const h = harness();
    expect(await h.call("POST", {})).toBeNull();
    expect(h.saved).toHaveLength(0);
  });
});

describe("live workflow budget policy", () => {
  test("a dashboard write raises the worker concurrency ceiling on the next admission", async () => {
    const h = harness();
    bindWorkflowBudgetConfig(h.config);
    const leases: WorkflowAdmission[] = [];
    const admitWorker = (index: number) => {
      const decision = admitHttpWorkflowTurn(workerHeaders("child-" + index));
      if (decision?.admitted) leases.push(decision.lease);
      return decision;
    };
    // Default: eight slots, one held for the interactive turn, so the eighth worker is refused.
    for (let index = 0; index < 7; index += 1) expect(admitWorker(index)?.admitted).toBe(true);
    expect(admitWorker(7)).toMatchObject({ admitted: false, reason: "workflow-concurrency-exhausted" });
    expect((await h.call("PUT", { maxConcurrentChildren: 10 }))?.status).toBe(200);
    expect(admitWorker(7)?.admitted).toBe(true);
    expect(admitWorker(8)?.admitted).toBe(true);
    expect(admitWorker(9)).toMatchObject({ admitted: false, reason: "workflow-concurrency-exhausted" });
    for (const lease of leases) lease.release();
  });

  test("the send and child ceilings follow the bound config and fall back after a reset", async () => {
    const h = harness();
    bindWorkflowBudgetConfig(h.config);
    expect((await h.call("PUT", { maxPhysicalSends: 3, maxDistinctChildren: 2 }))?.status).toBe(200);
    const policy = currentWorkflowBudgetPolicy();
    for (const child of ["a", "b"]) {
      const decision = admitWorkflowTurn("root-sends", "worker", policy, child);
      expect(decision?.admitted).toBe(true);
      if (decision?.admitted) decision.lease.release();
    }
    expect(admitWorkflowTurn("root-sends", "worker", policy, "c")).toMatchObject({ admitted: false, reason: "workflow-children-exhausted" });
    chargeWorkflowSends("root-sends", 3);
    expect(workflowSendCeilingReached("root-sends", currentWorkflowBudgetPolicy())).toBe(true);
    expect((await h.call("PUT", null))?.status).toBe(200);
    expect(workflowSendCeilingReached("root-sends", currentWorkflowBudgetPolicy())).toBe(false);
  });
});
