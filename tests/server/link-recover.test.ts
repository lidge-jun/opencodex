import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { inflateRawSync } from "node:zlib";
import { join } from "node:path";
import { handleLinkRoutes, type LinkRouteState } from "../../src/server/management/link-routes";
import type { ManagementContext } from "../../src/server/management/context";
import type { OcxConfig } from "../../src/types";
import type { LinkRecord, LinkStore } from "../../src/link/store";
import type { SshRunner, SshRunResult } from "../../src/link/ssh-runner";
import { keyFingerprint } from "../../src/link/route-trust";
import { MAX_TOMBSTONES, recordTombstone, tombstonesPath } from "../../src/link/tombstones";
import { serialized } from "../../src/server/management/link-enrollment";
import { registerOperationRecoveryResolver } from "../../src/link/operation-recovery-slot";
import { POSIX_RECOVER_RECEIPT_SCRIPT, remoteManagedPurgeDisconnectArgv, remotePurgePlantedChildArgv, remoteRecoverReceiptArgv } from "../../src/link/remote-plant";
import { windowsScriptData } from "../../src/link/remote-windows";
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

function harness(links: LinkRecord[], opts: { keyRevokeFails?: boolean; storeWriteFails?: boolean; duringKeyRevoke?: (other: { dropLink(): void }) => void; duringStop?: () => void; operationsPath?: string; holdThrows?: boolean } = {}) {
  const config: OcxConfig = { port: 10100, hostname: "127.0.0.1", runtimeRole: "standalone", defaultProvider: "mock", providers: {},
    apiKeys: (opts.keyRevokeFails ? [{ id: "fixture-key" }] : []) as OcxConfig["apiKeys"] };
  const knownHosts = join(root, "known_hosts");
  writeFileSync(knownHosts, "devbox ssh-ed25519 " + HOST_KEY + "\n");
  let store: LinkStore = { version: 1, listenerPort: 18181, links };
  const commands: string[] = [];
  let answer: () => SshRunResult = () => report({ restored: true, outcome: "ExactRestore", daemonRunning: false, purged: true, linkId: ID });
  const storedReceipt = (body: Record<string, unknown>) => ok(JSON.stringify({ schema: "ocx.child.detach-receipt/1", linkId: ID, restored: true, outcome: "ExactRestore", ...body }) + "\n");
  let absent: () => SshRunResult = () => storedReceipt({});
  let probes: string[] | null = null;
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
      start() {}, ensureStarted: async () => {}, reload: async () => {}, holdLink: () => { if (opts.holdThrows) throw new Error("hold failed"); return () => {}; },
      stopLink: async () => { opts.duringStop?.(); }, reconnect: async () => true, status: () => [], stop: async () => {},
    },
  };
  const runner: SshRunner = {
    async run(argv) {
      const command = argv.at(-1) ?? "";
      commands.push(argv.join(" "));
      if (command.includes("ocx-recover-receipt")) return absent();
      if (!command.includes("ocx-managed-purge")) {
        // Platform discovery for a tombstone without a recorded platform: not Windows, then uname.
        if (probes) { probes.push(argv.join(" ")); return probes.length === 1 ? ok("", 1) : ok("Linux\n"); }
        throw new Error("Unexpected SSH command: " + command);
      }
      return answer();
    },
    spawnTunnel() { throw new Error("unused"); },
  };
  const deps: ManagementContext["deps"] = {
    now: () => 1_800_000_000_000,
    linkAliasLock: { waitMs: 0 },
    ...(opts.operationsPath ? { linkOperationsPath: () => opts.operationsPath! } : {}),
    sshRunner: runner,
    readLinkStore: () => store,
    writeLinkStore: next => { if (opts.storeWriteFails) throw new Error("disk full"); store = next; },
    linkKnownHostsPath: () => knownHosts,
    revokeApiKey: (cfg, id) => { opts.duringKeyRevoke?.({ dropLink: () => { store = { ...store, links: store.links.filter(l => l.id !== ID) }; } }); if (opts.keyRevokeFails) return false; cfg.apiKeys = (cfg.apiKeys ?? []).filter(k => k.id !== id); return true; },
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
    receipt(next: () => SshRunResult) { absent = next; },
    allowPlatformProbe() { probes = []; return probes; },
    storedReceipt,
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
      routes: ["devbox-direct", "devbox"], revokedAt: new Date(1_800_000_000_000).toISOString(), attempt: expect.stringMatching(/^[0-9a-f]{16}$/),
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

  test("a damaged tombstone file refuses the forced revoke and keeps the link, before the tunnel is touched", async () => {
    let stopped = false;
    const h = harness([link()], { duringStop: () => { stopped = true; } });
    await Bun.write(tombstonesPath(), "{damaged");
    const res = await h.request("DELETE", "/api/link/" + ID, { force: true });
    expect(res.status).toBe(503);
    expect((await errorOf(res)).code).toBe("tombstone_write_failed");
    expect(h.store.links.map(l => l.id)).toEqual([ID]);
    expect(stopped).toBe(false);
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
    // The in-use marker settles only a report bound to this link: the link check comes first.
    ["a kept binary with the in-use marker, reported for another link", ok(JSON.stringify({ restored: true, outcome: "ExactRestore", daemonRunning: false, purged: false, linkId: OTHER }) + "\n", 0, "ocx-purge-kept:binary_in_use\n"), "receipt_unbound"],
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


describe("recover after a lost receipt and with remote failures", () => {
  const missing = () => ok("", 1, "ocx-purge-error:managed_child_missing\n");

  test("a purge whose answer was lost settles on the Child's durable receipt for that link", async () => {
    const h = harness([link()]);
    await forceRevoke(h);
    h.answer(missing);
    const res = await h.request("POST", "/api/link/recover", { linkId: ID });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ linkId: ID, outcome: "clean", purged: true });
    expect(tombstones()).toEqual([]);
    expect(h.commands).toHaveLength(2);
    expect(h.commands[1]).toContain("HostKeyAlias=devbox");
    expect(h.commands[1]).toContain("'ocx-recover-receipt' '" + ID + "'");
  });

  test.each([
    ["no receipt", () => ok("", 4), "managed_child_missing"],
    ["a receipt for another link", () => ok(JSON.stringify({ schema: "ocx.child.detach-receipt/1", linkId: OTHER, restored: true, outcome: "ExactRestore" }) + "\n"), "managed_child_missing"],
    ["a receipt of another schema", () => ok(JSON.stringify({ linkId: ID, restored: true }) + "\n"), "managed_child_missing"],
    ["a receipt that does not say restored", () => ok(JSON.stringify({ schema: "ocx.child.detach-receipt/1", linkId: ID, outcome: "ExactRestore" }) + "\n"), "managed_child_missing"],
  ])("a missing binary with %s keeps the tombstone", async (_name, stored, hint) => {
    const h = harness([link()]);
    await forceRevoke(h);
    h.answer(missing);
    h.receipt(stored);
    const res = await h.request("POST", "/api/link/recover", { linkId: ID });
    expect(res.status).toBe(502);
    expect(await errorOf(res)).toMatchObject({ code: "remote_recover_failed", hint });
    expect(tombstones().map(t => t.linkId)).toEqual([ID]);
  });

  test.each([
    [1, "child_failed"],
    [255, "ssh_failed"],
  ])("exit %d answers the fixed hint %s and never the machine's stderr", async (code, hint) => {
    const h = harness([link()]);
    await forceRevoke(h);
    h.answer(() => ok("", code, "detach failed: cannot open /home/someone/.codex/config.toml: denied\n"));
    const res = await h.request("POST", "/api/link/recover", { linkId: ID });
    expect(res.status).toBe(502);
    const error = await errorOf(res);
    expect(error).toMatchObject({ code: "remote_recover_failed", hint });
    expect(JSON.stringify(error)).not.toContain("someone");
    expect(tombstones().map(t => t.linkId)).toEqual([ID]);
  });

  test("the receipt read only reads, and takes the link id as an argument, never as script text", () => {
    expect(POSIX_RECOVER_RECEIPT_SCRIPT).not.toMatch(/\brm\b|\bexec\b|detach|--purge/);
    expect(POSIX_RECOVER_RECEIPT_SCRIPT).not.toMatch(/^\s*"\$bin\/ocx-child"/m);
    expect(remoteRecoverReceiptArgv("posix", ID)).toEqual(["sh", "-c", POSIX_RECOVER_RECEIPT_SCRIPT, "ocx-recover-receipt", ID]);
    expect(() => remoteRecoverReceiptArgv("posix", "lnk_$(id)")).toThrow();
    expect(() => remoteRecoverReceiptArgv("windows", "lnk_'x")).toThrow();
    expect(remoteRecoverReceiptArgv("windows", ID).join(" ").length).toBeLessThanOrEqual(8000);
  });
});

test.skipIf(process.platform === "win32")("the POSIX receipt read prints only a regular receipt file for that link", () => {
  const home = join(root, "child-home");
  const receipts = join(home, "link-receipts");
  mkdirSync(receipts, { recursive: true });
  const body = JSON.stringify({ schema: "ocx.child.detach-receipt/1", linkId: ID, restored: true, outcome: "ExactRestore" });
  writeFileSync(join(receipts, ID + ".json"), body + "\n");
  const run = (linkId: string) => Bun.spawnSync(remoteRecoverReceiptArgv("posix", linkId), { env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: root, OPENCODEX_HOME: home } });
  const found = run(ID);
  expect(found.exitCode).toBe(0);
  expect(found.stdout.toString().trim()).toBe(body);
  expect(run(OTHER).exitCode).toBe(4);
  symlinkSync(join(receipts, ID + ".json"), join(receipts, OTHER + ".json"));
  expect(run(OTHER).exitCode).toBe(4);
});

