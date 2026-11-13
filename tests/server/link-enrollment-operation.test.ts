import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleLinkRoutes, type LinkRouteState } from "../../src/server/management/link-routes";
import type { ManagementContext } from "../../src/server/management/context";
import { enrollOperationDigest } from "../../src/server/management/link-operation";
import { acquireAliasLock } from "../../src/link/alias-lock";
import { readOperationsJournal, updateOperationsJournal, writeOperationsJournal, type LinkOperation } from "../../src/link/operations-journal";
import type { OcxConfig } from "../../src/types";
import type { LinkRecord, LinkStore } from "../../src/link/store";
import type { SshRunner, SshRunResult } from "../../src/link/ssh-runner";
import { quoteRemote, remoteOcxArgv, WINDOWS_OS_PROBE } from "../../src/link/ssh-argv";
import { resetSharedChildOpsEngineForTests, sharedChildOpsEngine } from "../../src/link/child-ops-engine";
import { removeTreeWithRetry } from "../helpers/remove-tree";

/**
 * O1: ocx link add --operation-id. The journal reserves the link id and key id before any effect, marks an intent
 * and a completion around each Home effect, records the outcome, replays it for a repeat, and recovers an entry its
 * process left open by comparing reserved ids.
 */
const fingerprint = "SHA256:abcdefghijklmnop";
const ALIAS = "pen-7f3a9c";
const OP = "attach-0001";
const NOW = 1_800_000_000_000;
const DAY = 24 * 60 * 60 * 1000;

let root = "";
let previousHome: string | undefined;
beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  root = mkdtempSync(join(tmpdir(), "ocx-enroll-op-"));
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
type Step = "census" | "probe" | "windows" | "uname" | "version" | "port" | "config" | "curl" | "before" | "connect" | "restart" | "health" | "catalog" | "disconnect";

