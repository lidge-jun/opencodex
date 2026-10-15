import { expect, test } from "bun:test";
import { handleDesktopCompatibilityRuntimeRoutes } from "../../src/server/management/desktop-compatibility-runtime-routes";
import { createDesktopCompatibilityRuntime } from "../../src/codex/desktop-compatibility/runtime";
import type { ManagementContext } from "../../src/server/management/context";
import { handleManagementAPI } from "../../src/server/management-api";
import type { OcxConfig } from "../../src/types";

const url = new URL("http://127.0.0.1:10100/api/codex/desktop-compatibility/runtime");
function fixture(method: string, body?: unknown) {
  const calls: string[] = [];
  const runtime = createDesktopCompatibilityRuntime({ platform: "linux" });
  runtime.start = async () => { calls.push("start"); return runtime.status(); };
  runtime.stop = async () => { calls.push("stop"); return runtime.status(); };
  const ctx = { req: new Request(url, { method, headers: { host: url.host, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), url,
    deps: { desktopCompatibilityRuntime: runtime }, principal: "gui-session", trustedLoopbackIngress: true } as ManagementContext;
  return { ctx, calls, runtime };
}
test("runtime status is inert and the management dispatcher preserves local consent", async () => {
  const io = fixture("GET");
  expect((await handleDesktopCompatibilityRuntimeRoutes(io.ctx))?.status).toBe(200); expect(io.calls).toEqual([]);
  const confirmed = fixture("POST", { action: "start", confirmed: true });
  const response = await handleManagementAPI(confirmed.ctx.req, url, { providers: {} } as OcxConfig, confirmed.ctx.deps, "gui-session", undefined, { trustedLoopback: true });
  expect(response?.status).toBe(200); expect(confirmed.calls).toEqual(["start"]);
});
test("remote/admin-token callers and ambiguous scope cannot start or alter runtime", async () => {
  for (const change of [{ principal: "admin-token" }, { trustedLoopbackIngress: false }]) {
    const io = fixture("POST", { action: "start", confirmed: true }); Object.assign(io.ctx, change);
    expect((await handleDesktopCompatibilityRuntimeRoutes(io.ctx))?.status).toBe(403); expect(io.calls).toEqual([]);
  }
  for (const body of [{ action: "start" }, { action: ["start"], confirmed: true }, { action: "apply", confirmed: true },
    { action: "start", confirmed: true, accountWideConsent: true }, { action: "start", confirmed: true, model: "fixture" }]) {
    const io = fixture("POST", body); expect((await handleDesktopCompatibilityRuntimeRoutes(io.ctx))?.status).toBe(400); expect(io.calls).toEqual([]);
  }
});
test("runtime failures report safe codes and never leak subprocess or credential data", async () => {
  const io = fixture("POST", { action: "start", confirmed: true });
  io.runtime.start = async () => { throw new Error("synthetic-private-data"); };
  const response = await handleDesktopCompatibilityRuntimeRoutes(io.ctx);
  expect(response?.status).toBe(409); expect(await response!.text()).not.toContain("synthetic-private-data");
});
