import { expect, test } from "bun:test";
import { handleDesktopCompatibilityRoutes } from "../../src/server/management/desktop-compatibility-routes";
import type { ManagementContext } from "../../src/server/management/context";
import type { DesktopCertificateService } from "../../src/codex/desktop-compatibility/certificate-service";
import { handleManagementAPI } from "../../src/server/management-api";
import type { OcxConfig } from "../../src/types";

const url = new URL("http://127.0.0.1:10100/api/codex/desktop-compatibility/certificate");
function fixture(method: string, body?: object, principal: ManagementContext["principal"] = "gui-session", loopback = true) {
  const calls: string[] = [];
  const status = { supported: true, state: "prepared" as const, busy: null };
  const service: DesktopCertificateService = { status: async () => { calls.push("status"); return status; },
    prepare: async () => { calls.push("prepare"); return status; }, trust: async fp => { calls.push("trust:" + fp); return status; },
    removeTrust: async fp => { calls.push("remove:" + fp); return status; }, renew: async fp => { calls.push("renew:" + fp); return status; } };
  const ctx = { req: new Request(url, { method, headers: { host: url.host, "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) }),
    url, principal, trustedLoopbackIngress: loopback, deps: { desktopCertificateService: service } } as ManagementContext;
  return { calls, ctx };
}
test("status reads do not invoke setup or OS trust", async () => {
  const io = fixture("GET", undefined, "admin-token"); expect((await handleDesktopCompatibilityRoutes(io.ctx))?.status).toBe(200);
  expect(io.calls).toEqual(["status"]);
});
test("only authenticated local dashboard mutations reach the service", async () => {
  for (const [principal, loopback] of [["admin-token", true], ["gui-session", false], [undefined, true]] as const) {
    const io = fixture("POST", { action: "prepare", confirmed: true }, principal, loopback);
    if (principal === undefined) io.ctx.principal = undefined;
    expect((await handleDesktopCompatibilityRoutes(io.ctx))?.status).toBe(403); expect(io.calls).toEqual([]);
  }
});
test("explicit confirmation and exact fingerprint are validated before any side effect", async () => {
  for (const body of [{ action: "prepare" }, { action: "trust", confirmed: true }, { action: "trust", confirmed: true, fingerprint: "wrong" },
    { action: "prepare", confirmed: true, injected: true }, { action: ["prepare"], confirmed: true }]) {
    const io = fixture("POST", body); expect((await handleDesktopCompatibilityRoutes(io.ctx))?.status).toBe(400); expect(io.calls).toEqual([]);
  }
  const valid = fixture("POST", { action: "trust", confirmed: true, fingerprint: "A".repeat(64) });
  expect((await handleDesktopCompatibilityRoutes(valid.ctx))?.status).toBe(200); expect(valid.calls).toEqual(["trust:" + "A".repeat(64)]);
});
test("unexpected errors never expose process output or credential strings", async () => {
  const io = fixture("POST", { action: "prepare", confirmed: true });
  io.ctx.deps.desktopCertificateService!.prepare = async () => { throw new Error("synthetic-private-key-output"); };
  const response = await handleDesktopCompatibilityRoutes(io.ctx); expect(response?.status).toBe(409);
  expect(await response!.json()).toEqual({ ok: false, error: "operation_failed" });
});

test("renewal requires fresh fingerprint and explicit local dashboard confirmation", async () => {
  const invalid = fixture("POST", { action: "renew", confirmed: true });
  expect((await handleDesktopCompatibilityRoutes(invalid.ctx))?.status).toBe(400); expect(invalid.calls).toEqual([]);
  const valid = fixture("POST", { action: "renew", confirmed: true, fingerprint: "A".repeat(64) });
  expect((await handleDesktopCompatibilityRoutes(valid.ctx))?.status).toBe(200); expect(valid.calls).toEqual(["renew:" + "A".repeat(64)]);
});
test("the real management dispatcher reaches setup with principal and ingress intact", async () => {
  const io = fixture("POST", { action: "prepare", confirmed: true });
  const response = await handleManagementAPI(io.ctx.req, url, { providers: {} } as OcxConfig,
    io.ctx.deps, "gui-session", undefined, { trustedLoopback: true });
  expect(response?.status).toBe(200); expect(io.calls).toEqual(["prepare"]);
});