function harness() {
  const remoteOcx = (args: string[]) => quoteRemote(remoteOcxArgv(args, "posix"));
  const config: OcxConfig = { port: 10100, hostname: "127.0.0.1", runtimeRole: "standalone", defaultProvider: "mock", providers: {}, apiKeys: [] };
  const knownHosts = join(root, "known_hosts");
  const journalPath = join(root, "operations.json");
  let store: LinkStore = { version: 1, listenerPort: 18181, links: [] };
  let restarted = false;
  let keyId = "";
  let clock = NOW;
  let revokeWorks = true;
  const callbacks = new Set<(id: string) => void>();
  const ssh: Array<{ step: Step; argv: readonly string[] }> = [];
  const overrides: Partial<Record<Step, () => SshRunResult>> = {};
  const state: LinkRouteState = {
    pendingHosts: new Map(), confirmedHosts: new Map(), operations: new Set(),
    listener: {
      ensureStarted: async () => {}, status: () => ({ state: "listening", port: 18181, reason: null }), close: async () => {},
      onAuthenticatedCatalog: callback => { callbacks.add(callback); return () => { callbacks.delete(callback); }; },
    },
    supervisor: { start() {}, ensureStarted: async () => {}, reload: async () => {}, stopLink: async () => {}, reconnect: async () => true, status: () => [], stop: async () => {} },
  };
  const runner: SshRunner = {
    async run(argv, options) {
      const command = argv.at(-1) ?? "";
      if (argv[0] === "ssh-keygen") return ok("256 " + fingerprint + " child (ED25519)");
      const step: Step = command.includes("ocx-census") ? "census" : command === "echo ocx-link-probe" ? "probe" : command === WINDOWS_OS_PROBE ? "windows"
        : command.includes("ocx-platform") ? "uname" : command === remoteOcx(["--version"]) ? "version"
        : command === remoteOcx(["link", "port"]) ? "port" : command === remoteOcx(["config", "show", "--json"]) ? "config"
        : command.includes("ocx-curl-preflight") ? "curl" : command.includes("'connect' '--link' '--key-stdin'") ? "connect"
        : command === remoteOcx(["restart"]) ? "restart" : command === remoteOcx(["disconnect"]) ? "disconnect"
        : command.includes("'ocx-child-http' '10100' 'healthz'") ? (restarted ? "health" : "before")
        : command.includes("'ocx-child-http' '10100' 'v1/catalog'") ? "catalog"
        : (() => { throw new Error("Unexpected SSH command: " + command.slice(0, 80)); })();
      ssh.push({ step, argv: [...argv] });
      if (overrides[step]) return overrides[step]!();
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
        case "connect": keyId = JSON.parse(new TextDecoder().decode(options!.stdin as Uint8Array)).apiKeyId; return ok();
        case "restart": restarted = true; return ok();
        case "before": return http({ service: "opencodex", pid: 1, port: 10100, role: "standalone", restartCapability: "v1" });
        case "health": return http({ service: "opencodex", pid: 1, port: 10100, role: "client", restartCapability: "v1" });
        case "catalog": for (const callback of callbacks) callback(keyId); return http({ models: [{ id: "m" }] });
        default: return ok();
      }
    },
    spawnTunnel() { throw new Error("no tunnel here"); },
  };
  const deps: ManagementContext["deps"] = {
    now: () => clock, sshRunner: runner,
    readLinkStore: () => structuredClone(store), writeLinkStore: next => { store = structuredClone(next); },
    linkKnownHostsPath: () => knownHosts, liveListenPort: () => 10100,
    linkOperationsPath: () => journalPath,
    linkAliasLock: { lockDir: join(root, "locks"), waitMs: 0 },
    issueApiKey: (cfg, name, id) => { const key = { id: id ?? "unreserved-key", name, key: "fixture-child-key", createdAt: "2026-11-13T00:00:00Z" }; cfg.apiKeys = [...(cfg.apiKeys ?? []), key]; return key; },
    revokeApiKey: (cfg, id) => { if (!revokeWorks) return false; const before = cfg.apiKeys ?? []; cfg.apiKeys = before.filter(key => key.id !== id); return before.length !== cfg.apiKeys.length; },
  };
  async function call(route: string, body: unknown) {
    const url = new URL("http://127.0.0.1:10100/api/link/" + route);
    const context: ManagementContext = {
      req: new Request(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
      url, config, deps, version: "2.99.0", principal: "admin-token", trustedLoopbackIngress: true, guiSessionIssuance: null,
      sessionControl: { isCurrent: () => true, isPaired: () => false, revokeCurrent: () => true },
      convergeCodexCatalog: async () => { throw new Error("no catalog convergence"); }, syncClaudeAgentDefsBestEffort: async () => {},
    };
    const response = await handleLinkRoutes(context, state);
    if (!response) throw new Error("route not handled");
    return { status: response.status, body: await response.json() as Record<string, unknown> };
  }
  async function enroll(extra: Record<string, unknown> = {}) {
    expect((await call("probe", { alias: ALIAS, includeVersion: true })).status).toBe(200);
    expect((await call("confirm-host", { alias: ALIAS, fingerprint })).status).toBe(200);
    return await call("apply", { alias: ALIAS, fingerprint, operationId: OP, ...extra });
  }
  return {
    call, enroll, ssh, state, config, overrides, journalPath,
    get store() { return store; }, set store(value: LinkStore) { store = value; },
    journal: () => readOperationsJournal(journalPath),
    advance: (ms: number) => { clock += ms; }, breakRevoke: () => { revokeWorks = false; },
  };
}

const code = (answer: { body: Record<string, unknown> }) => (answer.body.error as { code?: string } | undefined)?.code;
const digest = (extra: { plant?: boolean } = {}) => enrollOperationDigest({ alias: ALIAS, fingerprint, plant: extra.plant === true, route: { explicitRoute: null, exclusive: false }, requireEphemeral: false });

