import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleManagementAPI } from "../../src/server/management-api";
import type { ManagementApiDeps } from "../../src/server/management/context";
import type { OcxConfig } from "../../src/types";
import type { LinkRecord, LinkStore } from "../../src/link/store";
import type { LinkSupervisor } from "../../src/link/supervisor";
import type { SshRunner } from "../../src/link/ssh-runner";
import { keyFingerprint } from "../../src/link/route-trust";
import { resetSharedChildOpsEngineForTests, sharedChildOpsEngine } from "../../src/link/child-ops-engine";
import { removeTreeWithRetry } from "../helpers/remove-tree";

/** O6: an exclusive link refuses every route edit; GET stays a read. */
const LINK = "lnk_0123456789abcdef";
const KEY = Buffer.from("pinned host key blob").toString("base64");
const ROUTE = { proxyCommand: "/usr/local/bin/pen pipe --node 7f3a9c 22", user: "ubuntu", port: 22 };

let temp = "";
beforeEach(() => { temp = mkdtempSync(join(tmpdir(), "ocx-route-exclusive-")); });
afterEach(async () => {
  await sharedChildOpsEngine().settled?.();
  resetSharedChildOpsEngineForTests();
  if (temp) removeTreeWithRetry(temp);
  temp = "";
});

function record(overrides: Partial<LinkRecord> = {}): LinkRecord {
  return {
    id: LINK, alias: "pen-7f3a9c", direction: "hub-initiated", hostKeyFingerprint: keyFingerprint(KEY), tunnelPort: 19002,
    apiKeyId: "link-key", createdAt: "2026-11-13T00:00:00.000Z", remotePlatform: "posix", ...overrides,
  };
}

function harness(link: LinkRecord, duringProbe?: (store: LinkStore) => void) {
  const config = { port: 10100, hostname: "127.0.0.1", runtimeRole: "hub", defaultProvider: "mock", providers: {}, apiKeys: [] } as unknown as OcxConfig;
  let current: LinkStore = { version: 1, listenerPort: 19001, links: [link] };
  const knownHostsPath = join(temp, "known_hosts");
  writeFileSync(knownHostsPath, "pen-7f3a9c ssh-ed25519 " + KEY + "\n");
  const ssh: string[][] = [];
  const events: string[] = [];
  const runner: SshRunner = {
    async run(argv) { ssh.push([...argv]); duringProbe?.(current); return { code: 0, stdout: "ocx-link-probe\n", stderr: "" }; },
    spawnTunnel: () => { throw new Error("no tunnel here"); },
  };
  const supervisor: LinkSupervisor = {
    start() {}, ensureStarted: async () => {}, reload: async () => { events.push("reload"); },
    stopLink: async () => {}, reconnect: async () => true, status: () => [], stop: async () => {},
  };
  const listener = {
    ensureStarted: async () => {}, status: () => ({ state: "listening" as const, port: 19001, reason: null }),
    close: async () => {}, onAuthenticatedCatalog: () => () => {},
  };
  const deps: ManagementApiDeps = {
    readLinkStore: () => structuredClone(current),
    writeLinkStore: next => { current = structuredClone(next); events.push("store"); },
    linkSupervisor: () => supervisor, linkListener: () => listener,
    linkKnownHostsPath: () => knownHostsPath, sshRunner: runner,
  };
  const call = async (method: string, body?: unknown) => {
    const url = new URL("http://127.0.0.1/api/link/" + LINK + "/routes");
    const req = new Request(url, { method, headers: { host: "127.0.0.1", "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const response = await handleManagementAPI(req, url, config, deps, "admin-token", { isPaired: () => false, isCurrent: () => false, revokeCurrent: () => false }, { trustedLoopback: true, guiSessionIssuance: null });
    return { status: response!.status, body: await response!.json() as Record<string, unknown> };
  };
  return { call, ssh, events, get store() { return current; } };
}

test.each([
  ["an explicit route", record({ explicitRoute: ROUTE, exclusive: true })],
  ["exclusive alone", record({ exclusive: true })],
])("adding a direct route to an exclusive link with %s is refused before any probe", async (_label, link) => {
  const h = harness(link);
  const before = structuredClone(h.store);
  const added = await h.call("POST", { op: "add", route: "alpha-lan" });
  expect({ status: added.status, code: (added.body.error as { code?: string } | undefined)?.code }).toEqual({ status: 409, code: "link_exclusive" });
  expect(h.ssh).toEqual([]);
  expect(h.events).toEqual([]);
  expect(h.store).toEqual(before);
});

test("remove and order are refused on an exclusive link too; GET still answers", async () => {
  const h = harness(record({ explicitRoute: ROUTE, exclusive: true }));
  for (const body of [{ op: "remove", route: "alpha-lan" }, { op: "order", routes: ["pen-7f3a9c"] }, { op: "add", route: "alpha-lan", position: 0 }]) {
    const edited = await h.call("POST", body);
    expect({ status: edited.status, code: (edited.body.error as { code?: string } | undefined)?.code }).toEqual({ status: 409, code: "link_exclusive" });
  }
  expect(h.ssh).toEqual([]);
  const read = await h.call("GET");
  expect(read).toEqual({ status: 200, body: { linkId: LINK, pin: "pen-7f3a9c", routes: ["pen-7f3a9c"], exclusive: true } });
});

test("a link that turned exclusive while its new route was probed is not edited", async () => {
  // The store gains exclusive during the route probe: the commit's fresh read must refuse it.
  const h = harness(record(), store => { store.links[0]!.exclusive = true; });
  const before = record({ exclusive: true });
  const added = await h.call("POST", { op: "add", route: "alpha-lan" });
  expect(h.ssh.length).toBe(1);
  expect({ status: added.status, code: (added.body.error as { code?: string } | undefined)?.code }).toEqual({ status: 409, code: "link_exclusive" });
  expect(h.store.links).toEqual([before]);
  expect(h.events).toEqual([]);
});
