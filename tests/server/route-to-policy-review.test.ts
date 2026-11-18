import { afterEach, beforeEach, expect, test } from "bun:test";
import { createTempHome, type TempHome } from "../helpers/temp-home";
import { handleRouteToRoutes } from "../../src/server/management/route-to-routes";
import { readRouteIntentState, setRouteClientIntent } from "../../src/routing/route-intent-state";
import { withLinkApply, LinkApplyBusyError } from "../../src/client/link-home";
import type { ManagementContext } from "../../src/server/management/context";
import type { LinkRecord } from "../../src/link/store";
let home: TempHome;
beforeEach(() => { home = createTempHome("route-policy-review-"); });
afterEach(() => home.remove());
const id = "lnk_0123456789abcdef", other = "lnk_fedcba9876543210";
function context(body: unknown, sync = false, aliases = ["child", "other"]): ManagementContext {
  const req = new Request(`http://localhost/api/route-to${sync ? "/sync" : ""}`, { method: sync ? "POST" : "PUT", body: JSON.stringify(body) });
  return { req, url: new URL(req.url), config: { port: 18274, providers: {} }, version: "test", deps: {
    readLinkStore: () => ({ version: 1, listenerPort: null, links: [id, other].map((id, i) => ({ id, alias: aliases[i] } as LinkRecord)) }),
  } } as ManagementContext;
}
const deps = { applyHome: async () => [] };
test("on/off preserve omitted policy knobs and explicit values replace them", () => {
  for (const device of [undefined, id]) {
    setRouteClientIntent("aside", { enabled: true, accounts: ["user-a"] }, device);
    setRouteClientIntent("aside", { enabled: false }, device);
    setRouteClientIntent("aside", { enabled: true }, device);
    const map = () => device ? readRouteIntentState().devices[device]! : readRouteIntentState().defaults;
    expect(map().aside).toEqual({ enabled: true, accounts: ["user-a"] });
    setRouteClientIntent("aside", { enabled: true, accounts: "none" }, device);
    expect(map().aside?.accounts).toBe("none");
    setRouteClientIntent("hermes", { enabled: true, modelNames: "alias" }, device);
    setRouteClientIntent("hermes", { enabled: false }, device);
    expect(map().hermes).toEqual({ enabled: false, modelNames: "alias" });
  }
});
test("ambiguous aliases refuse before writes; exact ID wins even against another alias", async () => {
  const denied = await handleRouteToRoutes(context({ client: "aside", action: "on", device: "same" }, false, ["same", "same"]), deps);
  expect(denied?.status).toBe(409);
  expect(readRouteIntentState().defaults).toEqual({});
  expect(readRouteIntentState().devices).toEqual({});
  const accepted = await handleRouteToRoutes(context({ client: "aside", action: "on", device: id }, false, ["child", id]), deps);
  expect(accepted?.status).toBe(200);
  expect(readRouteIntentState().devices[id]?.aside?.enabled).toBe(true);
  expect(readRouteIntentState().devices[other]).toBeUndefined();
});
test("Home apply busy refuses before committing policy", async () => {
  await withLinkApply(async () => {
    const response = await handleRouteToRoutes(context({ client: "aside", action: "on" }), deps);
    expect(response?.status).toBe(409);
    expect(await response!.json()).toMatchObject({ desiredCommitted: false });
    expect(readRouteIntentState().defaults).toEqual({});
  });
});
test("a second Home write cannot change the policy an admitted apply is reconciling", async () => {
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const waiting = new Promise<void>(resolve => { release = resolve; });
  const first = handleRouteToRoutes(context({ client: "aside", action: "on" }), {
    applyHome: async () => { entered(); await waiting; expect(readRouteIntentState().defaults.aside?.enabled).toBe(true); return []; },
  });
  await started;
  const second = await handleRouteToRoutes(context({ client: "aside", action: "off" }), deps);
  release();
  expect((await first)?.status).toBe(200);
  expect(second?.status).toBe(409);
  expect(readRouteIntentState().defaults.aside?.enabled).toBe(true);
});
test("a busy error after desired commit reports that the decision remains saved", async () => {
  const response = await handleRouteToRoutes(context({ client: "aside", action: "on" }), {
    applyHome: async () => { throw new LinkApplyBusyError(); },
  });
  expect(response?.status).toBe(409);
  expect(await response!.json()).toMatchObject({ desiredCommitted: true });
  expect(readRouteIntentState().defaults.aside?.enabled).toBe(true);
});
test("reconcile failure deliberately retains committed desired state", async () => {
  const response = await handleRouteToRoutes(context({ client: "aside", action: "on" }), {
    applyHome: async () => { expect(readRouteIntentState().defaults.aside?.enabled).toBe(true); throw new Error("fixture apply failed"); },
  });
  expect(response?.status).toBe(500);
  expect(readRouteIntentState().defaults.aside?.enabled).toBe(true);
});
test("failed child sync returns its matrix alongside the failure status", async () => {
  const response = await handleRouteToRoutes(context({ device: "child" }, true), {
    syncChild: async () => ({ state: "failed", reason: "fixture_failed" }),
  });
  expect(response?.status).toBe(502);
  const body = await response!.json();
  expect(body.devices.map((row: { id: string }) => row.id)).toEqual([id]);
  expect(body.syncs).toEqual([{ id, state: "failed", reason: "fixture_failed" }]);
});
