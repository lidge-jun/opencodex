import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleLinkRoutes, type LinkRouteState } from "../../src/server/management/link-routes";
import type { ManagementContext } from "../../src/server/management/context";
import { claimLinkRetirement, readLinkRetirement } from "../../src/link/retirement";
import { keyFingerprint } from "../../src/link/route-trust";
import type { OcxConfig } from "../../src/types";
import type { LinkRecord, LinkStore } from "../../src/link/store";
import type { SshRunner } from "../../src/link/ssh-runner";
import { resetSharedChildOpsEngineForTests, sharedChildOpsEngine } from "../../src/link/child-ops-engine";
import { removeTreeWithRetry } from "../helpers/remove-tree";

/**
 * #8678: a route edit made while a removal's retirement receipt is outstanding would leave the stored record unequal to
 * the receipt's copy, and every later revoke would answer link_changed. The edit is refused instead, before the probe
 * and again at its commit, and the interrupted removal can still finish.
 */
const LINK = "lnk_0123456789abcdef";
const ALIAS = "pen-alpha";
const OP = "detach-8678";
const KEY = Buffer.from("pinned host key blob").toString("base64");

let root = "";
let previousHome: string | undefined;
beforeEach(() => { previousHome = process.env.OPENCODEX_HOME; root = mkdtempSync(join(tmpdir(), "ocx-route-retire-")); process.env.OPENCODEX_HOME = root; });
afterEach(async () => {
  await sharedChildOpsEngine().settled?.();
  resetSharedChildOpsEngineForTests();
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  removeTreeWithRetry(root);
});

function record(): LinkRecord {
  return { id: LINK, alias: ALIAS, direction: "hub-initiated", hostKeyFingerprint: keyFingerprint(KEY), tunnelPort: 2200, apiKeyId: "link-key",
    createdAt: "2026-11-13T00:00:00.000Z", remotePlatform: "posix", routes: ["alpha-lan", ALIAS] };
}

