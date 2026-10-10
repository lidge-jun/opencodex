import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ManagementRequest as Request } from "../helpers/management-auth";
import { handleManagementAPI } from "../../src/server/management-api";
import { ConfigWritePublishedError } from "../../src/config/persist-unlocked";
import { catalogConvergenceFactory } from "../helpers/catalog-convergence";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import type { OcxConfig } from "../../src/types";

/**
 * The Models settings panel needs a settable reviewer without hand-editing config.json. The
 * endpoint writes the global block, degrades nothing, and rejects a malformed selector before it
 * can reach the catalog stamper.
 */
function config(): OcxConfig {
  return { port: 10100, defaultProvider: "openai", providers: {} };
}

let home: string | undefined;
let previousHome: string | undefined;

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  home = mkdtempSync(join(tmpdir(), "ocx-auto-review-settings-"));
  process.env.OPENCODEX_HOME = home;
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  if (home) { removeTreeWithRetry(home); home = undefined; }
});

async function manage(
  target: OcxConfig,
  method: string,
  body?: unknown,
  converge: ReturnType<typeof catalogConvergenceFactory> = catalogConvergenceFactory(),
  save?: (config: OcxConfig) => void,
): Promise<Response> {
  // The management API enforces a same-origin gate; a browserless caller must look local.
  const headers: Record<string, string> = { origin: "http://127.0.0.1:10100", host: "127.0.0.1:10100" };
  if (body !== undefined) headers["content-type"] = "application/json";
  const req = new Request("http://localhost/api/auto-review-settings", {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const res = await handleManagementAPI(req, new URL(req.url), target, {
    createManagementConvergeCodex: converge,
    ...(save ? { saveConfigPreservingClaudeCode: save } : {}),
  });
  expect(res).not.toBeNull();
  return res!;
}

describe("auto-review-settings API", () => {
  test("GET defaults to disabled with no model", async () => {
    const res = await manage(config(), "GET");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ enabled: false, model: "" });
  });

  test("GET after a base change reports only the second server's settings", async () => {
    const first = config();
    const second = config();
    first.autoReviewOverride = { enabled: true, model: "server-a/model" };
    second.autoReviewOverride = { enabled: false, model: "server-b/model" };
    expect(await (await manage(first, "GET")).json()).toEqual({ enabled: true, model: "server-a/model" });
    expect(await (await manage(second, "GET")).json()).toEqual({ enabled: false, model: "server-b/model" });
  });

  test("GET normalizes a whitespace-only model as an empty selector", async () => {
    const target = config();
    target.autoReviewOverride = { enabled: true, model: "   " };
    expect(await (await manage(target, "GET")).json()).toEqual({ enabled: true, model: "" });
  });

  test("PUT persists the enabled selector and echoes it", async () => {
    const target = config();
    const res = await manage(target, "PUT", { enabled: true, model: " 9router/ocg-muse-spark-1.3-contributor " });
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; enabled: boolean; model: string; catalogRefresh: { status: string } };
    expect([body.ok, body.enabled, body.model]).toEqual([true, true, "9router/ocg-muse-spark-1.3-contributor"]);
    // The reviewer stamps live in the catalog, so the write converges it and reports the
    // disposition instead of claiming an update the catalog never adopted.
    expect(body.catalogRefresh.status).toBe("committed");
    expect(target.autoReviewOverride).toEqual({ enabled: true, model: "9router/ocg-muse-spark-1.3-contributor" });
    const persisted = JSON.parse(readFileSync(join(home!, "config.json"), "utf8")) as OcxConfig;
    expect(persisted.autoReviewOverride).toEqual({ enabled: true, model: "9router/ocg-muse-spark-1.3-contributor" });
  });

  test("PUT with a blank or whitespace-only model clears it while keeping the flag", async () => {
    const target = config();
    await manage(target, "PUT", { enabled: true, model: "9router/ocg-muse-spark-1.3-contributor" });
    expect((await manage(target, "PUT", { model: "" })).status).toBe(200);
    expect(target.autoReviewOverride).toEqual({ enabled: true });
    // Whitespace is a clear too: the route trims before deciding, so the validator must not
    // reject the value one step before that trim can happen.
    await manage(target, "PUT", { model: "9router/ocg-muse-spark-1.3-contributor" });
    expect((await manage(target, "PUT", { model: "   " })).status).toBe(200);
    expect(target.autoReviewOverride).toEqual({ enabled: true });
  });

  test("PUT rejects a malformed selector and a non-boolean flag", async () => {
    const target = config();
    expect((await manage(target, "PUT", { enabled: true, model: "has space/invalid" })).status).toBe(400);
    expect((await manage(target, "PUT", { enabled: "yes" })).status).toBe(400);
    expect(target.autoReviewOverride).toBeUndefined();
  });

  test("PUT reports any uncommitted catalog convergence as pending", async () => {
    const target = config();
    const res = await manage(target, "PUT", { enabled: true, model: "9router/x" }, catalogConvergenceFactory(
      () => {},
      { status: "failed", reason: "disk", phase: "commit", retryable: false, partialWrite: false },
    ));
    expect(res.status).toBe(200);
    expect((await res.json() as { catalogRefresh: { status: string } }).catalogRefresh.status).toBe("failed");
    expect(target.autoReviewOverride).toEqual({ enabled: true, model: "9router/x" });
    const skipped = await manage(target, "PUT", { model: "9router/y" }, catalogConvergenceFactory(
      () => {},
      { status: "skipped", reason: "busy", retryable: true },
    ));
    expect((await skipped.json() as { catalogRefresh: { status: string } }).catalogRefresh.status).toBe("skipped");
  });

  test("PUT reports a thrown catalog refresh after preserving the saved setting", async () => {
    const target = config();
    const res = await manage(target, "PUT", { enabled: true, model: "9router/x" }, catalogConvergenceFactory(() => {
      throw new Error("catalog unavailable");
    }));
    expect(res.status).toBe(200);
    expect((await res.json() as { catalogRefresh: { status: string; reason: string } }).catalogRefresh)
      .toMatchObject({ status: "failed", reason: "internal" });
    expect(target.autoReviewOverride).toEqual({ enabled: true, model: "9router/x" });
  });

  test("PUT puts the live override back when persistence throws", async () => {
    const target = config();
    await manage(target, "PUT", { enabled: true, model: "9router/x" });
    const confirmed = target.autoReviewOverride;
    const confirmedProvenance = { version: 1, deletedTopLevelKeys: ["modelDiscovery"] };
    target.configRebaseProvenance = confirmedProvenance;
    await expect(manage(target, "PUT", { model: "9router/y" }, undefined, () => {
      target.configRebaseProvenance = { version: 1, deletedTopLevelKeys: ["customModels"] };
      throw new Error("disk full");
    })).rejects.toThrow("disk full");
    // The block is mutated in place for live readers; a failed save must not leave a value the
    // request was told did not persist, or the next catalog sync adopts it anyway.
    expect(target.autoReviewOverride).toEqual(confirmed);
    expect(target.configRebaseProvenance).toEqual(confirmedProvenance);

    const fresh = config();
    await expect(manage(fresh, "PUT", { enabled: true }, undefined, () => {
      throw new Error("disk full");
    })).rejects.toThrow("disk full");
    expect(fresh.autoReviewOverride).toBeUndefined();
  });

  test("PUT keeps the override when persistence reports that it was published", async () => {
    const target = config();
    const error = new ConfigWritePublishedError(new Error("bookkeeping"));
    await expect(manage(target, "PUT", { enabled: true, model: "9router/x" }, undefined, () => {
      throw error;
    })).rejects.toBe(error);
    expect(target.autoReviewOverride).toEqual({ enabled: true, model: "9router/x" });
  });
});
