import { afterEach, beforeEach, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleManagementAPI } from "../../src/server/management-api";
import type { ManagementApiDeps } from "../../src/server/management/context";
import type { OcxConfig } from "../../src/types";
import type { LinkRecord, LinkStore } from "../../src/link/store";
import type { LinkSupervisor } from "../../src/link/supervisor";
import type { SshRunner, SshRunResult } from "../../src/link/ssh-runner";
import { SshRunnerError } from "../../src/link/ssh-runner";
import { keyFingerprint } from "../../src/link/route-trust";
import { resetSharedChildOpsEngineForTests, sharedChildOpsEngine } from "../../src/link/child-ops-engine";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const LINK = "lnk_0123456789abcdef";
const OTHER = "lnk_fedcba9876543210";
const KEY = Buffer.from("pinned host key blob").toString("base64");
const OTHER_KEY = Buffer.from("another host key blob").toString("base64");
const FP = keyFingerprint(KEY);

let temp = "";
beforeEach(() => { temp = mkdtempSync(join(tmpdir(), "ocx-route-edit-")); });
afterEach(async () => {
  await sharedChildOpsEngine().settled?.();
  resetSharedChildOpsEngineForTests();
  if (temp) removeTreeWithRetry(temp);
  temp = "";
});

function record(overrides: Partial<LinkRecord> = {}): LinkRecord {
  return {
    id: LINK, alias: "pen-alpha", direction: "hub-initiated", hostKeyFingerprint: FP, tunnelPort: 19002,
    apiKeyId: "link-key", createdAt: "2026-11-01T00:00:00.000Z", remotePlatform: "posix", ...overrides,
  };
}

type ProbeAnswer = SshRunResult | Promise<SshRunResult> | (() => never);
interface Probe { destination: string; knownHostsFile: string; knownHostsText: string }