describe.skipIf(process.platform === "win32")("POSIX plant scripts keep a binary another relay uses", () => {
  function fakeHome(behaviour: "keep" | "remove") {
    const home = join(root, "plant-home-" + behaviour);
    const bin = join(home, ".cache", "opencodex", "bin");
    mkdirSync(bin, { recursive: true });
    const dest = join(bin, "ocx-child");
    // A stand-in for ocx-child detach --purge: either it removed itself, or it kept the binary
    // because another home's relay holds the in-use lock (purged:false, exit 0).
    writeFileSync(dest, behaviour === "remove"
      ? "#!/bin/sh\nrm -f \"$0\"\necho '{\"restored\":true,\"outcome\":\"NotAttached\",\"daemonRunning\":false,\"purged\":true}'\n"
      : "#!/bin/sh\necho '{\"restored\":true,\"outcome\":\"NotAttached\",\"daemonRunning\":false,\"purged\":false}'\n", { mode: 0o755 });
    return { home, bin, dest };
  }
  const env = (home: string) => ({ PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, OPENCODEX_HOME: join(home, ".opencodex"), CODEX_HOME: join(home, ".codex") });

  test("the enrollment rollback purge leaves a binary the Child kept", () => {
    const kept = fakeHome("keep");
    const run = Bun.spawnSync(remotePurgePlantedChildArgv("posix"), { env: env(kept.home) });
    expect(run.exitCode).toBe(0);
    expect(existsSync(kept.dest)).toBe(true);
    const removed = fakeHome("remove");
    expect(Bun.spawnSync(remotePurgePlantedChildArgv("posix"), { env: env(removed.home) }).exitCode).toBe(0);
    expect(existsSync(removed.dest)).toBe(false);
  });

  test("a receipt proves nothing while a planted file remains or its directory cannot be read", () => {
    const home = join(root, "receipt-home");
    const receipts = join(home, ".opencodex", "link-receipts");
    mkdirSync(receipts, { recursive: true });
    writeFileSync(join(receipts, ID + ".json"), JSON.stringify({ schema: "ocx.child.detach-receipt/1", linkId: ID, restored: true }) + "\n");
    const bin = join(home, ".cache", "opencodex", "bin");
    mkdirSync(bin, { recursive: true });
    const read = () => Bun.spawnSync(remoteRecoverReceiptArgv("posix", ID), { env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home } }).exitCode;
    expect(read()).toBe(0);
    writeFileSync(join(bin, "ocx-child"), "not executable", { mode: 0o644 });
    expect(read()).toBe(4);
    rmSync(join(bin, "ocx-child"));
    if (process.getuid?.() !== 0) {
      chmodSync(bin, 0o000);
      try { expect(read()).toBe(4); } finally { chmodSync(bin, 0o700); }
      // An unsearchable ancestor hides a binary that is still there.
      writeFileSync(join(bin, "ocx-child"), "#!/bin/sh\n", { mode: 0o755 });
      const ancestor = join(home, ".cache", "opencodex");
      chmodSync(ancestor, 0o000);
      try { expect(read()).toBe(4); } finally { chmodSync(ancestor, 0o700); }
      rmSync(join(bin, "ocx-child"));
      chmodSync(home, 0o600);
      try { expect(read()).toBe(4); } finally { chmodSync(home, 0o700); }
      expect(read()).toBe(0);
    }
  });
});

