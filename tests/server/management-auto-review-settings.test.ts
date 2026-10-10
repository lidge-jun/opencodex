import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ManagementRequest as Request } from "../helpers/management-auth";
import { handleManagementAPI } from "../../src/server/management-api";
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

async function manage(target: OcxConfig, method: string, body?: unknown): Promise<Response> {
  // The management API enforces a same-origin gate; a browserless caller must look local.
  const headers: Record<string, string> = { origin: "http://127.0.0.1:10100", host: "127.0.0.1:10100" };
  if (body !== undefined) headers["content-type"] = "application/json";
  const req = new Request("http://localhost/api/auto-review-settings", {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const res = await handleManagementAPI(req, new URL(req.url), target, {
    createManagementConvergeCodex: catalogConvergenceFactory(),
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

  test("PUT persists the enabled selector and echoes it", async () => {
    const target = config();
    const res = await manage(target, "PUT", { enabled: true, model: " 9router/ocg-muse-spark-1.3-contributor " });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, enabled: true, model: "9router/ocg-muse-spark-1.3-contributor" });
    expect(target.autoReviewOverride).toEqual({ enabled: true, model: "9router/ocg-muse-spark-1.3-contributor" });
    const persisted = JSON.parse(readFileSync(join(home!, "config.json"), "utf8")) as OcxConfig;
    expect(persisted.autoReviewOverride).toEqual({ enabled: true, model: "9router/ocg-muse-spark-1.3-contributor" });
  });

  test("PUT with a blank model clears it while keeping the flag", async () => {
    const target = config();
    await manage(target, "PUT", { enabled: true, model: "9router/ocg-muse-spark-1.3-contributor" });
    const res = await manage(target, "PUT", { model: "" });
    expect(res.status).toBe(200);
    expect(target.autoReviewOverride).toEqual({ enabled: true });
  });

  test("PUT rejects a malformed selector and a non-boolean flag", async () => {
    const target = config();
    expect((await manage(target, "PUT", { enabled: true, model: "has space/invalid" })).status).toBe(400);
    expect((await manage(target, "PUT", { enabled: "yes" })).status).toBe(400);
    expect(target.autoReviewOverride).toBeUndefined();
  });
});
