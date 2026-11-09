import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { handleRouteToCommand as command, type RouteToDeps } from "../../src/cli/route-to";
import { createTempHome, type TempHome } from "../helpers/temp-home";
import type { LinkChildContext } from "../../src/cli/link-child";
import { resolveHelpPath } from "../../src/cli/help-catalog";
import { dispatchCommand, type CliDispatchDeps } from "../../src/cli/dispatch";
import { parseCliHead } from "../../src/cli/root";
import { CAPABILITIES } from "../../src/cli/capabilities";
import { ROUTE_CLIENT_IDS } from "../../src/link/route-intent";

let home: TempHome;
let out: ReturnType<typeof spyOn>, err: ReturnType<typeof spyOn>, network: ReturnType<typeof spyOn>;
beforeEach(() => {
  home = createTempHome("ocx-route-to-cli-");
  out = spyOn(console, "log").mockImplementation(() => {});
  err = spyOn(console, "error").mockImplementation(() => {});
  network = spyOn(globalThis, "fetch").mockImplementation(async () => { throw new Error("Network denied"); });
});
afterEach(() => { network.mockRestore(); out.mockRestore(); err.mockRestore(); home.remove(); });

const status = { schema: "ocx.route-to/1", devices: [
  { id: "home", alias: "home", clients: ROUTE_CLIENT_IDS.map(client => ({ client, intent: "on", source: "default", applied: "current", ...(client === "aside" ? { target: "u0,u1" } : {}) })) },
  { id: "lnk_0123456789abcdef", alias: "child-test", clients: ROUTE_CLIENT_IDS.map(client => ({ client, intent: client === "grok" ? "off" : "on", source: "device", applied: client === "grok" ? "not_installed" : "current" })) },
] };
const child = { linkId: "lnk_0123456789abcdef", homePhrase: "Home 'home-test'", connection: {} } as LinkChildContext;

function fixture(response: unknown = status, code = 200) {
  const calls: Array<{ path: string; method: string; body: unknown }> = [];
  let probes = 0;
  const deps: RouteToDeps = {
    readChildContext: () => null,
    findLiveProxy: async () => { probes++; return { hostname: "127.0.0.1", port: 10100, pid: 1, source: "runtime" }; },
    fetchImpl: (async (input, init) => {
      expect(init?.redirect).toBe("error");
      const url = new URL(String(input));
      calls.push({ path: url.pathname + url.search, method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : null });
      return Response.json(response, { status: code });
    }) as typeof fetch,
  };
  return { deps, calls, probes: () => probes };
}