test("the Windows scripts keep a kept binary and require the planted binary to be absent", () => {
  const decode = (argv: string[]) => {
    const outer = Buffer.from(argv.at(-1)!, "base64").toString("utf16le");
    const packed = /\$ocxPacked='([^']+)'/.exec(outer)![1]!;
    return inflateRawSync(Buffer.from(Array.from(packed, ch => ch.charCodeAt(0) - 256))).toString("utf8");
  };
  const rollback = decode(remotePurgePlantedChildArgv("windows"));
  expect(rollback).not.toMatch(/detach --purge'\)\);if\(\$rc -ne 0\)\{exit \$rc\};try\{\[IO\.File\]::Delete\(\$dst\)\}/);
  expect(rollback).toContain("kept the planted binary");
  const receipt = decode(remoteRecoverReceiptArgv("windows", ID));
  expect(receipt).toContain("ocx-child.exe");
  expect(receipt).toContain("exit 4");
});

test("the Windows recover scripts carry the link id as data, never spliced into their source", () => {
  const outer = (argv: string[]) => Buffer.from(argv.at(-1)!, "base64").toString("utf16le");
  const source = (argv: string[]) => {
    const packed = /\$ocxPacked='([^']+)'/.exec(outer(argv))![1]!;
    return inflateRawSync(Buffer.from(Array.from(packed, ch => ch.charCodeAt(0) - 256))).toString("utf8");
  };
  const receipt = remoteRecoverReceiptArgv("windows", ID);
  expect(windowsScriptData(outer(receipt))).toEqual({ args: [ID] });
  expect(source(receipt)).toContain("$f=\"$h\\link-receipts\\\"+[string]$d.args[0]+\".json\"");
  expect(source(receipt).replace(/\$d=\[Text\.Encoding\][^\n]*\n/, "")).not.toContain(ID);
  expect(source(receipt)).not.toContain("${linkId}");
  const purge = remoteManagedPurgeDisconnectArgv("windows", ID);
  expect(windowsScriptData(outer(purge))).toEqual({ args: [ID] });
  expect(source(purge).replace(/\$d=\[Text\.Encoding\][^\n]*\n/, "")).not.toContain(ID);
  expect(source(purge)).toContain("' --expect-link '+(Quote-Native ([string]$x[0]))");
  expect(windowsScriptData(outer(remoteManagedPurgeDisconnectArgv("windows")))).toEqual({ args: [] });
});

