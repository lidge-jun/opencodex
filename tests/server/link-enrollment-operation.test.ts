import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleLinkRoutes, type LinkRouteState } from "../../src/server/management/link-routes";
import type { ManagementContext } from "../../src/server/management/context";
import { enrollOperationDigest, openEnrollJournal } from "../../src/server/management/link-operation";
import { acquireAliasLock, type AliasLockDeps } from "../../src/link/alias-lock";
import { OPERATION_JOURNAL_MAX_SETTLED, OPERATION_JOURNAL_MAX_UNSETTLED, OPERATION_PRUNE_FLOOR_MS, readOperationsJournal, updateOperationsJournal, writeOperationsJournal, type LinkOperation } from "../../src/link/operations-journal";
import type { OcxConfig } from "../../src/types";
import type { LinkRecord, LinkStore } from "../../src/link/store";
import type { SshRunner, SshRunResult } from "../../src/link/ssh-runner";
import { quoteRemote, remoteOcxArgv, WINDOWS_OS_PROBE } from "../../src/link/ssh-argv";
import { remoteInspectRuntimeArgv, remotePlantChildArgv, remotePurgePlantedChildArgv } from "../../src/link/remote-plant";
import { createHash } from "node:crypto";
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
const fakeBinary = new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 1, 2, 3, 4]);
const fakeSha = createHash("sha256").update(fakeBinary).digest("hex");
type Step = "inspect" | "plant" | "purgePlant" | "census" | "probe" | "windows" | "uname" | "version" | "port" | "config" | "curl" | "before" | "connect" | "restart" | "health" | "catalog" | "disconnect";