describe("Home route-to wire contract", () => {
  test("a client decision reports unrelated conflicts without treating them as its own failure", async () => {
    const result = structuredClone(status);
    result.devices[0]!.clients.find(row => row.client === "claude-desktop")!.applied = "conflict";
    expect(await command(["opencode", "on"], fixture(result).deps)).toBe(0);
    expect(err.mock.calls.flat().join("\n")).toContain("other clients");
    expect(await command(["claude-desktop", "on"], fixture(result).deps)).toBe(5);
    expect(await command(["sync"], fixture(result).deps)).toBe(5);
  });
  test("an empty device matrix cannot confirm a mutation", async () => {
    expect(await command(["aside", "on"], fixture({ schema: "ocx.route-to/1", devices: [] }).deps)).toBe(1);
    expect(err.mock.calls.flat().join("\n")).toContain("unverified");
  });
  test("an incomplete local sync exposes deferred state and exits nonzero", async () => {
    const result = { ...status, deferred: { reason: "intent_or_catalog_pending", clients: ["aside"] } };
    expect(await command(["sync", "--json"], fixture(result).deps)).toBe(1);
    expect(JSON.parse(out.mock.calls[0]![0]).deferred).toEqual(result.deferred);
    expect(err.mock.calls.flat().join("\n")).toContain("deferred");
  });
  test("a notified Child request stays pending in human output until an apply report arrives", async () => {
    const f = fixture({ ...status, syncs: [{ id: "child-test", state: "pending", reason: "Immediate reconciliation requested; awaiting the Child apply report" }] });
    expect(await command(["sync", "--device", "child-test"], f.deps)).toBe(0);
    expect(out.mock.calls.flat().join("\n")).toContain("sync child-test: pending (Immediate reconciliation requested; awaiting the Child apply report)");
    expect(f.calls).toHaveLength(1);
  });
  test.each([undefined, "all", "this", "child-test"])("status device %s", async device => {
    const f = fixture();
    expect(await command(["status", ...(device ? ["--device", device] : []), "--json"], f.deps)).toBe(0);
    expect(f.calls).toEqual([{ path: `/api/route-to${device ? `?device=${device}` : ""}`, method: "GET", body: null }]);
    expect(JSON.parse(out.mock.calls[0]![0])).toEqual(status);
  });
  test.each([
    { argv: ["aside", "on"], body: { client: "aside", action: "on" } },
    { argv: ["aside", "on", "--accounts", "user-a,user-b", "--device", "child-test"], body: { client: "aside", action: "on", accounts: ["user-a", "user-b"], device: "child-test" } },
    { argv: ["aside", "on", "--accounts=none"], body: { client: "aside", action: "on", accounts: "none" } },
    { argv: ["aside", "on", "--accounts=all"], body: { client: "aside", action: "on", accounts: "all" } },
    { argv: ["hermes", "on", "--model-names=alias", "--overwrite-conflict"], body: { client: "hermes", action: "on", modelNames: "alias", overwriteConflict: true } },
    { argv: ["commandcode", "on", "--model-names=routed"], body: { client: "commandcode", action: "on", modelNames: "routed" } },
    { argv: ["codex", "off", "--device=this"], body: { client: "codex", action: "off", device: "this" } },
    { argv: ["pi", "inherit", "--device=child-test"], body: { client: "pi", action: "inherit", device: "child-test" } },
  ])("PUT $argv", async ({ argv, body }) => {
    const f = fixture();
    expect(await command([...argv, "--json"], f.deps)).toBe(0);
    expect(f.calls).toEqual([{ path: "/api/route-to", method: "PUT", body }]);
  });
  test("sync is a single POST and human status exposes each outcome", async () => {
    const f = fixture();
    expect(await command(["sync", "--device", "all", "--overwrite-conflict"], f.deps)).toBe(0);
    expect(f.calls).toEqual([{ path: "/api/route-to/sync", method: "POST", body: { device: "all", overwriteConflict: true } }]);
    const text = out.mock.calls.map(call => call[0]).join("\n");
    expect(text).toContain("home  aside  on  default  current  u0,u1");
    expect(text).toContain("child-test  grok  off  device  not_installed  -");
  });
  test("conflict is not retried or silently overwritten", async () => {
    const f = fixture({ error: "conflict" }, 409);
    expect(await command(["aside", "on"], f.deps)).toBe(5);
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]!.body).toEqual({ client: "aside", action: "on" });
  });
  test("unverified response cannot claim success", async () => {
    const f = fixture({ ok: true });
    expect(await command(["aside", "on"], f.deps)).toBe(1);
    expect(out.mock.calls).toEqual([]);
  });
  test.each([
    { client: "aside", intent: "on", source: "default" },
    { client: "aside", intent: "on", source: "default", applied: "invented" },
    { client: "aside", intent: "on", source: "default", applied: null, target: {} },
  ])("malformed client rows cannot become confirmed status: %j", async row => {
    const f = fixture({ schema: "ocx.route-to/1", devices: [{ id: "home", clients: [row] }] });
    expect(await command(["status", "--json"], f.deps)).toBe(1);
    expect(out.mock.calls).toEqual([]);
  });
  test("per-client failure is printed and returns nonzero", async () => {
    const f = fixture({ schema: "ocx.route-to/1", devices: [{ id: "home", clients: [{ client: "pi", intent: "on", source: "default", applied: "failed" }] }] });
    expect(await command(["sync", "--json"], f.deps)).toBe(5);
    expect(JSON.parse(out.mock.calls[0]![0]).devices[0].clients[0].applied).toBe("failed");
  });
});

test.each([
  ["bogus", "on"], ["aside", "maybe"], ["aside", "inherit"], ["status", "extra"],
  ["aside", "on", "--device=all"],
  ["status", "--accounts=all"], ["sync", "--model-names=alias"], ["status", "--overwrite-conflict"],
  ["pi", "on", "--accounts=all"], ["aside", "off", "--accounts=none"],
  ["aside", "on", "--accounts=u/0"], ["aside", "on", "--accounts=user-a,,user-b"],
  ["aside", "on", "--accounts=U0"], ["aside", "on", "--accounts=user/path"],
  ["aside", "on", `--accounts=${"a".repeat(129)}`],
  ["aside", "on", "--accounts=user-a,user-a"], ["aside", "on", "--accounts=all,user-a"],
  ["hermes", "on", "--model-names=invalid"], ["pi", "on", "--model-names=alias"],
  ["pi", "off", "--overwrite-conflict"], ["pi", "on", "--local"], ["sync", "--local"],
  ["status", "--device="], ["status", "--device", " "], ["status", "--device=a", "--device=b"],
  ["status", "--json=true"], ["status", "--json", "--json"], ["status", "--unknown"],
])("invalid input refuses before discovery %j", async (...argv) => {
  const f = fixture();
  let contextReads = 0;
  f.deps.readChildContext = () => { contextReads++; return child; };
  expect(await command(argv, f.deps)).toBe(2);
  expect(f.calls).toEqual([]); expect(f.probes()).toBe(0); expect(contextReads).toBe(0);
});

function localFixture() {
  const f = fixture();
  const localCalls: unknown[][] = [];
  f.deps.readChildContext = () => child;
  f.deps.loadLocal = async () => ({
    readLocalRouteToStatus: async (...args: unknown[]) => { localCalls.push(["status", ...args]); return status; },
    syncLocalRouteTo: async (...args: unknown[]) => { localCalls.push(["sync", ...args]); return status; },
    setLocalRouteToOff: async (...args: unknown[]) => { localCalls.push(["off", ...args]); return status; },
  }) as Awaited<ReturnType<NonNullable<RouteToDeps["loadLocal"]>>>;
  return { ...f, localCalls };
}