describe("recover over an exclusive explicit route (O6)", () => {
  const route = { proxyCommand: "/usr/local/bin/pen pipe --node 7f3a 22", user: "builder", port: 22 };
  test("the tombstone keeps the explicit route and recover passes it on the ssh command line", async () => {
    const h = harness([link({ explicitRoute: route, exclusive: true })]);
    await forceRevoke(h);
    expect(tombstones()).toEqual([{
      linkId: ID, alias: "devbox", hostKeyFingerprint: FINGERPRINT, remotePlatform: "posix",
      explicitRoute: route, exclusive: true, revokedAt: new Date(1_800_000_000_000).toISOString(), attempt: expect.stringMatching(/^[0-9a-f]{16}$/),
    }]);
    const res = await h.request("POST", "/api/link/recover", { linkId: ID });
    expect(res.status).toBe(200);
    expect(h.commands).toHaveLength(1);
    expect(h.commands[0]).toContain("ProxyCommand=" + route.proxyCommand);
    expect(h.commands[0]).toContain("User=builder");
    expect(h.commands[0]).toContain("Port=22");
    expect(tombstones()).toEqual([]);
  });

  test("an explicit route in a tombstone needs exclusive, as on a link record", async () => {
    await Bun.write(tombstonesPath(), JSON.stringify({ version: 1, tombstones: [{ linkId: ID, alias: "devbox", hostKeyFingerprint: FINGERPRINT, explicitRoute: route, revokedAt: "2026-11-13T00:00:00.000Z" }] }));
    const h = harness([]);
    const res = await h.request("POST", "/api/link/recover", { linkId: ID });
    expect(res.status).toBe(503);
    expect((await errorOf(res)).code).toBe("tombstone_store_unreadable");
  });
});