describe("a live enrollment with an operation id", () => {
  test("reserves the ids before any effect, marks every Home effect, commits and replays without SSH", async () => {
    const h = harness();
    const applied = await h.enroll();
    expect(applied.status).toBe(202);
    const entry = h.journal().operations[0]!;
    expect(applied.body).toEqual({ linkId: entry.reserved!.linkId, operationId: OP, outcome: "committed" });
    expect(entry).toMatchObject({ operationId: OP, kind: "enroll", alias: ALIAS, state: "committed", digest: digest() });
    expect(entry.reserved).toMatchObject({ tunnelPort: 2200 });
    expect(h.store.links.map(link => [link.id, link.apiKeyId])).toEqual([[entry.reserved!.linkId, entry.reserved!.apiKeyId]]);
    expect(h.config.apiKeys!.map(key => key.id)).toEqual([entry.reserved!.apiKeyId]);
    expect(entry.effects.map(mark => mark.effect + ":" + mark.phase)).toEqual([
      "key_issued:intent", "key_issued:done", "link_recorded:intent", "link_recorded:done",
      "child_enrolled:intent", "child_enrolled:done", "relay_verified:intent", "relay_verified:done",
    ]);
    const connect = h.ssh.find(call => call.step === "connect")!;
    expect(connect.argv.at(-1)).toContain("'--link-id' '" + entry.reserved!.linkId + "'");

    const calls = h.ssh.length;
    h.state.confirmedHosts!.clear();
    const replay = await h.call("apply", { alias: ALIAS, fingerprint, operationId: OP });
    expect(replay).toEqual({ status: 202, body: applied.body });
    expect(h.ssh.length).toBe(calls);
  });

  test("the same id with other parameters is refused before anything runs", async () => {
    const h = harness();
    await h.enroll();
    const calls = h.ssh.length;
    for (const body of [{ alias: ALIAS, fingerprint, operationId: OP, plant: true }, { alias: ALIAS, fingerprint: "SHA256:zzzzzzzzzzzzzzzz", operationId: OP }]) {
      const refused = await h.call("apply", body);
      expect({ status: refused.status, code: code(refused) }).toEqual({ status: 409, code: "operation_mismatch" });
    }
    expect(h.ssh.length).toBe(calls);
  });

  test("a failure before any key is failed_clean and replays its code", async () => {
    const h = harness();
    h.overrides.config = () => ({ code: 1, stdout: "", stderr: "" });
    const applied = await h.enroll();
    expect({ status: applied.status, code: code(applied), outcome: applied.body.outcome }).toEqual({ status: 502, code: "child_preflight_failed", outcome: "failed_clean" });
    expect(h.journal().operations[0]).toMatchObject({ state: "failed_clean", error: { code: "child_preflight_failed", status: 502 } });
    expect(h.config.apiKeys).toEqual([]);
    const replay = await h.call("apply", { alias: ALIAS, fingerprint, operationId: OP });
    expect({ status: replay.status, code: code(replay), outcome: replay.body.outcome }).toEqual({ status: 502, code: "child_preflight_failed", outcome: "failed_clean" });
  });

  test("a failure after the Child was enrolled is residual, with the Home's key and record undone", async () => {
    const h = harness();
    h.overrides.restart = () => ({ code: 1, stdout: "", stderr: "" });
    const applied = await h.enroll();
    expect({ status: applied.status, code: code(applied), outcome: applied.body.outcome, residual: applied.body.residual }).toEqual({ status: 502, code: "child_restart_failed", outcome: "residual", residual: true });
    expect(h.journal().operations[0]!.state).toBe("residual");
    expect(h.config.apiKeys).toEqual([]);
    expect(h.store.links).toEqual([]);
  });

  test("a key that cannot be revoked leaves the outcome unknown", async () => {
    const h = harness();
    h.overrides.connect = () => ({ code: 1, stdout: "", stderr: "" });
    h.breakRevoke();
    const applied = await h.enroll();
    expect(applied.body.outcome).toBe("unknown");
    expect(h.journal().operations[0]!.state).toBe("unknown");
  });

  test("an alias with an open entry refuses any other enrollment; a held alias lock refuses past its wait", async () => {
    const h = harness();
    writeOperationsJournal(h.journalPath, { version: 1, operations: [entry({ operationId: "other-op", effects: [] })] });
    expect((await h.call("probe", { alias: ALIAS, includeVersion: true })).status).toBe(200);
    expect((await h.call("confirm-host", { alias: ALIAS, fingerprint })).status).toBe(200);
    for (const body of [{ alias: ALIAS, fingerprint }, { alias: ALIAS, fingerprint, operationId: OP }]) {
      const refused = await h.call("apply", body);
      expect({ status: refused.status, code: code(refused) }).toEqual({ status: 409, code: "link_operation_open" });
    }
    writeOperationsJournal(h.journalPath, { version: 1, operations: [] });
    const lock = await acquireAliasLock(ALIAS.toUpperCase(), { lockDir: join(root, "locks") });
    try {
      const busy = await h.call("apply", { alias: ALIAS, fingerprint, operationId: OP });
      expect({ status: busy.status, code: code(busy) }).toEqual({ status: 409, code: "link_operation_in_progress" });
    } finally { lock.release(); }
  });
});