describe("Child route-to stays local", () => {
  test.each([undefined, "this", child.linkId])("local status for %s", async device => {
    const f = localFixture();
    expect(await command(["status", ...(device ? ["--device", device] : []), "--json"], f.deps)).toBe(0);
    expect(f.localCalls).toEqual([["status", child]]);
    expect(f.calls).toEqual([]); expect(f.probes()).toBe(0);
  });
  test("sync forwards explicit conflict decision only to local materializer", async () => {
    const f = localFixture();
    expect(await command(["sync", "--overwrite-conflict"], f.deps)).toBe(0);
    expect(f.localCalls).toEqual([["sync", child, true]]);
    expect(f.calls).toEqual([]); expect(f.probes()).toBe(0);
  });
  test.each(["on", "off", "inherit"])("Home-owned %s refuses with exact child id", async action => {
    const f = localFixture();
    expect(await command(["aside", action, "--device", "this"], f.deps)).toBe(5);
    expect(err.mock.calls.flat().join("\n")).toContain(`ocx route to aside ${action} --device lnk_0123456789abcdef`);
    expect(f.calls).toEqual([]); expect(f.localCalls).toEqual([]); expect(f.probes()).toBe(0);
  });
  test.each(["off", "inherit"])("local %s toggles opt-out", async action => {
    const f = localFixture();
    expect(await command(["aside", action, "--local"], f.deps)).toBe(0);
    expect(f.localCalls).toEqual([["off", child, "aside", action === "off"]]);
    expect(f.calls).toEqual([]); expect(f.probes()).toBe(0);
  });
  test.each(["all", "home-test", "another-link"])("foreign device %s cannot use local status/sync", async device => {
    const f = localFixture();
    for (const action of ["status", "sync"]) expect(await command([action, "--device", device], f.deps)).toBe(2);
    expect(f.calls).toEqual([]); expect(f.localCalls).toEqual([]); expect(f.probes()).toBe(0);
  });
  test("Home refuses --local without any management request", async () => {
    const f = fixture();
    expect(await command(["aside", "off", "--local"], f.deps)).toBe(2);
    expect(f.calls).toEqual([]); expect(f.probes()).toBe(0);
  });
});

test("route dispatch reaches route-to without a live proxy or local writes", async () => {
  const argv = ["route", "to", "status", "--json"];
  const head = parseCliHead(argv);
  let probes = 0;
  expect(await dispatchCommand(head, { args: argv, findLiveProxy: async () => { probes++; return null; } } as unknown as CliDispatchDeps)).toBe(1);
  expect(probes).toBe(1);
  expect(err.mock.calls.flat().join("\n")).toContain("Proxy is not running");
});

test.each([
  { path: ["route", "to", "status"], method: "GET", endpoint: "/api/route-to" },
  { path: ["route", "to", "sync"], method: "POST", endpoint: "/api/route-to/sync" },
  { path: ["route", "to", "aside", "on"], method: "PUT", endpoint: "/api/route-to" },
  { path: ["route", "to", "codex", "inherit"], method: "PUT", endpoint: "/api/route-to" },
])("help resolves executable route-to leaves: $path", ({ path, method, endpoint }) => {
  const resolved = resolveHelpPath(path);
  expect(resolved.kind).toBe("capability");
  if (resolved.kind !== "capability") throw new Error("Missing capability");
  expect(resolved.capability.routes).toEqual([{ method, path: endpoint }]);
});

// A plain toggle is a Home-only decision on the client-integration route, never a route-to default write.
test.each(["enable", "disable"])("client %s discovery names the Home-only toggle route", action => {
  const resolved = resolveHelpPath(["integration", "client", action]);
  if (resolved.kind !== "capability") throw new Error("Missing alias capability");
  expect(resolved.capability.routes).toContainEqual({ method: "PUT", path: "/api/client-integrations/{clientId}" });
  expect(resolved.capability.routes).not.toContainEqual({ method: "PUT", path: "/api/route-to" });
});

test.each(["restore", "preview", "sync"])("client %s discovery preserves its legacy endpoints", action => {
  const resolved = resolveHelpPath(["integration", "client", action]);
  if (resolved.kind !== "capability") throw new Error("Missing legacy capability");
  expect(resolved.capability.routes).not.toContainEqual({ method: "PUT", path: "/api/route-to" });
});

test("route-to discovery stays bounded while covering all API operations", () => {
  const entries = CAPABILITIES.filter(row => row.command[0] === "route" && row.command[1] === "to");
  expect(entries.map(row => row.command.join(" ")).sort()).toEqual(["route to", "route to status", "route to sync"]);
  expect(entries.flatMap(row => row.routes)).toEqual(expect.arrayContaining([
    { method: "GET", path: "/api/route-to" },
    { method: "PUT", path: "/api/route-to" },
    { method: "POST", path: "/api/route-to/sync" },
  ]));
});