test("an explicit route also carries the platform probe and the receipt read", async () => {
  const route = { proxyCommand: "/usr/local/bin/pen pipe --node 7f3a 22", user: "builder", port: 22 };
  const h = harness([link({ explicitRoute: route, exclusive: true, remotePlatform: undefined })]);
  await forceRevoke(h);
  const probes = h.allowPlatformProbe();
  h.answer(() => ok("", 1, "ocx-purge-error:managed_child_missing\n"));
  const res = await h.request("POST", "/api/link/recover", { linkId: ID });
  expect(res.status).toBe(200);
  expect(probes.length).toBe(2);
  for (const command of [...probes, ...h.commands]) expect(command).toContain("ProxyCommand=" + route.proxyCommand);
  expect(h.commands.some(command => command.includes("ocx-recover-receipt"))).toBe(true);
});

describe("tombstone bound, cleanup and the operator's way out", () => {
  const OTHER_ID = "lnk_00000000000000ff";
  const tombstone = (linkId: string, alias = "gone-vm") => ({ linkId, alias, hostKeyFingerprint: FINGERPRINT, revokedAt: "2026-11-01T00:00:00.000Z" });

  test.each([
    ["the key revoke fails", { keyRevokeFails: true }, 502, "key_revoke_failed"],
    ["the link record cannot be removed", { storeWriteFails: true }, 503, "link_remove_failed"],
  ])("a forced revoke that does not commit because %s keeps the link and drops its tombstone", async (_name, opts, status, code) => {
    const h = harness([link()], opts);
    const res = await h.request("DELETE", "/api/link/" + ID, { force: true });
    expect([res.status, (await errorOf(res)).code]).toEqual([status, code]);
    expect(h.store.links.map(l => l.id)).toEqual([ID]);
    expect(tombstones()).toEqual([]);
  });

  test("a purge revoke that cleans the Child settles a tombstone an earlier forced revoke left", async () => {
    const h = harness([link()]);
    recordTombstone(tombstone(ID, "devbox"));
    const res = await h.request("DELETE", "/api/link/" + ID, { purge: true });
    expect(res.status).toBe(200);
    expect(tombstones()).toEqual([]);
  });

  test("forced revokes beyond the bound are refused, never dropped, and the link stays", async () => {
    for (let i = 0; i < MAX_TOMBSTONES; i++) recordTombstone(tombstone("lnk_" + i.toString(16).padStart(16, "0")));
    const h = harness([link()]);
    const res = await h.request("DELETE", "/api/link/" + ID, { force: true });
    expect([res.status, (await errorOf(res)).code]).toEqual([409, "tombstone_limit"]);
    expect(h.store.links.map(l => l.id)).toEqual([ID]);
    expect(tombstones()).toHaveLength(MAX_TOMBSTONES);
  });

  test("a newer Home's field under ext is kept verbatim and does not refuse forced revokes", async () => {
    mkdirSync(join(root, "link"), { recursive: true, mode: 0o700 });
    writeFileSync(tombstonesPath(), JSON.stringify({ version: 1, tombstones: [{ ...tombstone(OTHER_ID), ext: { attachId: "op-7", journal: { state: "residual" } } }] }), { mode: 0o600 });
    const h = harness([link()]);
    await forceRevoke(h);
    expect(tombstones().map(t => [t.linkId, t.ext])).toEqual([[OTHER_ID, { attachId: "op-7", journal: { state: "residual" } }], [ID, undefined]]);
  });

  test("GET lists what waits without fingerprints; the management API offers no way to forget one", async () => {
    const h = harness([]);
    recordTombstone({ ...tombstone(OTHER_ID), remotePlatform: "windows" });
    const listed = await h.request("GET", "/api/link/recover");
    expect(listed.status).toBe(200);
    expect(await listed.json()).toEqual({ tombstones: [{ linkId: OTHER_ID, alias: "gone-vm", revokedAt: "2026-11-01T00:00:00.000Z", remotePlatform: "windows" }] });
    // Forgetting is the CLI's, run by a person on the Home; an admin-token caller cannot reach it.
    const forgot = await h.request("POST", "/api/link/recover", { linkId: OTHER_ID, forget: true });
    expect([forgot.status, (await errorOf(forgot)).code]).toEqual([400, "invalid_body"]);
    expect(tombstones().map(t => t.linkId)).toEqual([OTHER_ID]);
    expect(h.commands).toEqual([]);
  });

  test.each([
    ["another process committed its own forced revoke of the link", true],
    ["another process replaced the tombstone while the link stays, in the same millisecond", false],
  ])("a failed revoke never removes a tombstone it did not write: %s", async (_name, linkGone) => {
    // Identical to what this attempt writes except its random attempt token.
    const theirs = { linkId: ID, alias: "devbox", hostKeyFingerprint: FINGERPRINT, remotePlatform: "posix" as const,
      revokedAt: new Date(1_800_000_000_000).toISOString(), attempt: "0123456789abcdef" };
    const h = harness([link()], { keyRevokeFails: true, duringKeyRevoke: other => { recordTombstone(theirs); if (linkGone) other.dropLink(); } });
    const res = await h.request("DELETE", "/api/link/" + ID, { force: true });
    expect([res.status, (await errorOf(res)).code]).toEqual([502, "key_revoke_failed"]);
    expect(tombstones()).toEqual([theirs]);
  });

  test("operations on one alias are serialized whatever its case", async () => {
    const state = { operations: new Set<string>() } as unknown as LinkRouteState;
    let release!: () => void;
    const held = serialized(state, "Devbox", () => new Promise<Response>(resolve => { release = () => resolve(new Response("first")); }));
    const second = await serialized(state, "devbox", async () => new Response("second"));
    expect([second.status, (await errorOf(second)).code]).toEqual([409, "link_operation_in_progress"]);
    release();
    expect(await (await held).text()).toBe("first");
    expect(await (await serialized(state, "DEVBOX", async () => new Response("third"))).text()).toBe("third");
  });
});

