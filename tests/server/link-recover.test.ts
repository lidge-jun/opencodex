import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleLinkRoutes, type LinkRouteState } from "../../src/server/management/link-routes";
import type { ManagementContext } from "../../src/server/management/context";
import type { OcxConfig } from "../../src/types";
import type { LinkRecord, LinkStore } from "../../src/link/store";
import type { SshRunner, SshRunResult } from "../../src/link/ssh-runner";
import { keyFingerprint } from "../../src/link/route-trust";
import { tombstonesPath } from "../../src/link/tombstones";
import { registerOperationRecoveryResolver } from "../../src/link/operation-recovery-slot";
import { removeTreeWithRetry } from "../helpers/remove-tree";

// Home side of lane O5: a forced revoke of an ephemeral link leaves a tombstone, and
// POST /api/link/recover cleans that Child through detach --purge --expect-link over the link's
// own alias and pinned host key, removing the tombstone only on the Child's bound receipt.

const ID = "lnk_0123456789abcdef";
const OTHER = "lnk_fedcba9876543210";
const HOST_KEY = Buffer.from("fixture-host-key-a").toString("base64");
const FINGERPRINT = keyFingerprint(HOST_KEY);
const ok = (stdout = "", code = 0, stderr = ""): SshRunResult => ({ code, stdout, stderr });
const report = (body: Record<string, unknown>, code = 0) => ok(JSON.stringify(body) + "\n", code);

let root: string;
let previousHome: string | undefined;
beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  root = mkdtempSync(join(tmpdir(), "ocx-link-recover-"));
  process.env.OPENCODEX_HOME = root;
});
afterEach(() => {
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  removeTreeWithRetry(root);
});

function link(over: Partial<LinkRecord> = {}): LinkRecord {
  return {
    id: ID, alias: "devbox", direction: "hub-initiated", hostKeyFingerprint: FINGERPRINT, tunnelPort: 24500,
    apiKeyId: "fixture-key", createdAt: "2026-11-07T00:00:00.000Z", remotePlatform: "posix", childKind: "ephemeral", ...over,
  };
}

function harness(links: LinkRecord[]) {
  const config: OcxConfig = { port: 10100, hostname: "127.0.0.1", runtimeRole: "standalone", defaultProvider: "mock", providers: {}, apiKeys: [] };
  const knownHosts = join(root, "known_hosts");
  writeFileSync(knownHosts, "devbox ssh-ed25519 " + HOST_KEY + "\n");
  let store: LinkStore = { version: 1, listenerPort: 18181, links };
  const commands: string[] = [];
  let answer: () => SshRunResult = () => report({ restored: true, outcome: "ExactRestore", daemonRunning: false, purged: true, linkId: ID });
  const state: LinkRouteState = {
    pendingHosts: new Map(),
    operations: new Set(),
    listener: {
      ensureStarted: async () => {},
      status: () => ({ state: "listening", port: 18181, reason: null }),
      close: async () => {},
      onAuthenticatedCatalog: () => () => {},
    },
    supervisor: {
      start() {}, ensureStarted: async () => {}, reload: async () => {}, holdLink: () => () => {},
      stopLink: async () => {}, reconnect: async () => true, status: () => [], stop: async () => {},
    },
  };
  const runner: SshRunner = {
    async run(argv) {
      const command = argv.at(-1) ?? "";
      commands.push(argv.join(" "));
      if (!command.includes("ocx-managed-purge")) throw new Error("Unexpected SSH command: " + command);
      return answer();
    },
    spawnTunnel() { throw new Error("unused"); },
  };
  const deps: ManagementContext["deps"] = {
    now: () => 1_800_000_000_000,
    sshRunner: runner,
    readLinkStore: () => store,
    writeLinkStore: next => { store = next; },
    linkKnownHostsPath: () => knownHosts,
    revokeApiKey: (cfg, id) => { cfg.apiKeys = (cfg.apiKeys ?? []).filter(k => k.id !== id); return true; },
  };
  async function request(method: string, path: string, body?: unknown) {
    const url = new URL("http://127.0.0.1:10100" + path);
    const req = new Request(url, { method, ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }) });
    const ctx: ManagementContext = {
      req, url, config, deps, version: "2.98.0", principal: "admin-token", trustedLoopbackIngress: true, guiSessionIssuance: null,
      sessionControl: { isCurrent: () => true, isPaired: () => true, revokeCurrent: () => true },
      convergeCodexCatalog: async () => { throw new Error("unused"); },
      syncClaudeAgentDefsBestEffort: async () => {},
    };
    const resp = await handleLinkRoutes(ctx, state);
    if (!resp) throw new Error("unhandled " + method + " " + path);
    return resp;
  }
  return {
    request, commands, knownHosts,
    get store() { return store; },
    answer(next: () => SshRunResult) { answer = next; },
  };
}