function harness(lock: Partial<AliasLockDeps> = {}) {
  const remoteOcx = (args: string[]) => quoteRemote(remoteOcxArgv(args, "posix"));
  const config: OcxConfig = { port: 10100, hostname: "127.0.0.1", runtimeRole: "standalone", defaultProvider: "mock", providers: {}, apiKeys: [] };
  const knownHosts = join(root, "known_hosts");
  const journalPath = join(root, "operations.json");
  let store: LinkStore = { version: 1, listenerPort: 18181, links: [] };
  let restarted = false;
  let keyId = "";
  let clock = NOW;
  let revokeWorks = true;
  let issueWorks = true;
  const callbacks = new Set<(id: string) => void>();
  const ssh: Array<{ step: Step; argv: readonly string[] }> = [];
  const overrides: Partial<Record<Step, () => SshRunResult>> = {};
  const gates: Partial<Record<Step, Promise<void>>> = {};
  let reachedStep: ((step: Step) => void) | undefined;
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
      const step: Step = command === quoteRemote(remoteInspectRuntimeArgv("posix")) ? "inspect"
        : command === quoteRemote(remotePlantChildArgv("posix", fakeBinary.byteLength, fakeSha)) ? "plant"
        : command === quoteRemote(remotePurgePlantedChildArgv("posix")) ? "purgePlant"
        : command.includes("ocx-census") ? "census" : command === "echo ocx-link-probe" ? "probe" : command === WINDOWS_OS_PROBE ? "windows"
        : command.includes("ocx-platform") ? "uname" : command === remoteOcx(["--version"]) ? "version"
        : command === remoteOcx(["link", "port"]) ? "port" : command === remoteOcx(["config", "show", "--json"]) ? "config"
        : command.includes("ocx-curl-preflight") ? "curl" : command.includes("'connect' '--link' '--key-stdin'") ? "connect"
        : command === remoteOcx(["restart"]) ? "restart" : command === remoteOcx(["disconnect"]) ? "disconnect"
        : command.includes("'ocx-child-http' '10100' 'healthz'") ? (restarted ? "health" : "before")
        : command.includes("'ocx-child-http' '10100' 'v1/catalog'") ? "catalog"
        : (() => { throw new Error("Unexpected SSH command: " + command.slice(0, 80)); })();
      ssh.push({ step, argv: [...argv] });
      if (gates[step]) { reachedStep?.(step); await gates[step]; }
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
    resolveChildBinarySource: target => target === "linux-x64"
      ? { ok: true, artifact: { targetTriple: "linux-x64", bytes: fakeBinary, sizeBytes: fakeBinary.byteLength, sha256: fakeSha, source: "cache" } }
      : { ok: false, reason: "artifact_not_found" },
    linkAliasLock: { lockDir: join(root, "locks"), waitMs: 0, ...lock },
    issueApiKey: (cfg, name, id) => { if (!issueWorks) throw new Error("reconcile failed after the save"); const key = { id: id ?? "unreserved-key", name, key: "fixture-child-key", createdAt: "2026-11-13T00:00:00Z" }; cfg.apiKeys = [...(cfg.apiKeys ?? []), key]; return key; },
    revokeApiKey: (cfg, id) => { if (!revokeWorks) return false; const before = cfg.apiKeys ?? []; cfg.apiKeys = before.filter(key => key.id !== id); return before.length !== cfg.apiKeys.length; },
  };
  async function call(route: string, body: unknown, method = "POST") {
    const url = new URL("http://127.0.0.1:10100/api/link/" + route);
    const context: ManagementContext = {
      req: new Request(url, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
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
    del: (linkId: string, body: unknown) => call(linkId, body, "DELETE"),
    gateStep: (step: Step, gate: Promise<void>, reached?: () => void) => { gates[step] = gate; reachedStep = reached; },
    get store() { return store; }, set store(value: LinkStore) { store = value; },
    journal: () => readOperationsJournal(journalPath),
    advance: (ms: number) => { clock += ms; }, breakRevoke: () => { revokeWorks = false; }, failIssue: () => { issueWorks = false; },
  };
}

const code = (answer: { body: Record<string, unknown> }) => (answer.body.error as { code?: string } | undefined)?.code;
const digest = () => enrollOperationDigest({ alias: ALIAS, fingerprint, route: { explicitRoute: null, exclusive: false }, requireEphemeral: false });

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
    for (const body of [{ alias: ALIAS, fingerprint, operationId: OP, requireEphemeral: true }, { alias: ALIAS, fingerprint: "SHA256:zzzzzzzzzzzzzzzz", operationId: OP }, { alias: ALIAS, fingerprint, operationId: OP, exclusive: true }]) {
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

test("a second enrollment of the same alias waits for the holder, then runs", async () => {
  let release: (() => void) | undefined;
  const sleeps: number[] = [];
  let clock = 0;
  const h = harness({ waitMs: 10_000, pollMs: 250, now: () => clock, sleep: async ms => { sleeps.push(ms); clock += ms; if (sleeps.length === 2) release?.(); } });
  expect((await h.call("probe", { alias: ALIAS, includeVersion: true })).status).toBe(200);
  expect((await h.call("confirm-host", { alias: ALIAS, fingerprint })).status).toBe(200);
  const held = await acquireAliasLock(ALIAS, { lockDir: join(root, "locks") });
  release = () => held.release();
  const applied = await h.call("apply", { alias: ALIAS, fingerprint, operationId: OP });
  expect(sleeps).toEqual([250, 250]);
  expect(applied.status).toBe(202);
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

  test("another link for the alias makes the outcome unknown; the foreign link stays, the reserved key is still revoked", async () => {
    const h = harness();
    writeOperationsJournal(h.journalPath, { version: 1, operations: [entry({ effects: marks("key_issued:intent", "key_issued:done") })] });
    const foreignKey = { ...reservedKey, id: "someone-else" };
    h.config.apiKeys = [reservedKey, foreignKey];
    const foreign = { ...reservedRecord(), id: "lnk_00000000000000bb", apiKeyId: "someone-else" };
    h.store = { version: 1, listenerPort: 18181, links: [foreign] };
    const repeat = await h.call("apply", { alias: ALIAS, fingerprint, operationId: OP });
    expect(repeat.body.outcome).toBe("unknown");
    expect(h.store.links).toEqual([foreign]);
    // reserved.apiKeyId names only this operation's key, and no record carries the reserved link id.
    expect(h.config.apiKeys).toEqual([foreignKey]);
  });

  test("with another link for the alias and a record carrying the reserved link id, that record is not touched either", async () => {
    const h = harness();
    writeOperationsJournal(h.journalPath, { version: 1, operations: [entry({ effects: marks("key_issued:intent", "key_issued:done", "link_recorded:intent") })] });
    h.config.apiKeys = [reservedKey];
    const foreign = { ...reservedRecord(), id: "lnk_00000000000000bb", apiKeyId: "someone-else", alias: ALIAS.toUpperCase() };
    h.store = { version: 1, listenerPort: 18181, links: [reservedRecord(), foreign] };
    const repeat = await h.call("apply", { alias: ALIAS, fingerprint, operationId: OP });
    expect(repeat.body.outcome).toBe("unknown");
    expect(h.store.links.map(link => link.id)).toEqual(["lnk_00000000000000aa", "lnk_00000000000000bb"]);
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

describe("review round 1", () => {
  test("a key issue that throws after the config may have been saved settles unknown, never clean", async () => {
    const h = harness();
    h.failIssue();
    const applied = await h.enroll();
    expect({ code: code(applied), outcome: applied.body.outcome }).toEqual({ code: "key_issue_uncertain", outcome: "unknown" });
    expect(h.journal().operations[0]!.state).toBe("unknown");
  });

  test("an uncertain key issue after a fresh plant still purges the plant, and the outcome stays unknown", async () => {
    const h = harness();
    h.overrides.inspect = () => ok("ocx-inspect:uname:Linux:x86_64\nocx-inspect:kind:missing\n");
    h.overrides.config = () => ok('{"port":10100,"runtimeRole":"standalone","ephemeralChild":true}\n');
    h.overrides.before = () => ({ code: 7, stdout: "", stderr: "" });
    h.failIssue();
    expect((await h.call("probe", { alias: ALIAS, includeVersion: true, allowMissing: true })).status).toBe(200);
    expect((await h.call("confirm-host", { alias: ALIAS, fingerprint, allowMissing: true })).status).toBe(200);
    const applied = await h.call("apply", { alias: ALIAS, fingerprint, plant: true, operationId: OP });
    expect({ code: code(applied), outcome: applied.body.outcome }).toEqual({ code: "key_issue_uncertain", outcome: "unknown" });
    const steps = h.ssh.map(call => call.step);
    expect(steps.indexOf("purgePlant")).toBeGreaterThan(steps.indexOf("plant"));
    expect(steps.filter(step => step === "purgePlant")).toHaveLength(1);
  });

  test.each([
    ["a transport failure", { error: { code: "remote_plant_failed", message: "x" } }, "residual"],
    ["a nonzero exit without a reason", { error: { code: "remote_plant_failed", message: "x", hint: "Permission denied" } }, "residual"],
    ["the script's own refusal before installing", { error: { code: "remote_plant_failed", message: "x", hint: "hash_tool_unavailable" } }, "failed_clean"],
  ] as const)("an unfinished plant after %s settles %s", async (_label, body, outcome) => {
    const journalPath = join(root, "operations.json");
    const ctx = { deps: { now: () => NOW, linkOperationsPath: () => journalPath } } as unknown as ManagementContext;
    const journal = openEnrollJournal(ctx, { id: OP, digest: digest() }, ALIAS, {});
    journal.intent("plant");
    const finished = await journal.finish(Response.json(body, { status: 502 }));
    expect((await finished.json() as { outcome: string }).outcome).toBe(outcome);
  });

  test("without an operation id and before this Home ever journalled, apply takes no lock and reads no journal", async () => {
    const h = harness();
    expect((await h.call("probe", { alias: ALIAS, includeVersion: true })).status).toBe(200);
    expect((await h.call("confirm-host", { alias: ALIAS, fingerprint })).status).toBe(200);
    const held = await acquireAliasLock(ALIAS, { lockDir: join(root, "elsewhere") });
    held.release();
    writeFileSync(h.journalPath + ".unrelated", "");
    const applied = await h.call("apply", { alias: ALIAS, fingerprint });
    expect(applied.status).toBe(202);
    expect(existsSync(join(root, "locks"))).toBe(false);
    expect(existsSync(h.journalPath)).toBe(false);
  });

  test("once this Home has a journal, a plain apply takes the alias lock too", async () => {
    const h = harness();
    writeOperationsJournal(h.journalPath, { version: 1, operations: [] });
    expect((await h.call("probe", { alias: ALIAS, includeVersion: true })).status).toBe(200);
    expect((await h.call("confirm-host", { alias: ALIAS, fingerprint })).status).toBe(200);
    const held = await acquireAliasLock(ALIAS, { lockDir: join(root, "locks") });
    try {
      const busy = await h.call("apply", { alias: ALIAS, fingerprint });
      expect({ status: busy.status, code: code(busy) }).toEqual({ status: 409, code: "link_operation_in_progress" });
    } finally { held.release(); }
  });
});

describe("review round 3", () => {
  test("a journalled revoke cannot run while a plain apply of the same alias is still enrolling", async () => {
    let open!: () => void;
    let reached!: () => void;
    const connecting = new Promise<void>(resolve => { reached = resolve; });
    const h = harness();
    writeOperationsJournal(h.journalPath, { version: 1, operations: [] });
    h.gateStep("connect", new Promise<void>(resolve => { open = resolve; }), () => reached());
    expect((await h.call("probe", { alias: ALIAS, includeVersion: true })).status).toBe(200);
    expect((await h.call("confirm-host", { alias: ALIAS, fingerprint })).status).toBe(200);
    // A plain apply on a Home that had no journal yet: no alias lock, but the per-alias operation set.
    removeTreeWithRetry(h.journalPath);
    const applying = h.call("apply", { alias: ALIAS, fingerprint });
    await connecting;
    const linkId = h.store.links[0]!.id;
    const revoked = await h.del(linkId, { force: true, operationId: "detach-1" });
    expect({ status: revoked.status, code: code(revoked) }).toEqual({ status: 409, code: "link_operation_in_progress" });
    open();
    expect((await applying).status).toBe(202);
    expect(h.store.links.map(link => link.id)).toEqual([linkId]);
  });

  test("an unknown key outcome whose plant rollback failed replays the Child's residual plant too", async () => {
    const h = harness();
    h.overrides.inspect = () => ok("ocx-inspect:uname:Linux:x86_64\nocx-inspect:kind:missing\n");
    h.overrides.config = () => ok('{"port":10100,"runtimeRole":"standalone","ephemeralChild":true}\n');
    h.overrides.before = () => ({ code: 7, stdout: "", stderr: "" });
    h.overrides.purgePlant = () => ({ code: 1, stdout: "", stderr: "" });
    h.failIssue();
    expect((await h.call("probe", { alias: ALIAS, includeVersion: true, allowMissing: true })).status).toBe(200);
    expect((await h.call("confirm-host", { alias: ALIAS, fingerprint, allowMissing: true })).status).toBe(200);
    const applied = await h.call("apply", { alias: ALIAS, fingerprint, plant: true, operationId: OP });
    expect({ outcome: applied.body.outcome, residual: applied.body.residual }).toEqual({ outcome: "unknown", residual: true });
    const replay = await h.call("apply", { alias: ALIAS, fingerprint, plant: true, operationId: OP });
    expect({ code: code(replay), outcome: replay.body.outcome, residual: replay.body.residual }).toEqual({ code: "key_issue_uncertain", outcome: "unknown", residual: true });
    // A plant is removed only by the managed binary's purge; a disconnect would leave it.
    expect(replay.body.residualKind).toBe("plant");
    expect(replay.body.recovery).toContain("~/.cache/opencodex/bin/ocx-child detach --purge");
    expect(replay.body.recovery).toContain('"%LOCALAPPDATA%\\opencodex\\bin\\ocx-child.exe" detach --purge');
    expect(replay.body.recovery).toContain('"%USERPROFILE%\\.cache\\opencodex\\bin\\ocx-child.exe" detach --purge');
    expect(replay.body.recovery).not.toContain("ocx disconnect");
  });

  test("a first journalled apply of a case variant of an alias waits on, or is refused by, a plain apply already enrolling it", async () => {
    let open!: () => void;
    let reached!: () => void;
    const connecting = new Promise<void>(resolve => { reached = resolve; });
    const h = harness();
    h.gateStep("connect", new Promise<void>(resolve => { open = resolve; }), () => reached());
    expect((await h.call("probe", { alias: ALIAS, includeVersion: true })).status).toBe(200);
    expect((await h.call("confirm-host", { alias: ALIAS, fingerprint })).status).toBe(200);
    const applying = h.call("apply", { alias: ALIAS, fingerprint });
    await connecting;
    const variant = await h.call("apply", { alias: ALIAS.toUpperCase(), fingerprint, operationId: OP });
    expect({ status: variant.status, code: code(variant) }).toEqual({ status: 409, code: "link_operation_in_progress" });
    open();
    expect((await applying).status).toBe(202);
  });

});

describe("journal size limit", () => {
  // Distinct, increasing finish times past the prune floor (early pruning never takes a younger entry), so "oldest first" is well defined.
  const filled = (count: number, shape: Partial<LinkOperation> = {}): LinkOperation[] => Array.from({ length: count }, (_, i) => entry({
    operationId: "old-" + i, alias: "pen-old-" + i, state: "committed", finishedAt: new Date(NOW - OPERATION_PRUNE_FLOOR_MS - (count - i) * 1000).toISOString(), digest: "d".repeat(64), ...shape }));

  test("settled entries never block a new operation: past the bound the oldest are pruned instead", async () => {
    const h = harness();
    writeOperationsJournal(h.journalPath, { version: 1, operations: filled(OPERATION_JOURNAL_MAX_SETTLED) });
    expect((await h.call("probe", { alias: ALIAS, includeVersion: true })).status).toBe(200);
    expect((await h.call("confirm-host", { alias: ALIAS, fingerprint })).status).toBe(200);
    expect((await h.call("apply", { alias: ALIAS, fingerprint, operationId: OP })).status).toBe(202);
    const kept = h.journal().operations;
    expect(kept).toHaveLength(OPERATION_JOURNAL_MAX_SETTLED);
    expect(kept.map(op => op.operationId)).not.toContain("old-0");
    expect(kept.find(op => op.operationId === OP)!.state).toBe("committed");
  });

  test("past the bound of open and unresolved residual or unknown entries a new journalled apply is refused before any effect, naming resolve; a plain apply is not affected", async () => {
    const h = harness();
    writeOperationsJournal(h.journalPath, { version: 1, operations: filled(OPERATION_JOURNAL_MAX_UNSETTLED, { state: "unknown" }) });
    expect((await h.call("probe", { alias: ALIAS, includeVersion: true })).status).toBe(200);
    expect((await h.call("confirm-host", { alias: ALIAS, fingerprint })).status).toBe(200);
    const before = h.ssh.length;
    const refused = await h.call("apply", { alias: ALIAS, fingerprint, operationId: OP });
    expect({ status: refused.status, code: code(refused) }).toEqual({ status: 409, code: "operation_journal_full" });
    expect((refused.body.error as { message: string }).message).toContain("ocx link operations resolve");
    expect(h.ssh.length).toBe(before);
    expect(h.config.apiKeys).toEqual([]);
    expect((await h.call("apply", { alias: ALIAS, fingerprint })).status).toBe(202);
  });

  test("marks on an operation already in the journal are never refused at the bound", () => {
    const h = harness();
    writeOperationsJournal(h.journalPath, { version: 1, operations: filled(OPERATION_JOURNAL_MAX_UNSETTLED - 1, { state: "unknown" }) });
    const ctx = { deps: { now: () => NOW, linkOperationsPath: () => h.journalPath } } as unknown as ManagementContext;
    const journal = openEnrollJournal(ctx, { id: OP, digest: digest() }, ALIAS, {});
    expect(h.journal().operations).toHaveLength(OPERATION_JOURNAL_MAX_UNSETTLED);
    journal.intent("key_issued");
    expect(h.journal().operations.find(op => op.operationId === OP)!.effects.map(mark => mark.effect)).toEqual(["key_issued"]);
  });
});

describe("small follow-ups", () => {
  test("an operation id without a fingerprint is refused, as the CLI already refuses it", async () => {
    const h = harness();
    const refused = await h.call("apply", { alias: ALIAS, operationId: OP });
    expect({ status: refused.status, code: code(refused) }).toEqual({ status: 400, code: "invalid_body" });
    expect(existsSync(h.journalPath)).toBe(false);
  });

  test("a committed enrollment that planted the Child says planted: true, live and on replay", async () => {
    const h = harness();
    h.overrides.inspect = () => ok("ocx-inspect:uname:Linux:x86_64\nocx-inspect:kind:missing\n");
    h.overrides.config = () => ok('{"port":10100,"runtimeRole":"standalone","ephemeralChild":true}\n');
    h.overrides.before = () => ({ code: 7, stdout: "", stderr: "" });
    expect((await h.call("probe", { alias: ALIAS, includeVersion: true, allowMissing: true })).status).toBe(200);
    expect((await h.call("confirm-host", { alias: ALIAS, fingerprint, allowMissing: true })).status).toBe(200);
    const applied = await h.call("apply", { alias: ALIAS, fingerprint, plant: true, operationId: OP });
    expect({ status: applied.status, planted: applied.body.planted, outcome: applied.body.outcome }).toEqual({ status: 202, planted: true, outcome: "committed" });
    const replay = await h.call("apply", { alias: ALIAS, fingerprint, plant: true, operationId: OP });
    expect(replay).toEqual({ status: 202, body: applied.body });
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

describe("replay survives the settled-entry bound", () => {
  test("a committed enrollment whose answer was lost still replays after 256 newer settled entries, without SSH", async () => {
    const h = harness();
    const applied = await h.enroll();
    expect(applied.status).toBe(202);
    const committedOp = h.journal().operations[0]!;
    // Many operations settle after it within the same day (a provisioning burst); a later write prunes.
    const newer = Array.from({ length: OPERATION_JOURNAL_MAX_SETTLED + 4 }, (_, i) => entry({ operationId: "later-" + i, alias: "pen-later-" + i, state: "committed",
      finishedAt: new Date(NOW + 1000 + i).toISOString(), digest: "e".repeat(64) }));
    writeOperationsJournal(h.journalPath, { version: 1, operations: [committedOp, ...newer] });
    updateOperationsJournal(h.journalPath, NOW + 3_600_000, () => {});
    expect(h.journal().operations.map(op => op.operationId)).toContain(OP);
    const calls = h.ssh.length;
    const replayed = await h.call("apply", { alias: ALIAS, fingerprint, operationId: OP });
    expect({ status: replayed.status, body: replayed.body }).toEqual({ status: 202, body: applied.body });
    expect(h.ssh.length).toBe(calls);
  });
});