function harness(options: { duringProbe?: (store: LinkStore) => void } = {}) {
  const config: OcxConfig = { port: 10100, hostname: "127.0.0.1", runtimeRole: "standalone", defaultProvider: "mock", providers: {},
    apiKeys: [{ id: "link-key", name: "link:" + ALIAS, key: "k", createdAt: "2026-11-13T00:00:00Z" }] };
  let store: LinkStore = { version: 1, listenerPort: 18181, links: [record()] };
  let revokeFails = false;
  const probes: string[][] = [];
  const state: LinkRouteState = {
    pendingHosts: new Map(), confirmedHosts: new Map(), operations: new Set(),
    listener: { ensureStarted: async () => {}, status: () => ({ state: "listening", port: 18181, reason: null }), close: async () => {}, onAuthenticatedCatalog: () => () => {} },
    supervisor: { start() {}, ensureStarted: async () => {}, reload: async () => {}, stopLink: async () => {}, reconnect: async () => true, status: () => [], stop: async () => {},
      holdLink: () => () => {} },
  };
  const runner: SshRunner = {
    async run(argv) {
      if (argv.at(-1) !== "echo ocx-link-probe") throw new Error("only the route probe runs ssh here");
      probes.push([...argv]);
      options.duringProbe?.(store);
      return { code: 0, stdout: "ocx-link-probe\n", stderr: "" };
    },
    spawnTunnel() { throw new Error("no tunnel here"); },
  };
  writeFileSync(join(root, "known_hosts"), ALIAS + " ssh-ed25519 " + KEY + "\n");
  const deps: ManagementContext["deps"] = {
    sshRunner: runner,
    readLinkStore: () => structuredClone(store), writeLinkStore: next => { store = structuredClone(next); },
    linkKnownHostsPath: () => join(root, "known_hosts"), linkOperationsPath: () => join(root, "operations.json"),
    linkAliasLock: { lockDir: join(root, "locks"), waitMs: 0, pollMs: 250 },
    revokeApiKey: (cfg, id) => { if (revokeFails) return false; const before = cfg.apiKeys ?? []; cfg.apiKeys = before.filter(key => key.id !== id); return before.length !== cfg.apiKeys.length; },
  };
  async function call(method: string, path: string, body?: unknown) {
    const url = new URL("http://127.0.0.1:10100" + path);
    const req = new Request(url, { method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const context: ManagementContext = {
      req, url, config, deps, version: "2.99.0", principal: "admin-token", trustedLoopbackIngress: true, guiSessionIssuance: null,
      sessionControl: { isCurrent: () => true, isPaired: () => false, revokeCurrent: () => true },
      convergeCodexCatalog: async () => { throw new Error("no catalog convergence"); }, syncClaudeAgentDefsBestEffort: async () => {},
    };
    const response = await handleLinkRoutes(context, state);
    return { status: response!.status, body: await response!.json() as Record<string, unknown> };
  }
  return {
    revoke: (body: Record<string, unknown>) => call("DELETE", "/api/link/" + LINK, body),
    edit: (body: Record<string, unknown>) => call("POST", "/api/link/" + LINK + "/routes", body),
    read: () => call("GET", "/api/link/" + LINK + "/routes"),
    probes, config, setRevokeFails: (value: boolean) => { revokeFails = value; }, get store() { return store; },
  };
}

const code = (answer: { body: Record<string, unknown> }) => (answer.body.error as { code?: string } | undefined)?.code;

test("a route edit after a failed revoke is refused, and repeating that revoke finishes the removal", async () => {
  const h = harness();
  h.setRevokeFails(true);
  const failed = await h.revoke({ force: true, operationId: OP });
  expect({ status: failed.status, code: code(failed) }).toEqual({ status: 502, code: "key_revoke_failed" });
  expect(readLinkRetirement(LINK, root)).not.toBeNull();
  const before = structuredClone(h.store);
  for (const body of [{ op: "add", route: "beta-lan" }, { op: "remove", route: "alpha-lan" }, { op: "order", routes: [ALIAS, "alpha-lan"] }]) {
    const edited = await h.edit(body);
    expect({ op: body.op, status: edited.status, code: code(edited) }).toEqual({ op: body.op, status: 409, code: "link_retirement_pending" });
  }
  // Refused before the probe: no ssh ran, and the record still equals the receipt's copy.
  expect(h.probes).toEqual([]);
  expect(h.store).toEqual(before);
  expect(readLinkRetirement(LINK, root)!.link).toEqual(h.store.links[0]!);
  // A read is not an edit.
  expect(await h.read()).toEqual({ status: 200, body: { linkId: LINK, pin: ALIAS, routes: ["alpha-lan", ALIAS] } });
  h.setRevokeFails(false);
  const finished = await h.revoke({ force: true, operationId: OP });
  expect({ status: finished.status, outcome: finished.body.outcome }).toEqual({ status: 200, outcome: "committed" });
  expect(h.store.links).toEqual([]);
  expect(h.config.apiKeys).toEqual([]);
  expect(readLinkRetirement(LINK, root)).toBeNull();
});

test("a receipt claimed while the new route was probed refuses the edit at its commit, and a plain force revoke finishes", async () => {
  // Another process claims the link's receipt while this edit probes its route: the commit, under the config mutation
  // lock, must see it and leave the record as the receipt copied it.
  const h = harness({ duringProbe: store => { claimLinkRetirement(store.links[0]!, root, () => store, "force"); } });
  const edited = await h.edit({ op: "add", route: "beta-lan" });
  expect(h.probes.length).toBe(1);
  expect({ status: edited.status, code: code(edited) }).toEqual({ status: 409, code: "link_retirement_pending" });
  expect(h.store.links).toEqual([record()]);
  const forced = await h.revoke({ force: true });
  expect(forced.status).toBe(200);
  expect(h.store.links).toEqual([]);
  expect(readLinkRetirement(LINK, root)).toBeNull();
});

test("a route edit with no receipt outstanding is unaffected", async () => {
  const h = harness();
  const edited = await h.edit({ op: "add", route: "beta-lan" });
  expect(edited).toEqual({ status: 200, body: { linkId: LINK, pin: ALIAS, routes: ["alpha-lan", "beta-lan", ALIAS] } });
  expect(h.probes.length).toBe(1);
});