function harness(options: { links?: LinkRecord[]; knownHosts?: string; probe?: (destination: string) => ProbeAnswer; reloadFails?: boolean } = {}) {
  const config = { port: 10100, hostname: "127.0.0.1", runtimeRole: "hub", defaultProvider: "mock", providers: {}, apiKeys: [] } as unknown as OcxConfig;
  let current: LinkStore = { version: 1, listenerPort: 19001, links: options.links ?? [record()] };
  const knownHostsPath = join(temp, "known_hosts");
  writeFileSync(knownHostsPath, options.knownHosts ?? "pen-alpha ssh-ed25519 " + KEY + "\nbeta-host ssh-ed25519 " + OTHER_KEY + "\n");
  const probes: Probe[] = [];
  const events: string[] = [];
  const runner: SshRunner = {
    async run(argv) {
      const destination = argv[argv.indexOf("--") + 1]!;
      const option = argv.find(value => value.startsWith("UserKnownHostsFile="))!.slice("UserKnownHostsFile=".length);
      probes.push({ destination, knownHostsFile: option, knownHostsText: readFileSync(option, "utf8") });
      const answer = options.probe ? options.probe(destination) : { code: 0, stdout: "ocx-link-probe\n", stderr: "" };
      return typeof answer === "function" ? answer() : answer;
    },
    spawnTunnel: () => { throw new Error("no tunnel in route edit tests"); },
  };
  const supervisor: LinkSupervisor = {
    start() {}, ensureStarted: async () => {},
    reload: async () => { events.push("reload"); if (options.reloadFails) throw new Error("reload failed in alpha-lan"); },
    stopLink: async () => {},
    reconnect: async () => true, status: () => [], stop: async () => {},
  };
  const listener = {
    ensureStarted: async () => {}, status: () => ({ state: "listening" as const, port: 19001, reason: null }),
    close: async () => {}, onAuthenticatedCatalog: () => () => {},
  };
  const deps: ManagementApiDeps = {
    readLinkStore: () => structuredClone(current),
    writeLinkStore: next => { current = structuredClone(next); events.push("store"); },
    linkSupervisor: () => supervisor,
    linkListener: () => listener,
    linkKnownHostsPath: () => knownHostsPath,
    sshRunner: runner,
  };
  const call = async (method: string, path: string, body?: unknown, principal: "admin-token" | "gui-session" = "admin-token") => {
    const url = new URL("http://127.0.0.1" + path);
    const req = new Request(url, { method, headers: { host: "127.0.0.1", "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const response = await handleManagementAPI(req, url, config, deps, principal, { isPaired: () => false, isCurrent: () => false, revokeCurrent: () => false }, { trustedLoopback: true, guiSessionIssuance: null });
    return { status: response!.status, body: await response!.json() as Record<string, unknown> };
  };
  return {
    call, probes, events, knownHostsPath,
    get store() { return current; },
    setStore(next: LinkStore) { current = structuredClone(next); },
    edit: (body: unknown) => call("POST", "/api/link/" + LINK + "/routes", body),
  };
}

const routesOf = (h: ReturnType<typeof harness>) => h.store.links.find(link => link.id === LINK)?.routes;

test("GET lists the effective routes with the pin; a one-route link is its alias", async () => {
  const h = harness();
  expect(await h.call("GET", "/api/link/" + LINK + "/routes")).toEqual({ status: 200, body: { linkId: LINK, pin: "pen-alpha", routes: ["pen-alpha"] } });
  expect((await h.call("GET", "/api/link/lnk_1111111111111111/routes")).status).toBe(404);
});

test("add proves the route against a private snapshot of the one pinned line, then stores it before the alias", async () => {
  const h = harness();
  const before = readFileSync(h.knownHostsPath, "utf8");
  const response = await h.edit({ op: "add", route: "alpha-lan" });
  expect(response).toEqual({ status: 200, body: { linkId: LINK, pin: "pen-alpha", routes: ["alpha-lan", "pen-alpha"] } });
  expect(h.probes).toHaveLength(1);
  expect(h.probes[0]!.destination).toBe("alpha-lan");
  expect(h.probes[0]!.knownHostsFile).not.toBe(h.knownHostsPath);
  expect(h.probes[0]!.knownHostsText).toBe("pen-alpha ssh-ed25519 " + KEY + "\n");
  expect(routesOf(h)).toEqual(["alpha-lan", "pen-alpha"]);
  expect(h.events).toEqual(["store", "reload"]);
  // The pin is never written.
  expect(readFileSync(h.knownHostsPath, "utf8")).toBe(before);
  expect(h.store.links[0]!.hostKeyFingerprint).toBe(FP);
  expect(h.store.links[0]!.alias).toBe("pen-alpha");
});

test.each([
  ["host key", "Host key verification failed.", "hostkey"],
  ["auth", "alice@alpha-lan: Permission denied (publickey).", "auth"],
  ["network", "ssh: connect to host 10.0.0.5 port 22: Connection refused", "transient"],
] as const)("an add whose %s probe fails is refused and stores nothing", async (_label, stderr, cause) => {
  const h = harness({ probe: () => ({ code: 255, stdout: "", stderr }) });
  const response = await h.edit({ op: "add", route: "alpha-lan" });
  expect(response.status).toBe(409);
  expect(response.body).toEqual({ error: { code: "route_unproven", message: expect.any(String), cause } });
  expect(JSON.stringify(response.body)).not.toContain("alpha-lan");
  expect(JSON.stringify(response.body)).not.toContain("10.0.0.5");
  expect(routesOf(h)).toBeUndefined();
  expect(h.events).toEqual([]);
});

test("a runner exception is an unproven route with a fixed cause, and the link is free again", async () => {
  let thrown = true;
  const h = harness({ probe: () => thrown ? () => { throw new SshRunnerError("timeout", "ssh command exceeded 15000ms on alpha-lan"); } : { code: 0, stdout: "ocx-link-probe\n", stderr: "" } });
  const response = await h.edit({ op: "add", route: "alpha-lan" });
  expect(response.body).toEqual({ error: { code: "route_unproven", message: expect.any(String), cause: "transient" } });
  expect(JSON.stringify(response.body)).not.toContain("15000");
  thrown = false;
  expect((await h.edit({ op: "add", route: "alpha-lan" })).status).toBe(200);
  const release = sharedChildOpsEngine().reserve(LINK);
  expect(release).not.toBeNull();
  release?.();
});

test.each([
  ["no line for the alias", "beta-host ssh-ed25519 " + OTHER_KEY + "\n", "pin_mismatch"],
  ["another key under the alias", "pen-alpha ssh-ed25519 " + OTHER_KEY + "\n", "pin_mismatch"],
  ["a case variant with another key", "pen-alpha ssh-ed25519 " + KEY + "\nPEN-ALPHA ssh-ed25519 " + OTHER_KEY + "\n", "pin_mismatch"],
  ["a wildcard line", "pen-alpha ssh-ed25519 " + KEY + "\n* ssh-ed25519 " + OTHER_KEY + "\n", "trust_file_unexpected"],
] as const)("a trust file with %s refuses the add before any probe", async (_label, knownHosts, code) => {
  const h = harness({ knownHosts });
  const response = await h.edit({ op: "add", route: "alpha-lan" });
  expect(response.status).toBe(409);
  expect((response.body.error as { code: string }).code).toBe(code);
  expect(h.probes).toHaveLength(0);
});

/** A probe that waits for its release, and a promise that settles once the edit has reached it. */
function gate() {
  let release!: (result: SshRunResult) => void;
  let reached!: () => void;
  const started = new Promise<void>(resolve => { reached = resolve; });
  const probe = () => { reached(); return new Promise<SshRunResult>(resolve => { release = resolve; }); };
  return { probe, started, release: (result: SshRunResult) => release(result) };
}

test("a change to the link, or to its pinned line, during the probe refuses the commit", async () => {
  const g1 = gate();
  const pending = harness({ probe: g1.probe });
  const changed = pending.edit({ op: "add", route: "alpha-lan" });
  await g1.started;
  pending.setStore({ ...pending.store, links: [record({ tunnelPort: 19009 })] });
  g1.release({ code: 0, stdout: "ocx-link-probe\n", stderr: "" });
  expect(await changed).toMatchObject({ status: 409, body: { error: { code: "link_changed" } } });

  const g2 = gate();
  const pin = harness({ probe: g2.probe });
  const pinChanged = pin.edit({ op: "add", route: "alpha-lan" });
  await g2.started;
  writeFileSync(pin.knownHostsPath, "pen-alpha ssh-ed25519 " + OTHER_KEY + "\n");
  g2.release({ code: 0, stdout: "ocx-link-probe\n", stderr: "" });
  expect(await pinChanged).toMatchObject({ status: 409, body: { error: { code: "pin_changed" } } });
  expect(routesOf(pin)).toBeUndefined();
});

test("a link removed by another writer during the probe is not recreated", async () => {
  const g3 = gate();
  const h = harness({ probe: g3.probe });
  const edit = h.edit({ op: "add", route: "alpha-lan" });
  await g3.started;
  h.setStore({ ...h.store, links: [] });
  g3.release({ code: 0, stdout: "ocx-link-probe\n", stderr: "" });
  expect(await edit).toMatchObject({ status: 409, body: { error: { code: "link_changed" } } });
  expect(h.store.links).toEqual([]);
});

test("the commit edits the fresh store: another record and this record's optional fields changed meanwhile survive", async () => {
  const other = record({ id: OTHER, alias: "beta-host", apiKeyId: "other-key", tunnelPort: 19003, hostKeyFingerprint: keyFingerprint(OTHER_KEY) });
  const g4 = gate();
  const h = harness({ links: [record(), other], probe: g4.probe });
  const edit = h.edit({ op: "add", route: "alpha-lan" });
  await g4.started;
  h.setStore({ ...h.store, links: [record({ childKind: "full" }), { ...other, childKind: "ephemeral" }] });
  g4.release({ code: 0, stdout: "ocx-link-probe\n", stderr: "" });
  expect((await edit).status).toBe(200);
  expect(h.store.links[0]).toMatchObject({ childKind: "full", routes: ["alpha-lan", "pen-alpha"] });
  expect(h.store.links[1]).toMatchObject({ childKind: "ephemeral" });
});

test("edits, removal and Child jobs exclude each other on a link", async () => {
  const held = sharedChildOpsEngine().reserve(LINK)!;
  const h = harness();
  expect(await h.edit({ op: "add", route: "alpha-lan" })).toMatchObject({ status: 409, body: { error: { code: "link_operation_in_progress" } } });
  held();
  const g5 = gate();
  const slow = harness({ probe: g5.probe });
  const first = slow.edit({ op: "add", route: "alpha-lan" });
  await g5.started;
  expect(await slow.edit({ op: "add", route: "alpha-tailnet" })).toMatchObject({ status: 409, body: { error: { code: "link_operation_in_progress" } } });
  expect(sharedChildOpsEngine().reserve(LINK)).toBeNull();
  expect((await slow.call("DELETE", "/api/link/" + LINK, {})).status).toBe(409);
  g5.release({ code: 0, stdout: "ocx-link-probe\n", stderr: "" });
  expect((await first).status).toBe(200);
  const after = sharedChildOpsEngine().reserve(LINK);
  expect(after).not.toBeNull();
  after?.();
});

test("remove: the alias is the pin and stays; removing the last extra route restores the one-route record", async () => {
  const h = harness({ links: [record({ routes: ["alpha-lan", "pen-alpha"] })] });
  expect(await h.edit({ op: "remove", route: "pen-alpha" })).toMatchObject({ status: 409, body: { error: { code: "route_is_pin" } } });
  expect(await h.edit({ op: "remove", route: "alpha-tailnet" })).toMatchObject({ status: 404, body: { error: { code: "route_not_found" } } });
  expect(await h.edit({ op: "remove", route: "alpha-lan" })).toEqual({ status: 200, body: { linkId: LINK, pin: "pen-alpha", routes: ["pen-alpha"] } });
  expect("routes" in h.store.links[0]!).toBe(false);
  expect(h.probes).toHaveLength(0);
});

test("order accepts only an exact permutation and never probes", async () => {
  const h = harness({ links: [record({ routes: ["alpha-lan", "alpha-tailnet", "pen-alpha"] })] });
  expect(await h.edit({ op: "order", routes: ["alpha-lan", "pen-alpha"] })).toMatchObject({ status: 409, body: { error: { code: "route_order_mismatch" } } });
  expect(await h.edit({ op: "order", routes: ["alpha-lan", "evil", "pen-alpha"] })).toMatchObject({ status: 409, body: { error: { code: "route_order_mismatch" } } });
  expect(await h.edit({ op: "order", routes: ["alpha-tailnet", "alpha-lan", "pen-alpha"] })).toEqual({ status: 200, body: { linkId: LINK, pin: "pen-alpha", routes: ["alpha-tailnet", "alpha-lan", "pen-alpha"] } });
  expect(h.probes).toHaveLength(0);
});

test.each([
  ["an extra key", { op: "add", route: "alpha-lan", extra: true }, 400, "invalid_body"],
  ["a route ssh would read as an option", { op: "add", route: "-oProxyCommand=sh" }, 400, "invalid_body"],
  ["a position out of range", { op: "add", route: "alpha-lan", position: 5 }, 400, "invalid_body"],
  ["an unknown op", { op: "rename", route: "alpha-lan" }, 400, "invalid_body"],
  ["a route already listed", { op: "add", route: "pen-alpha" }, 409, "route_exists"],
] as const)("%s is refused without a probe", async (_label, body, status, code) => {
  const h = harness();
  const response = await h.edit(body);
  expect(response.status).toBe(status);
  expect((response.body.error as { code: string }).code).toBe(code);
  expect(h.probes).toHaveLength(0);
});

test("the ninth route is refused, and an explicit position is honoured", async () => {
  const eight = ["r0", "r1", "r2", "r3", "r4", "r5", "r6", "pen-alpha"];
  const full = harness({ links: [record({ routes: eight })] });
  expect(await full.edit({ op: "add", route: "r7" })).toMatchObject({ status: 409, body: { error: { code: "route_limit" } } });
  const h = harness();
  expect((await h.edit({ op: "add", route: "pen-relay-2", position: 1 })).body.routes).toEqual(["pen-alpha", "pen-relay-2"]);
});

test("Child-initiated links have no routes to edit", async () => {
  const h = harness({ links: [record({ direction: "client-initiated", hostKeyFingerprint: null })] });
  expect(await h.call("GET", "/api/link/" + LINK + "/routes")).toMatchObject({ status: 409, body: { error: { code: "link_not_home_initiated" } } });
  expect(await h.edit({ op: "add", route: "alpha-lan" })).toMatchObject({ status: 409, body: { error: { code: "link_not_home_initiated" } } });
});

test("route edits need the link authority: an unpaired dashboard session is refused", async () => {
  const h = harness();
  expect((await h.call("GET", "/api/link/" + LINK + "/routes", undefined, "gui-session")).status).toBe(403);
  expect((await h.call("POST", "/api/link/" + LINK + "/routes", { op: "add", route: "alpha-lan" }, "gui-session")).status).toBe(403);
  expect(h.probes).toHaveLength(0);
});

test("the route endpoints are reachable neither over the Child-readable relay nor on the local control socket", async () => {
  const { linkManagementReadAllowed } = await import("../../src/link/management-routes");
  const { localControlRouteAllowed } = await import("../../src/server/index/local-control-listener");
  const path = "/api/link/" + LINK + "/routes";
  expect(linkManagementReadAllowed("GET", path)).toBe(false);
  expect(linkManagementReadAllowed("POST", path)).toBe(false);
  for (const method of ["GET", "POST"]) {
    const url = new URL("http://localhost" + path);
    expect(localControlRouteAllowed(url, new Request(url, { method }))).toBe(false);
  }
});

test("an edit stored but not applied by the running supervisor is an explicit error, never a 200", async () => {
  const h = harness({ reloadFails: true });
  const response = await h.edit({ op: "add", route: "alpha-lan" });
  expect(response.status).toBe(500);
  expect(response.body).toEqual({ error: { code: "routes_stored_reload_failed", message: expect.stringContaining("Restart"), linkId: LINK, pin: "pen-alpha", routes: ["alpha-lan", "pen-alpha"] } });
  expect(JSON.stringify(response.body)).not.toContain("reload failed in");
  // The store holds the edit, so a restart applies it.
  expect(routesOf(h)).toEqual(["alpha-lan", "pen-alpha"]);
  expect(h.events).toEqual(["store", "reload"]);
});

test("a link whose pin an older release recorded hashed still proves and stores a new route, over the hashed line", async () => {
  // Releases before HashKnownHosts=no copied the probe's line hashed on Homes whose ssh_config hashes.
  const salt = Buffer.alloc(20, 5);
  const hashed = "|1|" + salt.toString("base64") + "|" + createHmac("sha1", salt).update("pen-alpha").digest("base64") + " ssh-ed25519 " + KEY;
  const h = harness({ knownHosts: hashed + "\nbeta-host ssh-ed25519 " + OTHER_KEY + "\n" });
  const response = await h.edit({ op: "add", route: "alpha-lan" });
  expect(response).toEqual({ status: 200, body: { linkId: LINK, pin: "pen-alpha", routes: ["alpha-lan", "pen-alpha"] } });
  expect(h.probes[0]!.knownHostsText).toBe(hashed + "\n");
});

test("a pin recorded hashed and later again in plain form, with one key, still proves and stores a new route", async () => {
  const salt = Buffer.alloc(20, 6);
  const hashed = "|1|" + salt.toString("base64") + "|" + createHmac("sha1", salt).update("pen-alpha").digest("base64") + " ssh-ed25519 " + KEY;
  const h = harness({ knownHosts: hashed + "\npen-alpha ssh-ed25519 " + KEY + "\n" });
  const response = await h.edit({ op: "add", route: "alpha-lan" });
  expect(response).toEqual({ status: 200, body: { linkId: LINK, pin: "pen-alpha", routes: ["alpha-lan", "pen-alpha"] } });
  // The probe trusts the one key, from one line.
  expect(h.probes[0]!.knownHostsText).toBe(hashed + "\n");
});
