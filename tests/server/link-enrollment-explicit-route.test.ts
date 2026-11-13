import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleLinkRoutes, type LinkRouteState } from "../../src/server/management/link-routes";
import type { ManagementContext } from "../../src/server/management/context";
import type { OcxConfig } from "../../src/types";
import type { LinkStore } from "../../src/link/store";
import type { SshRunner, SshRunResult } from "../../src/link/ssh-runner";
import { quoteRemote, remoteOcxArgv, WINDOWS_OS_PROBE } from "../../src/link/ssh-argv";
import { resetSharedChildOpsEngineForTests, sharedChildOpsEngine } from "../../src/link/child-ops-engine";
import { operationsJournalPath } from "../../src/link/operations-journal";
import { identityFileRefusal } from "../../src/server/management/link-route-request";
import { removeTreeWithRetry } from "../helpers/remove-tree";

/**
 * O6: an enrollment with an explicit route uses it for every SSH command (probe, confirm, apply,
 * revoke), stores it on the link, and refuses a confirm or apply that names another route.
 */
const ROUTE = { proxyCommand: "/usr/local/bin/pen pipe --node 7f3a9c --noise noise-pub-7f3a9c 22", user: "ubuntu", port: 22 };
const OTHER = { ...ROUTE, port: 2222 };
const fingerprint = "SHA256:abcdefghijklmnop";
const ALIAS = "pen-7f3a9c";

let root = "";
let previousHome: string | undefined;
beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  root = mkdtempSync(join(tmpdir(), "ocx-explicit-enroll-"));
  process.env.OPENCODEX_HOME = root;
});
afterEach(async () => {
  await sharedChildOpsEngine().settled?.();
  resetSharedChildOpsEngineForTests();
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  removeTreeWithRetry(root);
});

const ok = (stdout = ""): SshRunResult => ({ code: 0, stdout, stderr: "" });
const http = (body: unknown) => ok(JSON.stringify(body) + "\n200");

function sshOption(argv: readonly string[], name: string): string[] {
  return argv.filter((value, index) => argv[index - 1] === "-o" && value.startsWith(name + "=")).map(value => value.slice(name.length + 1));
}

