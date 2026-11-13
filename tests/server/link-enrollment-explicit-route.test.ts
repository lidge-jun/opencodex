import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
function keyFile(mode = 0o600, name = "goat_hub_ed25519"): string {
  const path = join(root, name);
  writeFileSync(path, KEY_CANARY + "\n");
  chmodSync(path, mode);
  return path;
}

test("every SSH command of an enrollment with an identity file offers that key alone, and the link keeps the path", async () => {
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

test("a confirm or apply that names another identity file than the probe is refused", async () => {
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

test.each([
  ["a missing file", (path: string) => path + ".gone", "identity_file_missing"],
  ["a symlink", (path: string) => { const link = path + ".link"; symlinkSync(path, link); return link; }, "identity_file_not_regular"],
  ["a directory", () => root, "identity_file_not_regular"],
  ["a file group or others can read", (path: string) => { chmodSync(path, 0o640); return path; }, "identity_file_permissions"],
  ["a file this user cannot read", (path: string) => { chmodSync(path, 0o200); return path; }, "identity_file_unreadable"],
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

test("a repeat of a journalled enrollment replays its outcome after its key file is gone, and another key answers operation_mismatch", async () => {
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

test("a new journalled enrollment whose key file went away after confirm-host is refused before its journal entry and any SSH", async () => {
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