describe("recover and a legacy enrollment or revoke of the same alias in another runtime", () => {
  test("while a tombstone names the alias, apply and revoke there take the alias lock recover holds", async () => {
    const h = harness([link()]);
    await forceRevoke(h);
    let entered!: () => void, release!: () => void;
    const inSsh = new Promise<void>(resolve => { entered = resolve; });
    h.answer((() => { entered(); return new Promise<SshRunResult>(resolve => { release = () => resolve(report({ restored: true, outcome: "ExactRestore", daemonRunning: false, purged: true, linkId: ID })); }); }) as unknown as () => SshRunResult);
    const recovering = h.request("POST", "/api/link/recover", { linkId: ID });
    await inSsh;
    // Another runtime: its own per-alias operation set, the same Home and lock directory, no operation journal.
    const apply = await harness([]).request("POST", "/api/link/apply", { alias: "DevBox" });
    expect([apply.status, (await errorOf(apply)).message]).toEqual([409, "Another enrollment or revoke of this alias is running; try again when it ends."]);
    const revoke = await harness([link({ id: OTHER, apiKeyId: "other-key" })]).request("DELETE", "/api/link/" + OTHER, {});
    expect([revoke.status, (await errorOf(revoke)).message]).toEqual([409, "Another enrollment or revoke of this alias is running; try again when it ends."]);
    release();
    expect((await recovering).status).toBe(200);
    // With no tombstone left, a legacy apply runs as before (no lock) and stops at its own first check.
    const after = await harness([]).request("POST", "/api/link/apply", { alias: "devbox" });
    expect((await errorOf(after)).code).toBe("host_not_confirmed");
  });
});

