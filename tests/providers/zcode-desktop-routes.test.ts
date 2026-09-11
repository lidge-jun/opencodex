import { describe, expect, test } from "bun:test";
import { handleZcodeDesktopRoutes } from "../../src/server/management/zcode-desktop-routes";
import type { ManagementContext } from "../../src/server/management/context";

const status = { connected: false, issue: undefined, runtimes: ["/installed/ZCode"], runtime: "/installed/ZCode", workspace: "/project", models: [], platform: "linux" as const };
function context(path: string, body: unknown, principal?: ManagementContext["principal"]): ManagementContext {
  const req = new Request(`http://localhost${path}`, { method: "POST", headers: { "content-type": "application/json", origin: "http://localhost", "x-opencodex-gui-session": "forged" }, body: JSON.stringify(body) });
  return { req, url: new URL(req.url), principal } as ManagementContext;
}
function fixture() {
  let calls = 0;
  const deps = { desktopStatus: () => status, connectDesktop: async () => { calls++; return { ...status, connected: true }; }, disconnectDesktop: async () => { calls++; } };
  return { deps, calls: () => calls };
}
describe("ZCode Desktop management consent", () => {
  for (const principal of [undefined, "admin-token"] as const) {
    test(`rejects native execution configuration from ${principal ?? "missing"} principal`, async () => {
      const f = fixture();
      for (const action of ["connect", "disconnect", "test"]) {
        const response = await handleZcodeDesktopRoutes(context(`/api/zcode-desktop/${action}`, { consent: true, runtime: "/installed/ZCode", workspace: "/project" }, principal), f.deps);
        expect(response?.status).toBe(403);
      }
      expect(f.calls()).toBe(0);
    });
  }
  test("requires an explicit consent checkbox, not just a GUI session", async () => {
    const f = fixture(); const response = await handleZcodeDesktopRoutes(context("/api/zcode-desktop/connect", { runtime: "/installed/ZCode", workspace: "/project" }, "gui-session"), f.deps);
    expect(response?.status).toBe(400); expect(f.calls()).toBe(0);
  });
  test("connection does not send inference or mutate provider settings", async () => {
    const f = fixture(); const response = await handleZcodeDesktopRoutes(context("/api/zcode-desktop/connect", { consent: true, runtime: "/installed/ZCode", workspace: "/project" }, "gui-session"), f.deps);
    expect(await response?.json()).toMatchObject({ connected: true }); expect(f.calls()).toBe(1);
  });
  test("oversized setup payload is rejected before runtime execution", async () => {
    const f = fixture(); const response = await handleZcodeDesktopRoutes(context("/api/zcode-desktop/connect", { consent: true, runtime: "x".repeat(14000), workspace: "/project" }, "gui-session"), f.deps);
    expect(response?.status).toBe(400); expect(f.calls()).toBe(0);
  });
});
