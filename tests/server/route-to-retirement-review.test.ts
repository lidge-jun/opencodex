import { beforeEach, afterEach, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import * as policyState from "../../src/routing/route-intent-state";
import { createTempHome, type TempHome } from "../helpers/temp-home";
import { handleLinkRoutes } from "../../src/server/management/link-routes";
import { compensateNewLink, type LinkRouteState } from "../../src/server/management/link-route-state";
import { readRouteIntentState, setRouteClientIntent, writeRouteIntentState } from "../../src/routing/route-intent-state";
import { seedRouteDeviceClients } from "../../src/routing/home-route-intent";
import type { ManagementContext } from "../../src/server/management/context";
import type { LinkRecord, LinkStore } from "../../src/link/store";
let home: TempHome;
beforeEach(() => { home = createTempHome("route-retire-review-"); });
afterEach(() => home.remove());
const retired = "lnk_0123456789abcdef", active = "lnk_fedcba9876543210", orphan = "lnk_0000000000000000";
function fixture() {
  setRouteClientIntent("aside", { enabled: true, accounts: ["user-a"] });
  for (const id of [retired, active, orphan, "home"]) setRouteClientIntent("aside", { enabled: false }, id);
  const record: LinkRecord = { id: retired, alias: "retiring", direction: "client-initiated", hostKeyFingerprint: null, tunnelPort: 41000, apiKeyId: "fixture-key", createdAt: "2026-01-01T00:00:00Z" };
  let store: LinkStore = { version: 1, listenerPort: null, links: [record, { ...record, id: active, alias: "remaining" }] };
  const req = new Request(`http://localhost/api/link/${retired}`, { method: "DELETE" });
  const ctx = { req, url: new URL(req.url), principal: "admin-token", trustedLoopbackIngress: true,
    config: { port: 18274, providers: {}, apiKeys: [] }, version: "test", deps: {
      readLinkStore: () => store, writeLinkStore: (next: LinkStore) => { store = next; }, revokeApiKey: () => true,
    } } as unknown as ManagementContext;
  const state = { pendingHosts: new Map(), supervisor: { stopLink: async () => {}, reload: async () => {} }, listener: { close: async () => {}, ensureStarted: async () => {}, status: () => ({ state: "listening" }) } } as unknown as LinkRouteState;
  return { ctx, state, record, store: () => store };
}
function preserved() {
  const state = readRouteIntentState();
  expect(state.devices[retired]).toBeUndefined(); expect(state.revisions?.[retired]).toBeUndefined();
  expect(state.devices[orphan]).toBeUndefined(); expect(state.revisions?.[orphan]).toBeUndefined();
  expect(state.devices[active]?.aside).toEqual({ enabled: false });
  expect(state.revisions?.[active]?.aside).toBe(1);
  expect(state.devices.home?.aside).toEqual({ enabled: false });
  expect(state.defaults.aside).toEqual({ enabled: true, accounts: ["user-a"] });
}
test("link removal retires override/revision rows and prior orphans", async () => {
  const f = fixture(); expect((await handleLinkRoutes(f.ctx, f.state))?.status).toBe(200);
  expect(f.store().links.map(row => row.id)).toEqual([active]); preserved();
});
test("failed enrollment compensation retires override/revision rows and prior orphans", async () => {
  const f = fixture(); expect(await compensateNewLink(f.ctx, f.state, f.record)).toBeNull(); preserved();
});
test("enrollment prunes valid accumulated orphan state before adding a new device", () => {
  const f = fixture();
  const state = readRouteIntentState();
  for (let i = 0; i < 2500; i++) {
    state.devices[`retired-${i}`] = { aside: { enabled: true, accounts: ["user-old"] } };
    (state.revisions ??= {})[`retired-${i}`] = { aside: 1 };
  }
  writeRouteIntentState(state);
  seedRouteDeviceClients(f.ctx.config, "test", retired, ["codex"], [active, retired]);
  const next = readRouteIntentState();
  expect(Object.keys(next.devices).sort()).toEqual(["home", retired, active].sort());
  expect(Object.keys(next.revisions ?? {}).sort()).toEqual(["home", retired, active].sort());
  expect(next.devices[retired]?.codex?.enabled).toBe(true);
  expect(next.defaults.aside?.accounts).toEqual(["user-a"]);
});

test("standalone seed callers hold one config lease across retirement, defaults and selection", () => {
  const f = fixture();
  const update = policyState.updateRouteIntentState;
  let observations = 0;
  const check = spyOn(policyState, "updateRouteIntentState").mockImplementation(mutate => {
    const competing = new Database(home.path("config-mutation.sqlite"));
    try {
      expect(() => competing.exec("PRAGMA busy_timeout=0; BEGIN IMMEDIATE")).toThrow(/locked|busy/i);
      observations++;
    } finally {
      try { if (competing.inTransaction) competing.exec("ROLLBACK"); }
      finally { competing.close(); }
    }
    return update(mutate);
  });
  try { seedRouteDeviceClients(f.ctx.config, "test", retired, ["codex"], [active, retired]); }
  finally { check.mockRestore(); }
  expect(observations).toBeGreaterThanOrEqual(3);
  expect(readRouteIntentState().devices[retired]?.codex?.enabled).toBe(true);
});