describe("final review follow-ups", () => {
  test("a Child that restored the link but kept the binary for another home's relay settles the tombstone", async () => {
    const h = harness([link()]);
    await forceRevoke(h);
    h.answer(() => ok(JSON.stringify({ restored: true, outcome: "ExactRestore", daemonRunning: false, purged: false, linkId: ID }) + "\n", 0, "ocx-purge-kept:binary_in_use\n"));
    const res = await h.request("POST", "/api/link/recover", { linkId: ID });
    expect([res.status, await res.json()]).toEqual([200, { linkId: ID, outcome: "clean", purged: false }]);
    expect(tombstones()).toEqual([]);
  });

  test("a throw after the early tombstone write (stopLink rejecting) drops that tombstone and keeps the link", async () => {
    const h = harness([link()], { duringStop: () => { throw new Error("tunnel kill failed"); } });
    await expect(h.request("DELETE", "/api/link/" + ID, { force: true })).rejects.toThrow("tunnel kill failed");
    expect(h.store.links.map(l => l.id)).toEqual([ID]);
    expect(tombstones()).toEqual([]);
  });

  test("a throw while taking the tunnel hold drops the tombstone and keeps the link", async () => {
    const h = harness([link()], { holdThrows: true });
    await expect(h.request("DELETE", "/api/link/" + ID, { force: true })).rejects.toThrow("hold failed");
    expect(h.store.links.map(l => l.id)).toEqual([ID]);
    expect(tombstones()).toEqual([]);
  });

  test("a journal write that fails before the link goes drops the tombstone the forced revoke wrote", async () => {
    const operationsPath = join(root, "operations.json");
    const h = harness([link()], { operationsPath, duringStop: () => { writeFileSync(operationsPath, "{ not json"); } });
    const res = await h.request("DELETE", "/api/link/" + ID, { force: true, operationId: "revoke-1" });
    expect([res.status, ((await res.json()) as { error: { code: string } }).error.code]).toEqual([500, "operation_journal_failed"]);
    expect(h.store.links.map(l => l.id)).toEqual([ID]);
    expect(tombstones()).toEqual([]);
  });
});

describe("recover while another link names the alias", () => {
  test("is refused with 409 before any SSH, whatever the alias's case, and the tombstone stays", async () => {
    const h = harness([link()]);
    await forceRevoke(h);
    // The machine was enrolled again under the same alias (spelled differently), and that link still exists.
    h.store.links.push(link({ id: OTHER, alias: "DevBox" }));
    const res = await h.request("POST", "/api/link/recover", { linkId: ID });
    expect([res.status, (await errorOf(res)).code]).toEqual([409, "alias_linked"]);
    expect(h.commands.filter(c => c.includes("ocx-managed-purge"))).toEqual([]);
    expect(tombstones().map(t => t.linkId)).toEqual([ID]);
  });

  test("a client-initiated link with the same alias does not block it", async () => {
    const h = harness([link()]);
    await forceRevoke(h);
    h.store.links.push(link({ id: OTHER, direction: "client-initiated" }));
    const res = await h.request("POST", "/api/link/recover", { linkId: ID });
    expect(res.status).toBe(200);
    expect(tombstones()).toEqual([]);
  });
});