function entry(overrides: Partial<LinkOperation> = {}): LinkOperation {
  return {
    operationId: OP, kind: "enroll", alias: ALIAS, digest: digest(), createdAt: new Date(NOW).toISOString(), updatedAt: new Date(NOW).toISOString(),
    state: "open", reserved: { linkId: "lnk_00000000000000aa", apiKeyId: "reserved-key-aa", tunnelPort: 2200 }, effects: [], ...overrides,
  };
}
const marks = (...list: string[]) => list.map(item => { const [effect, phase] = item.split(":"); return { effect, phase, at: new Date(NOW).toISOString() }; }) as LinkOperation["effects"];
const reservedRecord = (): LinkRecord => ({ id: "lnk_00000000000000aa", alias: ALIAS, direction: "hub-initiated", hostKeyFingerprint: fingerprint, tunnelPort: 2200, apiKeyId: "reserved-key-aa", createdAt: new Date(NOW).toISOString() });
const reservedKey = { id: "reserved-key-aa", name: "link:" + ALIAS, key: "k", createdAt: "2026-11-13T00:00:00Z" };

describe("a repeat after the process died at a boundary", () => {
  test.each([
    ["before any effect", [], false, false, "failed_clean"],
    ["after the key intent, no key", ["key_issued:intent"], false, false, "failed_clean"],
    ["after the key intent, key issued", ["key_issued:intent"], true, false, "failed_clean"],
    ["after the key completion", ["key_issued:intent", "key_issued:done"], true, false, "failed_clean"],
    ["after the record intent", ["key_issued:intent", "key_issued:done", "link_recorded:intent"], true, false, "failed_clean"],
    ["after the record completion", ["key_issued:intent", "key_issued:done", "link_recorded:intent", "link_recorded:done"], true, true, "failed_clean"],
    ["after the enrollment intent", ["key_issued:intent", "key_issued:done", "link_recorded:intent", "link_recorded:done", "child_enrolled:intent"], true, true, "residual"],
    ["after the enrollment completion", ["key_issued:intent", "key_issued:done", "link_recorded:intent", "link_recorded:done", "child_enrolled:intent", "child_enrolled:done"], true, true, "residual"],
    ["after the relay intent", ["key_issued:intent", "key_issued:done", "link_recorded:intent", "link_recorded:done", "child_enrolled:intent", "child_enrolled:done", "relay_verified:intent"], true, true, "residual"],
    ["after the relay completion", ["key_issued:intent", "key_issued:done", "link_recorded:intent", "link_recorded:done", "child_enrolled:intent", "child_enrolled:done", "relay_verified:intent", "relay_verified:done"], true, true, "committed"],
    ["after the plant intent", ["plant:intent"], false, false, "residual"],
    ["after the plant completion", ["plant:intent", "plant:done"], false, false, "residual"],
  ] as const)("%s yields %s", async (_label, effects, keyPresent, recordPresent, outcome) => {
    const h = harness();
    writeOperationsJournal(h.journalPath, { version: 1, operations: [entry({ effects: marks(...effects) })] });
    if (keyPresent) h.config.apiKeys = [reservedKey];
    if (recordPresent) h.store = { version: 1, listenerPort: 18181, links: [reservedRecord()] };
    const repeat = await h.call("apply", { alias: ALIAS, fingerprint, operationId: OP });
    expect(repeat.body.outcome).toBe(outcome);
    expect(h.journal().operations[0]!.state).toBe(outcome);
    expect(h.ssh).toEqual([]);
    if (outcome === "committed") {
      expect(repeat).toEqual({ status: 202, body: { linkId: "lnk_00000000000000aa", operationId: OP, outcome: "committed" } });
      expect(h.store.links.map(link => link.id)).toEqual(["lnk_00000000000000aa"]);
      expect(h.config.apiKeys!.map(key => key.id)).toEqual(["reserved-key-aa"]);
    } else {
      expect(h.store.links).toEqual([]);
      expect(h.config.apiKeys).toEqual([]);
      expect(repeat.body.residual === true).toBe(outcome === "residual");
    }
  });

  test("another link for the alias makes the outcome unknown and nothing is touched", async () => {
    const h = harness();
    writeOperationsJournal(h.journalPath, { version: 1, operations: [entry({ effects: marks("key_issued:intent", "key_issued:done") })] });
    h.config.apiKeys = [reservedKey];
    const foreign = { ...reservedRecord(), id: "lnk_00000000000000bb", apiKeyId: "someone-else" };
    h.store = { version: 1, listenerPort: 18181, links: [foreign] };
    const repeat = await h.call("apply", { alias: ALIAS, fingerprint, operationId: OP });
    expect(repeat.body.outcome).toBe("unknown");
    expect(h.store.links).toEqual([foreign]);
    expect(h.config.apiKeys).toEqual([reservedKey]);
  });

  test("a reserved key that will not revoke leaves the outcome unknown", async () => {
    const h = harness();
    writeOperationsJournal(h.journalPath, { version: 1, operations: [entry({ effects: marks("key_issued:intent") })] });
    h.config.apiKeys = [reservedKey];
    h.breakRevoke();
    expect((await h.call("apply", { alias: ALIAS, fingerprint, operationId: OP })).body.outcome).toBe("unknown");
  });
});

