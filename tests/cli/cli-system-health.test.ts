import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { handleSystemCommand } from "../../src/cli/system-command";
import { handleSystemRoutes } from "../../src/server/management/system-routes";
import { resetSharedSpendLedgerForTest } from "../../src/lib/spend-reservation-ledger";
import { createTempHome, type TempHome } from "../helpers/temp-home";
import type { RuntimeApiDeps } from "../../src/cli/runtime-api";

const realFetch = globalThis.fetch;
let home: TempHome, out: ReturnType<typeof spyOn>, err: ReturnType<typeof spyOn>, network: ReturnType<typeof spyOn>;
let admin: string | undefined;
beforeEach(() => {
  home = createTempHome("ocx-cli-health-"); admin = process.env.OPENCODEX_ADMIN_AUTH_TOKEN;
  process.env.OPENCODEX_ADMIN_AUTH_TOKEN = "synthetic-health-admin";
  out = spyOn(console, "log").mockImplementation(() => {}); err = spyOn(console, "error").mockImplementation(() => {});
  network = spyOn(globalThis, "fetch").mockImplementation(() => { throw new Error("Unowned network forbidden"); });
});
afterEach(() => {
  expect(network).not.toHaveBeenCalled(); network.mockRestore(); out.mockRestore(); err.mockRestore();
  if (admin === undefined) delete process.env.OPENCODEX_ADMIN_AUTH_TOKEN; else process.env.OPENCODEX_ADMIN_AUTH_TOKEN = admin;
  home.remove();
});
const stdout = () => out.mock.calls.flat().join("\n");
const stderr = () => err.mock.calls.flat().join("\n");
function healthy() {
  return { status: "ok", service: "opencodex", version: "1.2.3", uptime: 1.25, pid: 321,
    spendLedger: { ownership: "unheld", initialized: false, configured: false, degraded: false, persistFailures: 0, corruptRecords: 0 } };
}
function fixture(reply: unknown = healthy()) {
  const calls: { path: string; init?: RequestInit }[] = [];
  const deps: RuntimeApiDeps = { baseUrl: "http://fixture.invalid", fetchImpl: async (input, init) => {
    calls.push({ path: String(input), init }); return reply instanceof Response ? reply : Response.json(reply);
  } };
  return { deps, calls };
}
describe("ocx system health", () => {
  test("one fixed authenticated GET projects only health fields", async () => {
    const f = fixture({ ...healthy(), secret: "private-canary", spendLedger: { ...healthy().spendLedger, secret: "private-canary" } });
    expect(await handleSystemCommand(["health", "--json"], f.deps)).toBe(0);
    expect(JSON.parse(stdout())).toEqual(healthy()); expect(f.calls).toHaveLength(1);
    expect(f.calls[0]!.path).toBe("http://fixture.invalid/api/system/health");
    expect(f.calls[0]!.init).toMatchObject({ method: "GET", redirect: "error" });
    expect(f.calls[0]!.init?.body).toBeUndefined();
    expect(new Headers(f.calls[0]!.init?.headers).get("x-opencodex-api-key")).toBe("synthetic-health-admin");
    expect(stderr()).toBe("");
  });
  test("degraded ledger is a successful observation, not a healthy-all claim", async () => {
    const raw = healthy(); Object.assign(raw.spendLedger, { initialized: true, configured: true, ownership: "held", degraded: true, persistFailures: 4, corruptRecords: 2 });
    expect(await handleSystemCommand(["health"], fixture(raw).deps)).toBe(0);
    expect(stdout()).toContain("Spend ledger: degraded"); expect(stdout()).toContain("failures: 4; corrupt records: 2");
    expect(stdout()).toContain("does not certify every subsystem healthy"); expect(stdout()).toContain("Next:");
    out.mockClear(); expect(await handleSystemCommand(["health", "--json"], fixture(raw).deps)).toBe(0);
    expect(JSON.parse(stdout())).toEqual(raw);
  });
  test.each([
    null, {}, [], { ...healthy(), status: ["ok"] }, { ...healthy(), service: "other" }, { ...healthy(), version: "" },
    { ...healthy(), pid: 0 }, { ...healthy(), pid: 1.5 }, { ...healthy(), uptime: -1 },
    { ...healthy(), spendLedger: {} }, { ...healthy(), spendLedger: { ...healthy().spendLedger, ownership: ["held"] } },
    { ...healthy(), spendLedger: { ...healthy().spendLedger, degraded: "false" } },
    { ...healthy(), spendLedger: { ...healthy().spendLedger, persistFailures: -1 } },
    { ...healthy(), spendLedger: { ...healthy().spendLedger, corruptRecords: 1_000_001 } },
  ].map(raw => [raw]))("unusable shape is nonzero without raw output %#", async raw => {
    expect(await handleSystemCommand(["health", "--json"], fixture(raw).deps)).toBe(1);
    expect(stdout()).toBe(""); expect(stderr()).toContain("usable outcome");
  });
  test.each([["--provider", "private-canary"], ["--json", "--json"], ["--json=true"], ["extra"]])("invalid grammar sends no request %#", async (...args) => {
    const f = fixture(); expect(await handleSystemCommand(["health", ...args], f.deps)).toBe(2);
    expect(f.calls).toHaveLength(0); expect(stdout()).toBe(""); expect(stderr()).not.toContain("private-canary");
  });
  test.each([401, 403, 404, 409, 500, 503])("safe failure and numeric exit for HTTP %i", async status => {
    expect(await handleSystemCommand(["health", "--json"], fixture(Response.json({ error: "private-canary\u001b[31m" }, { status })).deps))
      .toBe(status === 404 ? 4 : status === 409 ? 5 : 1);
    expect(stdout()).toBe(""); expect(stderr()).not.toContain("private-canary");
  });
  test("network exception is never echoed", async () => {
    expect(await handleSystemCommand(["health"], { baseUrl: "http://fixture.invalid", fetchImpl: async () => { throw new Error("private-canary"); } })).toBe(1);
    expect(stderr()).not.toContain("private-canary");
  });
  test.each([301, 302, 303, 307, 308])("real redirect %i makes no second endpoint request", async status => {
    let first = 0, second = 0;
    const destination = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => { second++; return Response.json(healthy()); } });
    const origin = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: req => {
      first++; expect(req.headers.get("x-opencodex-api-key")).toBe("synthetic-health-admin");
      return new Response(null, { status, headers: { Location: String(destination.url) } });
    } });
    try {
      expect(await handleSystemCommand(["health", "--json"], { baseUrl: String(origin.url), fetchImpl: realFetch })).toBe(1);
      expect(first).toBe(1); expect(second).toBe(0); expect(stdout()).toBe("");
    } finally { await origin.stop(true); await destination.stop(true); }
  });
  test("actual system owner returns current scalar diagnostics without starting a service", async () => {
    resetSharedSpendLedgerForTest();
    const deps: RuntimeApiDeps = { baseUrl: "http://fixture.invalid", fetchImpl: async (input, init) => {
      const req = new Request(input, init);
      const response = await handleSystemRoutes({ req, url: new URL(req.url), config: { port: 0, defaultProvider: "fixture", providers: {} },
        deps: {}, version: "fixture-version", trustedLoopbackIngress: true, guiSessionIssuance: null,
        convergeCodexCatalog: async () => { throw new Error("No convergence allowed"); }, syncClaudeAgentDefsBestEffort: async () => { throw new Error("No sync allowed"); } });
      if (!response) throw new Error("Owner did not handle route"); return response;
    } };
    try {
      expect(await handleSystemCommand(["health", "--json"], deps)).toBe(0);
      expect(JSON.parse(stdout())).toMatchObject({ status: "ok", service: "opencodex", pid: process.pid, version: "fixture-version",
        spendLedger: { ownership: "unheld", initialized: false, configured: false, degraded: false, persistFailures: 0, corruptRecords: 0 } });
    } finally { resetSharedSpendLedgerForTest(); }
  });
  test("aggregate system status keeps its three legacy requests", async () => {
    const f = fixture({}); expect(await handleSystemCommand(["status", "--json"], f.deps)).toBe(0);
    expect(f.calls.map(call => new URL(call.path).pathname).sort()).toEqual(["/api/settings", "/api/startup-health", "/api/system/memory"]);
    expect(JSON.parse(stdout())).toEqual({ settings: {}, startup: {}, memory: {} });
  });
});