function tombstones(): Array<Record<string, unknown>> {
  const path = tombstonesPath();
  if (!existsSync(path)) return [];
  return (JSON.parse(readFileSync(path, "utf8")) as { tombstones: Array<Record<string, unknown>> }).tombstones;
}

async function forceRevoke(h: ReturnType<typeof harness>, id = ID) {
  const res = await h.request("DELETE", "/api/link/" + id, { force: true });
  expect(res.status).toBe(200);
}

const errorOf = async (res: Response) => (await res.json() as { error: { code: string; hint?: string; message: string } }).error;

describe("force revoke tombstones", () => {
  test("a forced revoke of an ephemeral Home-initiated link keeps a tombstone and runs no SSH", async () => {
    const h = harness([link({ routes: ["devbox-direct", "devbox"] })]);
    await forceRevoke(h);
    expect(h.store.links).toEqual([]);
    expect(h.commands).toEqual([]);
    expect(tombstones()).toEqual([{
      linkId: ID, alias: "devbox", hostKeyFingerprint: FINGERPRINT, remotePlatform: "posix",
      routes: ["devbox-direct", "devbox"], revokedAt: new Date(1_800_000_000_000).toISOString(),
    }]);
    if (process.platform !== "win32") expect((Bun.file(tombstonesPath()).size)).toBeGreaterThan(0);
  });

  test.each([
    ["a full Child", { childKind: "full" as const }],
    ["a link enrolled before childKind", { childKind: undefined }],
  ])("a forced revoke of %s keeps no tombstone", async (_name, over) => {
    const h = harness([link(over)]);
    await forceRevoke(h);
    expect(tombstones()).toEqual([]);
  });

  test("an ordinary purge revoke keeps no tombstone", async () => {
    const h = harness([link()]);
    h.answer(() => report({ restored: true, outcome: "ExactRestore", daemonRunning: false, purged: true }));
    const res = await h.request("DELETE", "/api/link/" + ID, { purge: true });
    expect(res.status).toBe(200);
    expect(tombstones()).toEqual([]);
  });

  test("a damaged tombstone file refuses the forced revoke and keeps the link", async () => {
    const h = harness([link()]);
    await Bun.write(tombstonesPath(), "{damaged");
    const res = await h.request("DELETE", "/api/link/" + ID, { force: true });
    expect(res.status).toBe(503);
    expect((await errorOf(res)).code).toBe("tombstone_write_failed");
    expect(h.store.links.map(l => l.id)).toEqual([ID]);
  });
});