describe("--require-ephemeral", () => {
  test("a full ocx found by the census refuses before any plant, key or Child change, also beside ocx-child", async () => {
    const h = harness();
    h.overrides.census = () => ok("ocx-census:full\nocx-census:done\n");
    const applied = await h.enroll({ requireEphemeral: true });
    expect({ status: applied.status, code: code(applied), outcome: applied.body.outcome }).toEqual({ status: 409, code: "full_install_present", outcome: "failed_clean" });
    const steps = h.ssh.map(call => call.step);
    expect(steps.slice(steps.indexOf("census"))).toEqual(["census"]);
    expect(h.config.apiKeys).toEqual([]);
    expect(h.store.links).toEqual([]);
  });

  test("no full ocx lets the enrollment go on; the census runs once, before the port", async () => {
    const h = harness();
    h.overrides.census = () => ok("ocx-census:done\n");
    const applied = await h.enroll({ requireEphemeral: true });
    expect(applied.status).toBe(202);
    const steps = h.ssh.map(call => call.step);
    expect(steps.filter(step => step === "census")).toHaveLength(1);
    expect(steps.indexOf("census")).toBeLessThan(steps.indexOf("port"));
  });

  test("a census that does not finish fails closed", async () => {
    const h = harness();
    h.overrides.census = () => ok("ocx-census:full\n");
    const applied = await h.enroll({ requireEphemeral: true });
    expect({ status: applied.status, code: code(applied) }).toEqual({ status: 502, code: "full_install_census_failed" });
    expect(h.config.apiKeys).toEqual([]);
  });

  test("without the flag no census runs", async () => {
    const h = harness();
    await h.enroll();
    expect(h.ssh.map(call => call.step)).not.toContain("census");
  });
});

describe("retention", () => {
  test("a residual entry older than 30 days is still there and recoverable; a committed one is pruned", async () => {
    const h = harness();
    const old = new Date(NOW - 31 * DAY).toISOString();
    writeOperationsJournal(h.journalPath, { version: 1, operations: [
      entry({ state: "residual", finishedAt: old, createdAt: old, updatedAt: old, effects: marks("child_enrolled:intent"), error: { code: "child_restart_failed", status: 502 } }),
      entry({ operationId: "old-commit", alias: "pen-other", state: "committed", finishedAt: old, createdAt: old, updatedAt: old, digest: "0".repeat(64) }),
    ] });
    const replay = await h.call("apply", { alias: ALIAS, fingerprint, operationId: OP });
    expect({ outcome: replay.body.outcome, residual: replay.body.residual }).toEqual({ outcome: "residual", residual: true });
    // Every journal write prunes.
    updateOperationsJournal(h.journalPath, NOW, () => {});
    expect(h.journal().operations.map(op => op.operationId)).toEqual([OP]);
    expect((await h.call("apply", { alias: ALIAS, fingerprint, operationId: OP })).body.outcome).toBe("residual");
    // Resolved, its 30 days start then.
    updateOperationsJournal(h.journalPath, NOW, journal => { journal.operations[0]!.resolvedAt = new Date(NOW - 29 * DAY).toISOString(); });
    expect(h.journal().operations.map(op => op.operationId)).toEqual([OP]);
    updateOperationsJournal(h.journalPath, NOW + 2 * DAY, () => {});
    expect(h.journal().operations).toEqual([]);
  });
});
