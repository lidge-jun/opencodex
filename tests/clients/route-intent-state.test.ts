import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearRouteClientIntent, readRouteIntentState, routeIntentStatePath, setRouteClientIntent } from "../../src/routing/route-intent-state";
import { projectHomeRouteIntent } from "../../src/link/route-intent";
import { removeTreeWithRetry } from "../helpers/remove-tree";
let root: string;
let previous: string | undefined;
beforeEach(() => { previous = process.env.OPENCODEX_HOME; root = mkdtempSync(join(tmpdir(), "ocx-route-state-")); process.env.OPENCODEX_HOME = root; });
afterEach(() => { if (previous === undefined) delete process.env.OPENCODEX_HOME; else process.env.OPENCODEX_HOME = previous; removeTreeWithRetry(root); });
test("default/device writes preserve disjoint clients and inherit restores default", () => {
  expect(readRouteIntentState()).toEqual({ version: 1, defaults: {}, devices: {} });
  setRouteClientIntent("aside", { enabled: true, accounts: "all" });
  setRouteClientIntent("aside", { enabled: false }, "lnk_0123456789abcdef");
  setRouteClientIntent("pi", { enabled: true }, "lnk_0123456789abcdef");
  let state = readRouteIntentState();
  expect(projectHomeRouteIntent({} as never, "test", "lnk_0123456789abcdef", state).clients.aside).toEqual({ enabled: false, accounts: "all" });
  clearRouteClientIntent("aside", "lnk_0123456789abcdef");
  state = readRouteIntentState();
  expect(state.devices.lnk_0123456789abcdef?.pi).toEqual({ enabled: true });
  expect(projectHomeRouteIntent({} as never, "test", "lnk_0123456789abcdef", state).clients.aside).toEqual({ enabled: true, accounts: "all" });
});
test("corrupt or unknown state refuses update without replacing existing bytes", () => {
  for (const body of ['{"version":2,"defaults":{},"devices":{}}', '{"version":1,"defaults":{},"devices":{},"secret":"x"}', "not json"]) {
    writeFileSync(routeIntentStatePath(), body);
    expect(() => readRouteIntentState()).toThrow();
    expect(() => setRouteClientIntent("codex", { enabled: false })).toThrow();
    expect(readFileSync(routeIntentStatePath(), "utf8")).toBe(body);
  }
  expect(() => setRouteClientIntent("aside", { enabled: true }, "__proto__")).toThrow();
});