function harness() {
  const remoteOcx = (args: string[]) => quoteRemote(remoteOcxArgv(args, "posix"));
  const config: OcxConfig = { port: 10100, hostname: "127.0.0.1", runtimeRole: "standalone", defaultProvider: "mock", providers: {}, apiKeys: [] };
  const knownHosts = join(root, "known_hosts");
  let store: LinkStore = { version: 1, listenerPort: 18181, links: [] };
  let restarted = false;
  let keyId = "";
  const callbacks = new Set<(id: string) => void>();
  const ssh: Array<{ step: string; argv: readonly string[] }> = [];
  const state: LinkRouteState = {
    pendingHosts: new Map(), confirmedHosts: new Map(), operations: new Set(),
    listener: {
      ensureStarted: async () => {}, status: () => ({ state: "listening", port: 18181, reason: null }), close: async () => {},
      onAuthenticatedCatalog: callback => { callbacks.add(callback); return () => { callbacks.delete(callback); }; },
    },
    supervisor: {
      start() {}, ensureStarted: async () => {}, reload: async () => {}, stopLink: async () => {},
      reconnect: async () => true, status: () => [], stop: async () => {},
    },
  };
  const runner: SshRunner = {
    async run(argv, options) {
      const command = argv.at(-1) ?? "";
      if (argv[0] === "ssh-keygen") return ok("256 " + fingerprint + " child (ED25519)");
      const step = command === "echo ocx-link-probe" ? "probe"
        : command === WINDOWS_OS_PROBE ? "windows"
        : command.includes("ocx-platform") ? "uname"
        : command === remoteOcx(["--version"]) ? "version"
        : command === remoteOcx(["link", "port"]) ? "port"
        : command === remoteOcx(["config", "show", "--json"]) ? "config"
        : command.includes("ocx-curl-preflight") ? "curl"
        : command.includes("'connect' '--link' '--key-stdin'") ? "connect"
        : command === remoteOcx(["restart"]) ? "restart"
        : command.includes("'disconnect' '--expect-link'") ? "disconnect"
        : command.includes("'ocx-child-http' '10100' 'healthz'") ? (restarted ? "health" : "before")
        : command.includes("'ocx-child-http' '10100' 'v1/catalog'") ? "catalog"
        : (() => { throw new Error("Unexpected SSH command: " + command.slice(0, 80)); })();
      ssh.push({ step, argv: [...argv] });
      switch (step) {
        case "probe": {
          const file = argv.find(arg => arg.startsWith("UserKnownHostsFile="))!.slice("UserKnownHostsFile=".length);
          writeFileSync(file, ALIAS + " ssh-ed25519 AAAA\n");
          return ok("ocx-link-probe\n");
        }
        case "windows": return { code: 127, stdout: "", stderr: "sh: cmd: not found" };
        case "uname": return ok("Linux\n");
        case "version": return ok("opencodex 2.99.0\n");
        case "port": return ok('{"port":2200}');
        case "config": return ok('{"port":10100}\n');
        case "connect": {
          keyId = JSON.parse(new TextDecoder().decode(options!.stdin as Uint8Array)).apiKeyId;
          return ok();
        }
        case "restart": restarted = true; return ok();
        case "before": return http({ service: "opencodex", pid: 1, port: 10100, role: "standalone", restartCapability: "v1" });
        case "health": return http({ service: "opencodex", pid: 1, port: 10100, role: "client", restartCapability: "v1" });
        case "catalog": for (const callback of callbacks) callback(keyId); return http({ models: [{ id: "m" }] });
        default: return ok();
      }
    },
    spawnTunnel() { throw new Error("no tunnel in enrollment tests"); },
  };
  const deps: ManagementContext["deps"] = {
    now: () => 1_800_000_000_000, sshRunner: runner,
    readLinkStore: () => structuredClone(store), writeLinkStore: next => { store = structuredClone(next); },
    linkKnownHostsPath: () => knownHosts, liveListenPort: () => 10100,
    issueApiKey: (cfg, name, id) => { const key = { id: id ?? "fixture-key-1", name, key: "fixture-child-key", createdAt: "2026-11-13T00:00:00Z" }; cfg.apiKeys = [key]; return key; },
    revokeApiKey: cfg => { cfg.apiKeys = []; return true; },
  };
  async function call(method: "POST" | "DELETE", route: string, body: unknown) {
    const url = new URL("http://127.0.0.1:10100/api/link/" + route);
    const context: ManagementContext = {
      req: new Request(url, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
      url, config, deps, version: "2.99.0", principal: "admin-token", trustedLoopbackIngress: true, guiSessionIssuance: null,
      sessionControl: { isCurrent: () => true, isPaired: () => false, revokeCurrent: () => true },
      convergeCodexCatalog: async () => { throw new Error("no catalog convergence here"); },
      syncClaudeAgentDefsBestEffort: async () => {},
    };
    const response = await handleLinkRoutes(context, state);
    if (!response) throw new Error("route not handled");
    return { status: response.status, body: await response.json() as Record<string, unknown> };
  }
  return { call, ssh, state, get store() { return store; } };
}

const routed = { explicitRoute: ROUTE, exclusive: true };
const code = (answer: { body: Record<string, unknown> }) => (answer.body.error as { code?: string } | undefined)?.code;

test("every SSH command of an enrollment with an explicit route carries it, and the link keeps it", async () => {
  const h = harness();
  expect((await h.call("POST", "probe", { alias: ALIAS, includeVersion: true, ...routed })).status).toBe(200);
  expect((await h.call("POST", "confirm-host", { alias: ALIAS, fingerprint, ...routed })).status).toBe(200);
  const applied = await h.call("POST", "apply", { alias: ALIAS, fingerprint, ...routed });
  expect(applied.status).toBe(202);
  expect(h.ssh.map(call => call.step)).toEqual(["probe", "windows", "uname", "version", "version", "port", "config", "curl", "before", "connect", "restart", "health", "catalog"]);
  for (const call of h.ssh) {
    expect({ step: call.step, proxy: sshOption(call.argv, "ProxyCommand"), user: sshOption(call.argv, "User"), port: sshOption(call.argv, "Port") })
      .toEqual({ step: call.step, proxy: [ROUTE.proxyCommand], user: ["ubuntu"], port: ["22"] });
  }
  expect(h.store.links).toHaveLength(1);
  expect(h.store.links[0]).toMatchObject({ alias: ALIAS, explicitRoute: ROUTE, exclusive: true });

  const before = h.ssh.length;
  const revoked = await h.call("DELETE", String(h.store.links[0]!.id), {});
  expect(revoked.status).toBe(200);
  const disconnect = h.ssh.slice(before);
  expect(disconnect.map(call => call.step)).toEqual(["disconnect"]);
  expect(sshOption(disconnect[0]!.argv, "ProxyCommand")).toEqual([ROUTE.proxyCommand]);
});

test("a confirm or apply that names another route than the probe is refused", async () => {
  const h = harness();
  await h.call("POST", "probe", { alias: ALIAS, includeVersion: true, ...routed });
  const probes = h.ssh.length;
  for (const body of [{ alias: ALIAS, fingerprint }, { alias: ALIAS, fingerprint, explicitRoute: OTHER, exclusive: true }, { alias: ALIAS, fingerprint, exclusive: true }]) {
    const refused = await h.call("POST", "confirm-host", body);
    expect({ status: refused.status, code: code(refused) }).toEqual({ status: 409, code: "route_mismatch" });
  }
  expect(h.ssh.length).toBe(probes);
  expect((await h.call("POST", "confirm-host", { alias: ALIAS, fingerprint, ...routed })).status).toBe(200);
  const confirmed = h.ssh.length;
  const applied = await h.call("POST", "apply", { alias: ALIAS, fingerprint, explicitRoute: OTHER, exclusive: true });
  expect({ status: applied.status, code: code(applied) }).toEqual({ status: 409, code: "route_mismatch" });
  const plain = await h.call("POST", "apply", { alias: ALIAS, fingerprint });
  expect({ status: plain.status, code: code(plain) }).toEqual({ status: 409, code: "route_mismatch" });
  expect(h.ssh.length).toBe(confirmed);
  expect(h.store.links).toEqual([]);
});

test("a host probed without a route cannot be confirmed with one", async () => {
  const h = harness();
  await h.call("POST", "probe", { alias: ALIAS, includeVersion: true });
  expect(sshOption(h.ssh[0]!.argv, "ProxyCommand")).toEqual([]);
  const refused = await h.call("POST", "confirm-host", { alias: ALIAS, fingerprint, ...routed });
  expect({ status: refused.status, code: code(refused) }).toEqual({ status: 409, code: "route_mismatch" });
});

test.each([
  ["a shell word in the command", { explicitRoute: { ...ROUTE, proxyCommand: "/usr/bin/pen pipe; id" }, exclusive: true }, "invalid_explicit_route", "proxy_command_form"],
  ["a % token in the command", { explicitRoute: { ...ROUTE, proxyCommand: "/usr/bin/pen %h" }, exclusive: true }, "invalid_explicit_route", "proxy_command_form"],
  ["an option as the user", { explicitRoute: { ...ROUTE, user: "-oProxyCommand=x" }, exclusive: true }, "invalid_explicit_route", "user_form"],
  ["port zero", { explicitRoute: { ...ROUTE, port: 0 }, exclusive: true }, "invalid_explicit_route", "port_form"],
  ["no exclusive flag", { explicitRoute: ROUTE }, "explicit_route_requires_exclusive", undefined],
  ["exclusive false", { exclusive: false }, "invalid_body", undefined],
] as const)("a probe with %s is refused before any SSH", async (_label, extra, expected, hint) => {
  const h = harness();
  const refused = await h.call("POST", "probe", { alias: ALIAS, includeVersion: true, ...extra });
  expect({ status: refused.status, code: code(refused), hint: (refused.body.error as { hint?: string }).hint })
    .toEqual({ status: 400, code: expected, hint });
  expect(h.ssh).toEqual([]);
  expect(h.state.pendingHosts.size).toBe(0);
});

/**
 * O7 (link.route/2): the route may name the private key the link authenticates with. Every SSH command of the link offers
 * that key alone, the path is kept on the link, and the file is checked (never read) when a request names it.
 */
const KEY_CANARY = "PRIVATE-KEY-CANARY-NEVER-READ";
// A Windows Home refuses every identity file before the checks below (identity_file_unsupported_platform), so the cases that
// exercise those checks, or a keyed enrollment, run on POSIX only; the Windows refusal has its own cases.
const WINDOWS = process.platform === "win32";
const posixTest = test.skipIf(WINDOWS);
function keyFile(mode = 0o600, name = "goat_hub_ed25519"): string {
  const path = join(root, name);
  writeFileSync(path, KEY_CANARY + "\n");
  chmodSync(path, mode);
  return path;
}
/** A private key file in its own directory with the given mode: another user who can write there could replace the key. */
function keyInDirectory(directoryMode: number): string {
  const dir = join(root, "keys");
  mkdirSync(dir);
  const path = join(dir, "goat_hub_ed25519");
  writeFileSync(path, KEY_CANARY + "\n");
  chmodSync(path, 0o600);
  chmodSync(dir, directoryMode);
  return path;
}

posixTest("every SSH command of an enrollment with an identity file offers that key alone, and the link keeps the path", async () => {
  const h = harness();
  const key = keyFile();
  const keyed = { explicitRoute: { ...ROUTE, identityFile: key }, exclusive: true };
  expect((await h.call("POST", "probe", { alias: ALIAS, includeVersion: true, ...keyed })).status).toBe(200);
  expect((await h.call("POST", "confirm-host", { alias: ALIAS, fingerprint, ...keyed })).status).toBe(200);
  const applied = await h.call("POST", "apply", { alias: ALIAS, fingerprint, ...keyed });
  expect(applied.status).toBe(202);
  expect(h.ssh.length).toBeGreaterThan(5);
  for (const call of h.ssh) {
    expect({ step: call.step, only: sshOption(call.argv, "IdentitiesOnly"), agent: sshOption(call.argv, "IdentityAgent"), file: sshOption(call.argv, "IdentityFile") })
      .toEqual({ step: call.step, only: ["yes"], agent: ["none"], file: [key] });
  }
  expect(h.store.links[0]).toMatchObject({ explicitRoute: { ...ROUTE, identityFile: key }, exclusive: true });
  const before = h.ssh.length;
  expect((await h.call("DELETE", String(h.store.links[0]!.id), {})).status).toBe(200);
  expect(h.ssh.slice(before).map(call => ({ step: call.step, file: sshOption(call.argv, "IdentityFile") }))).toEqual([{ step: "disconnect", file: [key] }]);
  expect(JSON.stringify(applied.body)).not.toContain(KEY_CANARY);
});

posixTest("a confirm or apply that names another identity file than the probe is refused", async () => {
  const h = harness();
  const key = keyFile();
  const other = keyFile(0o600, "other_ed25519");
  await h.call("POST", "probe", { alias: ALIAS, includeVersion: true, explicitRoute: { ...ROUTE, identityFile: key }, exclusive: true });
  const probes = h.ssh.length;
  for (const explicitRoute of [ROUTE, { ...ROUTE, identityFile: other }]) {
    const refused = await h.call("POST", "confirm-host", { alias: ALIAS, fingerprint, explicitRoute, exclusive: true });
    expect({ status: refused.status, code: code(refused) }).toEqual({ status: 409, code: "route_mismatch" });
  }
  expect(h.ssh.length).toBe(probes);
});

posixTest.each([
  ["a missing file", (path: string) => path + ".gone", "identity_file_missing"],
  ["a symlink", (path: string) => { const link = path + ".link"; symlinkSync(path, link); return link; }, "identity_file_not_regular"],
  ["a directory", () => root, "identity_file_not_regular"],
  ["a file group or others can read", (path: string) => { chmodSync(path, 0o640); return path; }, "identity_file_permissions"],
  ["a file this user cannot read", (path: string) => { chmodSync(path, 0o200); return path; }, "identity_file_unreadable"],
  ["in a directory its group can write", () => keyInDirectory(0o770), "identity_file_directory"],
  ["in a directory others can write", () => keyInDirectory(0o707), "identity_file_directory"],
] as const)("a probe whose identity file is %s is refused before any SSH, without reading it", async (_label, pick, hint) => {
  if (hint === "identity_file_unreadable" && process.getuid?.() === 0) return;
  const h = harness();
  const identityFile = pick(keyFile());
  const refused = await h.call("POST", "probe", { alias: ALIAS, includeVersion: true, explicitRoute: { ...ROUTE, identityFile }, exclusive: true });
  expect({ status: refused.status, code: code(refused), hint: (refused.body.error as { hint?: string }).hint }).toEqual({ status: 400, code: "invalid_identity_file", hint });
  expect(h.ssh).toEqual([]);
  expect(JSON.stringify(refused.body)).not.toContain(KEY_CANARY);
});

test("an identity file that is not an accepted path form is refused with the route's own code", async () => {
  const h = harness();
  const refused = await h.call("POST", "probe", { alias: ALIAS, includeVersion: true, explicitRoute: { ...ROUTE, identityFile: "~/.ssh/id_ed25519" }, exclusive: true });
  expect({ status: refused.status, code: code(refused), hint: (refused.body.error as { hint?: string }).hint }).toEqual({ status: 400, code: "invalid_explicit_route", hint: "identity_file_form" });
  expect(h.ssh).toEqual([]);
});

posixTest("a repeat of a journalled enrollment replays its outcome after its key file is gone, and another key answers operation_mismatch", async () => {
  const h = harness();
  const key = keyFile();
  const keyed = { explicitRoute: { ...ROUTE, identityFile: key }, exclusive: true };
  await h.call("POST", "probe", { alias: ALIAS, includeVersion: true, ...keyed });
  await h.call("POST", "confirm-host", { alias: ALIAS, fingerprint, ...keyed });
  const applied = await h.call("POST", "apply", { alias: ALIAS, fingerprint, operationId: "op-keyed", ...keyed });
  expect(applied.status).toBe(202);
  // The answer was lost, and the caller's key went away (or its permissions changed) before the repeat.
  rmSync(key);
  const before = h.ssh.length;
  const replay = await h.call("POST", "apply", { alias: ALIAS, fingerprint, operationId: "op-keyed", ...keyed });
  expect({ status: replay.status, linkId: replay.body.linkId, outcome: replay.body.outcome }).toEqual({ status: 202, linkId: applied.body.linkId, outcome: "committed" });
  const other = await h.call("POST", "apply", { alias: ALIAS, fingerprint, operationId: "op-keyed", explicitRoute: { ...ROUTE, identityFile: join(root, "gone_ed25519") }, exclusive: true });
  expect({ status: other.status, code: code(other) }).toEqual({ status: 409, code: "operation_mismatch" });
  expect(h.ssh.length).toBe(before);
});

posixTest("a new journalled enrollment whose key file went away after confirm-host is refused before its journal entry and any SSH", async () => {
  const h = harness();
  const key = keyFile();
  const keyed = { explicitRoute: { ...ROUTE, identityFile: key }, exclusive: true };
  await h.call("POST", "probe", { alias: ALIAS, includeVersion: true, ...keyed });
  await h.call("POST", "confirm-host", { alias: ALIAS, fingerprint, ...keyed });
  chmodSync(key, 0o644);
  const before = h.ssh.length;
  const refused = await h.call("POST", "apply", { alias: ALIAS, fingerprint, operationId: "op-new", ...keyed });
  expect({ status: refused.status, code: code(refused), hint: (refused.body.error as { hint?: string }).hint })
    .toEqual({ status: 400, code: "invalid_identity_file", hint: "identity_file_permissions" });
  expect(h.ssh.length).toBe(before);
  expect(existsSync(operationsJournalPath())).toBe(false);
  expect(h.store.links).toEqual([]);
});
test("a Windows Home refuses an identity file with a fixed hint, whatever the file", async () => {
  const refused = identityFileRefusal({ ...ROUTE, identityFile: keyFile() }, "win32")!;
  expect({ status: refused.status, body: await refused.json() }).toEqual({ status: 400, body: { error: { code: "invalid_identity_file",
    message: "A Windows Home does not support an identity file yet.", hint: "identity_file_unsupported_platform" } } });
  expect(identityFileRefusal(ROUTE, "win32")).toBeNull();
});
posixTest("confirm-host checks the identity file again: a key removed after the probe is refused before any new SSH", async () => {
  const h = harness();
  const key = keyFile();
  const keyed = { explicitRoute: { ...ROUTE, identityFile: key }, exclusive: true };
  expect((await h.call("POST", "probe", { alias: ALIAS, includeVersion: true, ...keyed })).status).toBe(200);
  rmSync(key);
  const before = h.ssh.length;
  const refused = await h.call("POST", "confirm-host", { alias: ALIAS, fingerprint, ...keyed });
  expect({ status: refused.status, code: code(refused), hint: (refused.body.error as { hint?: string }).hint })
    .toEqual({ status: 400, code: "invalid_identity_file", hint: "identity_file_missing" });
  expect(h.ssh.length).toBe(before);
  expect(h.state.confirmedHosts?.size ?? 0).toBe(0);
});

posixTest("a key whose directory is private, or owned by this user and only readable by others, is accepted", async () => {
  const h = harness();
  for (const mode of [0o700, 0o755]) {
    rmSync(join(root, "keys"), { recursive: true, force: true });
    const identityFile = keyInDirectory(mode);
    const probed = await h.call("POST", "probe", { alias: ALIAS, includeVersion: true, explicitRoute: { ...ROUTE, identityFile }, exclusive: true });
    expect({ mode: mode.toString(8), status: probed.status }).toEqual({ mode: mode.toString(8), status: 200 });
  }
});
/** A 0600 key in a 0700 directory under one more directory with the given mode: a directory above the key must be safe too. */
function keyUnder(ancestorMode: number): string {
  const shared = join(root, "shared");
  mkdirSync(shared);
  mkdirSync(join(shared, "keys"), { mode: 0o700 });
  const path = join(shared, "keys", "goat_hub_ed25519");
  writeFileSync(path, KEY_CANARY + "\n");
  chmodSync(path, 0o600);
  chmodSync(shared, ancestorMode);
  return path;
}

posixTest.each([
  ["under a directory others can write, which could rename the key's directory away", () => keyUnder(0o777), "identity_file_ancestor"],
  // A home or state folder this user created under umask 002 (Ubuntu or Fedora per-user groups): refused even though the group is
  // the user's own, as sshd's StrictModes does; the fix is chmod g-w on it.
  ["under a 0775 directory this user owns", () => keyUnder(0o775), "identity_file_ancestor"],
  ["reached through a symlink kept in a directory others can write", () => {
    mkdirSync(join(root, "private"), { mode: 0o700 });
    const path = join(root, "private", "goat_hub_ed25519");
    writeFileSync(path, KEY_CANARY + "\n");
    chmodSync(path, 0o600);
    mkdirSync(join(root, "shared"));
    symlinkSync(join(root, "private"), join(root, "shared", "link"));
    chmodSync(join(root, "shared"), 0o777);
    return join(root, "shared", "link", "goat_hub_ed25519");
  }, "identity_file_ancestor"],
  ["in a directory a symlink resolves to, which others can write", () => {
    mkdirSync(join(root, "open"));
    const path = join(root, "open", "goat_hub_ed25519");
    writeFileSync(path, KEY_CANARY + "\n");
    chmodSync(path, 0o600);
    chmodSync(join(root, "open"), 0o777);
    symlinkSync(join(root, "open"), join(root, "keys"));
    return join(root, "keys", "goat_hub_ed25519");
  }, "identity_file_directory"],
] as const)("a probe whose identity file is %s is refused before any SSH", async (_label, pick, hint) => {
  const h = harness();
  const refused = await h.call("POST", "probe", { alias: ALIAS, includeVersion: true, explicitRoute: { ...ROUTE, identityFile: pick() }, exclusive: true });
  expect({ status: refused.status, code: code(refused), hint: (refused.body.error as { hint?: string }).hint })
    .toEqual({ status: 400, code: "invalid_identity_file", hint });
  expect(h.ssh).toEqual([]);
  expect(JSON.stringify(refused.body)).not.toContain(root);
});

posixTest("a key under a sticky directory such as /tmp, in a private directory of its own, is accepted", async () => {
  const h = harness();
  const identityFile = keyUnder(0o1777);
  const probed = await h.call("POST", "probe", { alias: ALIAS, includeVersion: true, explicitRoute: { ...ROUTE, identityFile }, exclusive: true });
  expect(probed.status).toBe(200);
});

posixTest("each refusal says what to fix, the key's own directory apart from a directory above it, and never echoes the path", async () => {
  const h = harness();
  const own = await h.call("POST", "probe", { alias: ALIAS, includeVersion: true, explicitRoute: { ...ROUTE, identityFile: keyInDirectory(0o770) }, exclusive: true });
  rmSync(join(root, "keys"), { recursive: true, force: true });
  const above = await h.call("POST", "probe", { alias: ALIAS, includeVersion: true, explicitRoute: { ...ROUTE, identityFile: keyUnder(0o775) }, exclusive: true });
  const message = (answer: { body: Record<string, unknown> }) => (answer.body.error as { message: string }).message;
  // A key put straight into /tmp gets the same text: it must not read as "remove write access on /tmp" (with sudo, or for a Home
  // running as root, which owns /tmp, that breaks the machine), so moving the key comes first and the chmod is only for a private
  // directory of the user's, never a shared or system one.
  expect(message(own)).toBe("The directory that holds the identity file must be owned by this user or root and not writable by group or others. Move the key to a path that passes; if a tool chose the path, run chmod go-w on that tool's own private folder or have it use a path that passes. Never change a shared or system directory such as /tmp, even when the Home runs as root.");
  expect(message(above)).toBe("Every directory above the identity file must be owned by this user or root and not writable by group or others unless sticky, and every symlink on its path must be owned by this user or root; a folder made under umask 002 is group-writable. Run chmod go-w on such a private folder of this user's or of the tool that chose the path, or use a path that passes. Never change a shared or system directory or another user's symlink, even as root.");
  for (const answer of [own, above]) expect(JSON.stringify(answer.body)).not.toContain(root);
});

posixTest("a path with a symlink loop is refused as unreadable, and the text says the path may have too many symlinks", async () => {
  const h = harness();
  symlinkSync(join(root, "b"), join(root, "a"));
  symlinkSync(join(root, "a"), join(root, "b"));
  const refused = await h.call("POST", "probe", { alias: ALIAS, includeVersion: true, explicitRoute: { ...ROUTE, identityFile: join(root, "a", "goat_hub_ed25519") }, exclusive: true });
  expect({ hint: (refused.body.error as { hint?: string }).hint, message: (refused.body.error as { message?: string }).message })
    .toEqual({ hint: "identity_file_unreadable", message: "This user cannot read the identity file or a directory on its path, or the path is too long or has too many symlinks. Use a shorter path without symlink loops; fix read access only on this user's own file or folder." });
  expect(h.ssh).toEqual([]);
});

test.if(WINDOWS)("on a Windows Home a probe that names an identity file is refused before any SSH", async () => {
  const h = harness();
  const refused = await h.call("POST", "probe", { alias: ALIAS, includeVersion: true, explicitRoute: { ...ROUTE, identityFile: "/keys/goat_hub_ed25519" }, exclusive: true });
  expect({ status: refused.status, code: code(refused), hint: (refused.body.error as { hint?: string }).hint })
    .toEqual({ status: 400, code: "invalid_identity_file", hint: "identity_file_unsupported_platform" });
  expect(h.ssh).toEqual([]);
});

posixTest("a key file another user could chown is not the fix: the permissions text says to use a key of this user's own", async () => {
  const h = harness();
  const refused = await h.call("POST", "probe", { alias: ALIAS, includeVersion: true, explicitRoute: { ...ROUTE, identityFile: keyFile(0o640) }, exclusive: true });
  expect({ hint: (refused.body.error as { hint?: string }).hint, message: (refused.body.error as { message?: string }).message })
    .toEqual({ hint: "identity_file_permissions", message: "The identity file must be owned by this user with no group or other permissions (chmod 600 on it). Use a key file of this user's own; never chown another user's or the system's key." });
});

posixTest("a path with a component too long for the filesystem is refused as unreadable with the same text, before any SSH", async () => {
  const h = harness();
  const refused = await h.call("POST", "probe", { alias: ALIAS, includeVersion: true, explicitRoute: { ...ROUTE, identityFile: join(root, "k".repeat(256)) }, exclusive: true });
  expect({ hint: (refused.body.error as { hint?: string }).hint, message: (refused.body.error as { message?: string }).message })
    .toEqual({ hint: "identity_file_unreadable", message: "This user cannot read the identity file or a directory on its path, or the path is too long or has too many symlinks. Use a shorter path without symlink loops; fix read access only on this user's own file or folder." });
  expect(h.ssh).toEqual([]);
});