describe("POST /api/link/recover", () => {
  test("a clean Child receipt bound to the link removes the tombstone", async () => {
    const h = harness([link()]);
    await forceRevoke(h);
    const res = await h.request("POST", "/api/link/recover", { linkId: ID });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ linkId: ID, outcome: "clean", purged: true });
    expect(tombstones()).toEqual([]);
    expect(h.commands).toHaveLength(1);
    // Over the alias alone, with the pinned host key, never a sibling route.
    expect(h.commands[0]).toContain("HostKeyAlias=devbox");
    expect(h.commands[0]).toContain("StrictHostKeyChecking=yes");
    expect(h.commands[0]).toContain("'--expect-link' '" + ID + "'");
    expect(h.commands[0]).not.toContain("devbox-direct");
  });

  test("a Child that reports nothing left to restore for the link is clean too", async () => {
    const h = harness([link()]);
    await forceRevoke(h);
    h.answer(() => report({ restored: true, outcome: "NotAttached", daemonRunning: false, purged: true, linkId: ID }));
    expect((await h.request("POST", "/api/link/recover", { linkId: ID })).status).toBe(200);
    expect(tombstones()).toEqual([]);
  });

  test.each([
    ["residual", 6, "child_residual"],
    ["conflict", 5, "child_conflict"],
  ])("a %s answer keeps the tombstone and names the record", async (outcome, code, errorCode) => {
    const h = harness([link()]);
    await forceRevoke(h);
    h.answer(() => report({ restored: false, outcome, linkId: ID, record: "codex-home-owner", path: "/home/someone/.codex/.ocx-child-owner.json", reason: "free text from the machine", purged: false }, code));
    const res = await h.request("POST", "/api/link/recover", { linkId: ID });
    expect(res.status).toBe(409);
    const error = await errorOf(res);
    expect(error).toMatchObject({ code: errorCode, hint: "codex-home-owner" });
    // Text the machine wrote is never echoed back.
    expect(JSON.stringify(error)).not.toContain("someone");
    expect(JSON.stringify(error)).not.toContain("free text");
    expect(tombstones().map(t => t.linkId)).toEqual([ID]);
  });

  test.each([
    ["a receipt for another link", report({ restored: true, outcome: "ExactRestore", daemonRunning: false, purged: true, linkId: OTHER }), "receipt_unbound"],
    ["a receipt without a link id", report({ restored: true, outcome: "ExactRestore", daemonRunning: false, purged: true }), "receipt_unbound"],
    ["a binary it did not remove", report({ restored: true, outcome: "ExactRestore", daemonRunning: false, purged: false, linkId: ID }), "purge_incomplete"],
  ])("%s is not proof of cleanup", async (_name, result, hint) => {
    const h = harness([link()]);
    await forceRevoke(h);
    h.answer(() => result);
    const res = await h.request("POST", "/api/link/recover", { linkId: ID });
    expect(res.status).toBe(502);
    expect(await errorOf(res)).toMatchObject({ code: "remote_recover_failed", hint });
    expect(tombstones().map(t => t.linkId)).toEqual([ID]);
  });

  test("an ocx-child older than --expect-link is reported, not treated as cleaned", async () => {
    const h = harness([link()]);
    await forceRevoke(h);
    h.answer(() => ok("", 2, "Usage: ocx-child detach [--keep-catalog] [--purge] [--json]\n"));
    const res = await h.request("POST", "/api/link/recover", { linkId: ID });
    expect(res.status).toBe(409);
    expect((await errorOf(res)).code).toBe("child_recover_unsupported");
    expect(tombstones().map(t => t.linkId)).toEqual([ID]);
  });

  test("a changed host key for the alias refuses before any SSH", async () => {
    const h = harness([link()]);
    await forceRevoke(h);
    writeFileSync(h.knownHosts, "devbox ssh-ed25519 " + Buffer.from("another-host-key").toString("base64") + "\n");
    const res = await h.request("POST", "/api/link/recover", { linkId: ID });
    expect(res.status).toBe(409);
    expect((await errorOf(res)).code).toBe("host_key_changed");
    expect(h.commands).toEqual([]);
  });

  test("no tombstone answers 404 and a live link answers 409, both without SSH", async () => {
    const h = harness([link()]);
    const live = await h.request("POST", "/api/link/recover", { linkId: ID });
    expect(live.status).toBe(409);
    expect((await errorOf(live)).code).toBe("link_present");
    const missing = await h.request("POST", "/api/link/recover", { linkId: OTHER });
    expect(missing.status).toBe(404);
    expect((await errorOf(missing)).code).toBe("tombstone_not_found");
    expect(h.commands).toEqual([]);
  });

  test.each([{}, { linkId: "nope" }, { linkId: ID, operationId: "op-1" }, { linkId: ID, extra: true }, { operationId: "" }])(
    "an invalid body %j answers 400", async body => {
      const h = harness([]);
      const res = await h.request("POST", "/api/link/recover", body);
      expect(res.status).toBe(400);
    },
  );

  test("an operation id needs the enrollment journal; with it, recover cleans that operation's Child", async () => {
    const h = harness([]);
    const unavailable = await h.request("POST", "/api/link/recover", { operationId: "attach-1" });
    expect(unavailable.status).toBe(409);
    expect((await errorOf(unavailable)).code).toBe("operation_journal_unavailable");

    const settled: string[] = [];
    const unregister = registerOperationRecoveryResolver({
      lookup: id => id === "attach-1"
        ? { kind: "target", target: { linkId: ID, alias: "devbox", hostKeyFingerprint: FINGERPRINT, remotePlatform: "posix" } }
        : { kind: "not_found" },
      settle: id => { settled.push(id); },
    });
    try {
      const missing = await h.request("POST", "/api/link/recover", { operationId: "attach-2" });
      expect(missing.status).toBe(404);
      expect((await errorOf(missing)).code).toBe("operation_not_found");
      const res = await h.request("POST", "/api/link/recover", { operationId: "attach-1" });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ linkId: ID, outcome: "clean", purged: true });
      expect(settled).toEqual(["attach-1"]);
      expect(h.commands.at(-1)).toContain("'--expect-link' '" + ID + "'");
    } finally { unregister(); }
  });
});

