import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { saveConfig } from "../src/config";
import { saveCodexAccountCredential } from "../src/codex/account-store";
import { MAIN_CODEX_ACCOUNT_ID } from "../src/codex/main-account";
import { NativeProfileManager } from "../src/codex/native-profile-manager";
import { handleNativeProfileAPI } from "../src/codex/native-profile-api";
import {
  encryptNativeEnvelope,
  probeNativeProfileRecoveryState,
  readNativeEnvelope,
  readNativeProfileVault,
  inspectNativeProfileJournal,
  serializeNativeProfileJournal,
} from "../src/codex/native-profile-store";
import type {
  NativeProfileKey,
  NativeProfileKeyProvider,
  NativeProfileSwitchJournalV1,
} from "../src/codex/native-profile-types";
import type { OcxConfig } from "../src/types";
import {
  bindNativeMainStartupLifecycle,
  blockNativeMainStartupForUnownedServiceHome,
  initializeNativeMainStartupGate,
  isNativeMainTrafficBlocked,
  nativeMainStartupGateSnapshot,
  NATIVE_MAIN_OWNERSHIP_RETRY_LIMIT,
  prepareNativeMainStartupLifecycle,
  releaseNativeMainStartupLifecycle,
  type NativeMainStartupLifecycle,
  waitForNativeMainStartupGate,
  __resetNativeMainOwnershipRetries,
} from "../src/codex/native-profile-startup";
import type { NativeCodexOwnership } from "../src/integrations/native/ownership-preflight";
import {
  tryAcquireNativeMainProfileClaim,
  tryClaimNativeMainProfileForTurn,
} from "../src/codex/native-main-admission";
import {
  getNativeMainProfileRequestCount,
  resetLifecycleDrainStateForTests,
  tryAdmitTurn,
} from "../src/server/lifecycle";
import { startServer } from "../src/server";
import { removeTreeWithRetry } from "./helpers/remove-tree";

const roots: string[] = [];
const previousOpencodexHome = process.env.OPENCODEX_HOME;
const previousCodexHome = process.env.CODEX_HOME;
const OWNERSHIP_REPROBE_TEST_HOME = "ownership-reprobe-test-home";

function restoreEnv(name: "OPENCODEX_HOME" | "CODEX_HOME", value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

afterEach(() => {
  restoreEnv("OPENCODEX_HOME", previousOpencodexHome);
  restoreEnv("CODEX_HOME", previousCodexHome);
  for (const root of roots.splice(0)) removeTreeWithRetry(root);
});

class MemoryKeyProvider implements NativeProfileKeyProvider {
  constructor(private readonly bytes: Buffer) {}
  async get(): Promise<NativeProfileKey> { return { keyRef: "memory:startup-test", key: Buffer.from(this.bytes) }; }
  async create(): Promise<NativeProfileKey> { return { keyRef: "memory:startup-test", key: Buffer.from(this.bytes) }; }
}

function envelope(accountId: string, marker: string): string {
  return JSON.stringify({
    auth_mode: "chatgpt",
    tokens: {
      id_token: `id-${marker}`,
      access_token: `access-${marker}`,
      refresh_token: `refresh-${marker}`,
      account_id: accountId,
    },
  }, null, 2) + "\n";
}

/** Lightweight owned transition for retry/refcount tests that do not exercise real recovery. */
function startReadyOwnershipRetryLifecycle(): NativeMainStartupLifecycle {
  const homeId = OWNERSHIP_REPROBE_TEST_HOME;
  const readySettled = initializeNativeMainStartupGate({
    manager: { context: { homeId } } as unknown as NativeProfileManager,
    probeRecoveryState: () => "none",
  });
  return { homeId, settled: readySettled, release: async () => {} };
}

type Phase = "prepared" | "auth-replaced" | "vault-committed";
type Observation = "source-exact" | "source-changed" | "target-exact" | "target-changed" | "unreadable" | "third";

interface Fixture {
  root: string;
  codexHome: string;
  configDir: string;
  key: Buffer;
  manager: NativeProfileManager;
  target: string;
  sourceProfileId: string;
  targetProfileId: string;
}

async function fixture(
  phase: Phase,
  observation: Observation,
  activePool = false,
  codexAccountMode: "pool" | "direct" = "pool",
): Promise<Fixture> {
  const root = mkdtempSync(join(tmpdir(), "ocx-native-startup-"));
  roots.push(root);
  const codexHome = join(root, "codex");
  const configDir = join(root, "opencodex");
  mkdirSync(codexHome, { recursive: true });
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(codexHome, "config.toml"), 'cli_auth_credentials_store = "file"\n');
  const source = envelope("account-source", "source");
  const target = envelope("account-target", "target");
  writeFileSync(join(codexHome, "auth.json"), source);
  const key = Buffer.alloc(32, 0x5a);
  const keyProvider = new MemoryKeyProvider(key);
  const manager = new NativeProfileManager({
    codexHome,
    configDir,
    keyProvider,
    hardenPath: async () => {},
    processProbe: async () => ({ status: "clear", count: 0 }),
  });
  const registered = await manager.register("source");
  const stage = await manager.prepareStage();
  writeFileSync(join(stage.stagingCodexHome, "auth.json"), target);
  const added = await manager.finishStage(stage.stageId, stage.writerToken, "target");

  const beforeVault = readNativeProfileVault(manager.context)!;
  const sourceRecord = beforeVault.profiles.find(profile => profile.id === registered.profile.id)!;
  const targetRecord = beforeVault.profiles.find(profile => profile.id === added.profile.id)!;
  const sourceEnvelope = readNativeEnvelope(manager.context.authPath);
  const sourcePayload = encryptNativeEnvelope(
    manager.context,
    sourceRecord.id,
    sourceRecord.identityHash,
    sourceEnvelope,
    { keyRef: "memory:startup-test", key: Buffer.from(key) },
  );
  sourceEnvelope.raw.fill(0);
  const afterVault = structuredClone(beforeVault);
  const afterSource = afterVault.profiles.find(profile => profile.id === sourceRecord.id)!;
  const afterTarget = afterVault.profiles.find(profile => profile.id === targetRecord.id)!;
  const switchedAt = new Date().toISOString();
  afterSource.state = "inactive";
  afterSource.payload = sourcePayload;
  afterSource.updatedAt = switchedAt;
  afterTarget.state = "active";
  afterTarget.payload = null;
  afterTarget.updatedAt = switchedAt;
  afterVault.activeProfileId = afterTarget.id;
  afterVault.revision += 1;

  const journal: NativeProfileSwitchJournalV1 = {
    version: 1,
    transactionId: crypto.randomUUID(),
    homeId: manager.context.homeId,
    phase,
    sourceProfileId: sourceRecord.id,
    sourceIdentityHash: sourceRecord.identityHash,
    sourcePayload,
    targetProfileId: targetRecord.id,
    targetIdentityHash: targetRecord.identityHash,
    targetPayload: targetRecord.payload!,
    beforeVault,
    afterVault,
    createdAt: switchedAt,
  };
  writeFileSync(manager.context.journalPath, serializeNativeProfileJournal(journal));
  expect(inspectNativeProfileJournal(manager.context).status).toBe("valid");

  const observed = observation === "source-exact" ? source
    : observation === "source-changed" ? envelope("account-source", "source-changed")
      : observation === "target-exact" ? target
        : observation === "target-changed" ? envelope("account-target", "target-changed")
          : observation === "third" ? envelope("account-third", "third")
            : "{}\n";
  writeFileSync(manager.context.authPath, observed);

  process.env.OPENCODEX_HOME = configDir;
  process.env.CODEX_HOME = codexHome;
  const config = {
    port: 0,
    hostname: "127.0.0.1",
    defaultProvider: "openai",
    providers: {
      openai: {
        adapter: "openai-responses",
        baseUrl: "https://chatgpt.com/backend-api/codex",
        authMode: "forward",
        codexAccountMode,
      },
    },
    codexAccounts: activePool ? [{ id: "pool-a", email: "pool@test", isMain: false }] : [],
    activeCodexAccountId: activePool ? "pool-a" : MAIN_CODEX_ACCOUNT_ID,
    autoSwitchThreshold: 0,
  } as OcxConfig;
  saveConfig(config);
  if (activePool) {
    saveCodexAccountCredential("pool-a", {
      accessToken: "pool-access",
      refreshToken: "pool-refresh",
      expiresAt: Date.now() + 10 * 60_000,
      chatgptAccountId: "pool-account",
    });
  }
  restoreEnv("OPENCODEX_HOME", previousOpencodexHome);
  restoreEnv("CODEX_HOME", previousCodexHome);
  return { root, codexHome, configDir, key, manager, target, sourceProfileId: sourceRecord.id, targetProfileId: targetRecord.id };
}

async function waitForPath(path: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(path) && Date.now() < deadline) await Bun.sleep(10);
  if (!existsSync(path)) throw new Error(`Timed out waiting for ${path}`);
}

/**
 * A port file that EXISTS is not a port file that is WRITTEN. The child creates
 * the file and then fills it, and reading between those two steps parses "" to
 * 0 — which is how a CI run fetched http://127.0.0.1:0 and called it a flake.
 * Wait for a port that is actually a port.
 */
// A spawned proxy child needs 10-18 s to reach its port file on a loaded windows-latest shard
// (runs 33601508392 and 33610501053); every caller here has a 20 s+ budget.
async function waitForPort(path: string, timeoutMs = 18_000): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (existsSync(path)) {
      const port = Number(readFileSync(path, "utf8").trim());
      if (Number.isInteger(port) && port > 0) return port;
    }
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for a real port in ${path}`);
    await Bun.sleep(10);
  }
}

function childPaths(f: Fixture) {
  return {
    port: join(f.root, "port"),
    release: join(f.root, "recovery-release"),
    settled: join(f.root, "recovery-settled"),
    upstream: join(f.root, "upstream.jsonl"),
    stop: join(f.root, "stop"),
  };
}

function spawnChild(f: Fixture, paths: ReturnType<typeof childPaths>): ReturnType<typeof Bun.spawn> {
  return Bun.spawn([process.execPath, join(import.meta.dir, "helpers", "native-profile-startup-child.ts")], {
    cwd: join(import.meta.dir, ".."),
    env: {
      ...process.env,
      OPENCODEX_HOME: f.configDir,
      CODEX_HOME: f.codexHome,
      OPENCODEX_ADMIN_AUTH_TOKEN: "startup-test-admin",
      NATIVE_STARTUP_CODEX_HOME: f.codexHome,
      NATIVE_STARTUP_CONFIG_DIR: f.configDir,
      NATIVE_STARTUP_KEY: f.key.toString("base64"),
      NATIVE_STARTUP_PORT: paths.port,
      NATIVE_STARTUP_RECOVERY_RELEASE: paths.release,
      NATIVE_STARTUP_SETTLED: paths.settled,
      NATIVE_STARTUP_UPSTREAM: paths.upstream,
      NATIVE_STARTUP_STOP: paths.stop,
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
}

async function stopChild(child: ReturnType<typeof Bun.spawn>, paths: ReturnType<typeof childPaths>): Promise<void> {
  writeFileSync(paths.release, "release");
  writeFileSync(paths.stop, "stop");
  const exit = await Promise.race([child.exited, Bun.sleep(10_000).then(() => null)]);
  if (exit === null) {
    child.kill();
    await child.exited;
    throw new Error("startup child did not stop");
  }
  if (exit !== 0) throw new Error(await new Response(child.stderr).text());
}

async function mainRequest(port: number): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "gpt-5.5", input: "startup gate", stream: false }),
  });
}

const recoverable: Array<{ phase: Phase; observation: Observation; active: "source" | "target" }> = [
  ...(["prepared", "auth-replaced", "vault-committed"] as const).flatMap(phase => [
    { phase, observation: "source-exact" as const, active: "source" as const },
    { phase, observation: "source-changed" as const, active: "source" as const },
    { phase, observation: "target-exact" as const, active: "target" as const },
    { phase, observation: "target-changed" as const, active: "target" as const },
  ]),
];

describe("native-main startup journal gate", () => {
  test("unowned service homes close native-main admission without starting ownership", async () => {
    const foreign = blockNativeMainStartupForUnownedServiceHome("foreign-ownership");
    const unknown = blockNativeMainStartupForUnownedServiceHome("ownership-unknown");
    try {
      expect(nativeMainStartupGateSnapshot()).toEqual({
        status: "blocked",
        homeId: null,
        reason: "foreign-ownership",
      });
      expect(isNativeMainTrafficBlocked()).toBe(true);
      expect(tryClaimNativeMainProfileForTurn()).toBe(false);
      expect(tryAcquireNativeMainProfileClaim()).toBeNull();
      expect(getNativeMainProfileRequestCount()).toBe(0);

      expect(await initializeNativeMainStartupGate({
        manager: { context: { homeId: "competing-owned-home" } } as unknown as NativeProfileManager,
        probeRecoveryState: () => "none",
      })).toEqual({ status: "ready", homeId: "competing-owned-home" });
      expect(nativeMainStartupGateSnapshot()).toEqual({
        status: "blocked",
        homeId: null,
        reason: "foreign-ownership",
      });

      await foreign.release();
      expect(isNativeMainTrafficBlocked()).toBe(true);
      expect(nativeMainStartupGateSnapshot()).toEqual({
        status: "blocked",
        homeId: null,
        reason: "ownership-unknown",
      });
      await foreign.release();
      expect(isNativeMainTrafficBlocked()).toBe(true);
      await unknown.release();
      expect(isNativeMainTrafficBlocked()).toBe(false);
      expect(nativeMainStartupGateSnapshot()).toEqual({ status: "ready", homeId: "competing-owned-home" });
    } finally {
      await foreign.release();
      await unknown.release();
    }
  });

  test("combined turn and standalone claims reject retained recovery before native-main reads", async () => {
    const homeId = "home-combined-admission";
    resetLifecycleDrainStateForTests();
    await initializeNativeMainStartupGate({
      manager: { context: { homeId }, recover: async () => ({}) } as unknown as NativeProfileManager,
      probeRecoveryState: () => "manual",
    });
    const turn = tryAdmitTurn();
    expect(turn).not.toBeNull();
    try {
      expect(tryClaimNativeMainProfileForTurn(turn ?? undefined)).toBe(false);
      expect(tryAcquireNativeMainProfileClaim()).toBeNull();
      expect(getNativeMainProfileRequestCount()).toBe(0);
    } finally {
      turn?.release();
      await initializeNativeMainStartupGate({
        manager: { context: { homeId }, recover: async () => ({}) } as unknown as NativeProfileManager,
        probeRecoveryState: () => "none",
      });
      resetLifecycleDrainStateForTests();
    }

    const allowed = tryAcquireNativeMainProfileClaim();
    expect(allowed).not.toBeNull();
    allowed?.release();
  });

  test("post-claim recovery race keeps the caller-owned turn alive while skipping native reads", () => {
    let checks = 0;
    let releases = 0;
    const lease = { release: () => { releases += 1; } };
    const claimed = tryClaimNativeMainProfileForTurn(lease, {
      isTrafficBlocked: () => checks++ > 0,
      claimTurn: () => true,
    });

    expect(claimed).toBe(false);
    expect(checks).toBe(2);
    expect(releases).toBe(0);
  });

  test("manual and unreadable recovery states close the main gate without automatic recovery", async () => {
    let recoverCalls = 0;
    for (const state of ["manual", "unreadable"] as const) {
      const homeId = `home-${state}`;
      const gate = await initializeNativeMainStartupGate({
        manager: {
          context: { homeId },
          recover: async () => { recoverCalls += 1; return {}; },
        } as unknown as NativeProfileManager,
        probeRecoveryState: () => state,
      });
      expect(gate).toEqual({ status: "blocked", homeId, reason: "manual-recovery" });
      expect(nativeMainStartupGateSnapshot()).toEqual(gate);
    }
    expect(recoverCalls).toBe(0);
  });

  test("journal recovery opens only after the post-recovery probe reaches none", async () => {
    const states = ["journal", "none"] as const;
    let recoverCalls = 0;
    const homeId = "home-journal-recovered";
    const gate = await initializeNativeMainStartupGate({
      manager: {
        context: { homeId },
        recover: async () => { recoverCalls += 1; return { recovered: true }; },
      } as unknown as NativeProfileManager,
      probeRecoveryState: () => states.shift() ?? "none",
    });
    expect(gate).toEqual({ status: "ready", homeId });
    expect(recoverCalls).toBe(1);
  });

  test("marker-only restart remains blocked after a malformed journal is quarantined", async () => {
    const f = await fixture("prepared", "target-exact");
    writeFileSync(f.manager.context.journalPath, "{malformed-journal\n");
    writeFileSync(f.manager.context.authPath, f.target);
    await expect(f.manager.recover(true, true)).rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });
    expect(existsSync(f.manager.context.journalPath)).toBe(false);
    expect(existsSync(f.manager.context.recoveryBlockPath)).toBe(true);

    const gate = await initializeNativeMainStartupGate({ manager: f.manager });
    expect(gate).toEqual({
      status: "blocked",
      homeId: f.manager.context.homeId,
      reason: "manual-recovery",
    });
  });

  test("a clean live switch that retains its journal closes the matching gate", async () => {
    const f = await fixture("prepared", "source-exact");
    await expect(f.manager.recover(false)).resolves.toMatchObject({ recovered: true });
    expect(probeNativeProfileRecoveryState(f.manager.context)).toBe("none");

    const faultingManager = new NativeProfileManager({
      codexHome: f.codexHome,
      configDir: f.configDir,
      keyProvider: new MemoryKeyProvider(f.key),
      hardenPath: async () => {},
      processProbe: async () => ({ status: "clear", count: 0 }),
      onSwitchBoundary: async boundary => {
        if (boundary === "vault-committed") throw new Error("inject retained journal");
      },
    });
    await initializeNativeMainStartupGate({ manager: faultingManager });
    expect(nativeMainStartupGateSnapshot()).toEqual({
      status: "ready",
      homeId: f.manager.context.homeId,
    });

    const request = new Request("http://localhost/api/native-main-profiles/switch", {
      method: "POST",
      body: JSON.stringify({ target: f.targetProfileId, confirmedStopped: true }),
    });
    const response = await handleNativeProfileAPI(request, new URL(request.url), {} as OcxConfig, {
      manager: faultingManager,
    });

    expect(response?.status).toBe(409);
    expect(await response?.json()).toMatchObject({ code: "RECOVERY_REQUIRED" });
    expect(probeNativeProfileRecoveryState(faultingManager.context)).toBe("journal");
    expect(nativeMainStartupGateSnapshot()).toEqual({
      status: "blocked",
      homeId: f.manager.context.homeId,
      reason: "recovery-pending",
    });
    expect(isNativeMainTrafficBlocked()).toBe(true);
  });

  test("a switch error after real journal convergence preserves the selector error and reopens main", async () => {
    const f = await fixture("prepared", "source-exact");
    await initializeNativeMainStartupGate({
      manager: f.manager,
      // Arm the matching startup gate without consuming the real journal; the
      // API switch below owns and exercises the actual convergence path.
      probeRecoveryState: () => "manual",
    });
    expect(probeNativeProfileRecoveryState(f.manager.context)).toBe("journal");
    expect(isNativeMainTrafficBlocked()).toBe(true);

    const request = new Request("http://localhost/api/native-main-profiles/switch", {
      method: "POST",
      body: JSON.stringify({ target: "missing-after-recovery", confirmedStopped: true }),
    });
    const response = await handleNativeProfileAPI(request, new URL(request.url), {} as OcxConfig, {
      manager: f.manager,
    });

    expect(response?.status).toBe(404);
    expect(await response?.json()).toMatchObject({ code: "PROFILE_NOT_FOUND" });
    expect(probeNativeProfileRecoveryState(f.manager.context)).toBe("none");
    expect(nativeMainStartupGateSnapshot()).toMatchObject({ status: "ready", homeId: f.manager.context.homeId });
    expect(isNativeMainTrafficBlocked()).toBe(false);
  });

  test("a failed real recovery that retains its journal preserves recovery-required and keeps main blocked", async () => {
    const f = await fixture("prepared", "third");
    await initializeNativeMainStartupGate({
      manager: f.manager,
      probeRecoveryState: () => "manual",
    });
    const request = new Request("http://localhost/api/native-main-profiles/switch", {
      method: "POST",
      body: JSON.stringify({ target: "missing-after-recovery", confirmedStopped: true }),
    });
    const response = await handleNativeProfileAPI(request, new URL(request.url), {} as OcxConfig, {
      manager: f.manager,
    });

    expect(response?.status).toBe(409);
    expect(await response?.json()).toMatchObject({ code: "RECOVERY_REQUIRED" });
    expect(probeNativeProfileRecoveryState(f.manager.context)).toBe("journal");
    expect(nativeMainStartupGateSnapshot()).toMatchObject({ status: "blocked", homeId: f.manager.context.homeId });
    expect(isNativeMainTrafficBlocked()).toBe(true);
  });

  test("explicit recovery reopens a stale matching gate after another manager converges the shared home", async () => {
    const f = await fixture("prepared", "source-exact");
    await initializeNativeMainStartupGate({
      manager: f.manager,
      probeRecoveryState: () => "manual",
    });
    expect(nativeMainStartupGateSnapshot()).toMatchObject({
      status: "blocked",
      homeId: f.manager.context.homeId,
    });

    const otherConfigDir = join(f.root, "opencodex-other");
    mkdirSync(otherConfigDir, { mode: 0o700 });
    const otherManager = new NativeProfileManager({
      codexHome: f.codexHome,
      configDir: otherConfigDir,
      keyProvider: new MemoryKeyProvider(f.key),
      hardenPath: async () => {},
      processProbe: async () => ({ status: "clear", count: 0 }),
    });
    expect(otherManager.context.journalPath).toBe(f.manager.context.journalPath);
    expect(otherManager.context.recoveryBlockPath).toBe(f.manager.context.recoveryBlockPath);
    expect(otherManager.context.stagingRoot).not.toBe(f.manager.context.stagingRoot);
    expect(await otherManager.recover(false)).toMatchObject({ recovered: true });
    expect(probeNativeProfileRecoveryState(f.manager.context)).toBe("none");
    expect(isNativeMainTrafficBlocked()).toBe(true);

    const request = new Request("http://localhost/api/native-main-profiles/recover", {
      method: "POST",
      body: JSON.stringify({ rollback: false }),
    });
    const response = await handleNativeProfileAPI(request, new URL(request.url), {} as OcxConfig, {
      manager: f.manager,
    });

    expect(response?.status).toBe(200);
    expect(await response?.json()).toMatchObject({ recovered: false });
    expect(nativeMainStartupGateSnapshot()).toMatchObject({
      status: "ready",
      homeId: f.manager.context.homeId,
    });
    expect(isNativeMainTrafficBlocked()).toBe(false);
  });

  test("fresh processes gate first admission and converge every recoverable phase/observation", async () => {
    for (const scenario of recoverable) {
      const f = await fixture(scenario.phase, scenario.observation);
      const paths = childPaths(f);
      const child = spawnChild(f, paths);
      try {
        const port = await waitForPort(paths.port);
        const blocked = await mainRequest(port);
        expect(blocked.status).toBeGreaterThanOrEqual(400);
        expect(existsSync(paths.upstream)).toBe(false);

        writeFileSync(paths.release, "release");
        await waitForPath(paths.settled);
        expect(JSON.parse(readFileSync(paths.settled, "utf8"))).toMatchObject({ gate: { status: "ready" } });
        const allowed = await mainRequest(port);
        if (allowed.status !== 200) {
          throw new Error(`${scenario.phase}/${scenario.observation}: ${allowed.status} ${await allowed.text()} settled=${readFileSync(paths.settled, "utf8")}`);
        }
        expect(existsSync(paths.upstream)).toBe(true);
        const active = (await f.manager.list()).activeProfileId;
        expect(active).toBe(scenario.active === "target" ? f.targetProfileId : f.sourceProfileId);
      } finally {
        await stopChild(child, paths);
      }
    }
  }, 120_000);

  test("manual observations keep main closed while health and explicit recovery remain available", async () => {
    for (const observation of ["unreadable", "third"] as const) {
      const f = await fixture("prepared", observation);
      const paths = childPaths(f);
      const child = spawnChild(f, paths);
      try {
        const port = await waitForPort(paths.port);
        expect((await mainRequest(port)).status).toBeGreaterThanOrEqual(400);
        expect(existsSync(paths.upstream)).toBe(false);
        expect((await fetch(`http://127.0.0.1:${port}/healthz`)).status).toBe(200);

        writeFileSync(paths.release, "release");
        await waitForPath(paths.settled);
        expect(JSON.parse(readFileSync(paths.settled, "utf8"))).toMatchObject({ gate: { status: "blocked", reason: "manual-recovery" } });
        expect((await mainRequest(port)).status).toBeGreaterThanOrEqual(400);
        expect(existsSync(paths.upstream)).toBe(false);

        writeFileSync(join(f.codexHome, "auth.json"), f.target);
        const recovered = await fetch(`http://127.0.0.1:${port}/api/native-main-profiles/recover`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-opencodex-api-key": "startup-test-admin" },
          body: JSON.stringify({ rollback: false }),
        });
        expect(recovered.status).toBe(200);
        expect((await mainRequest(port)).status).toBe(200);
        expect(existsSync(paths.upstream)).toBe(true);
      } finally {
        await stopChild(child, paths);
      }
    }
  }, 45_000);

  test("a pending native-main journal does not block an ordinary Pool account", async () => {
    const f = await fixture("prepared", "unreadable", true);
    const paths = childPaths(f);
    const child = spawnChild(f, paths);
    try {
      const port = await waitForPort(paths.port);
      expect((await mainRequest(port)).status).toBe(200);
      await waitForPath(paths.upstream);
      const receipt = JSON.parse(readFileSync(paths.upstream, "utf8").trim());
      expect(receipt.authorization).toBe("Bearer pool-access");
    } finally {
      await stopChild(child, paths);
    }
  }, 20_000);
});

/*
 * #2108: after a Windows reboot the fence never lifts until `ocx restart`.
 *
 * `startServer` takes the ownership verdict ONCE and holds it for the process lifetime.
 * That is right for `foreign-ownership` — a foreign owner is a fact, and re-asking would
 * only give a determined caller a second chance. It is wrong for `ownership-unknown`,
 * which means the probe could not answer: waiting cannot help, which is exactly why the
 * reporter had to restart.
 *
 * The retry is deliberately NOT automatic-on-a-timer. It re-probes when a native request
 * actually arrives, so an idle proxy does no work, and it is capped so a permanently
 * unaskable host cannot spin.
 */
describe("an unknown service-ownership fence is retryable (#2108)", () => {
  afterEach(() => {
    __resetNativeMainOwnershipRetries();
  });

  test("a later successful probe reopens the gate without a restart", () => {
    let answer: NativeCodexOwnership = "unknown";
    const fence = blockNativeMainStartupForUnownedServiceHome("ownership-unknown", {
      reprobe: () => answer,
      expectedHomeId: OWNERSHIP_REPROBE_TEST_HOME,
      startOwnedLifecycle: startReadyOwnershipRetryLifecycle,
    });
    try {
      expect(isNativeMainTrafficBlocked()).toBe(true);

      answer = "owned";

      expect(isNativeMainTrafficBlocked()).toBe(false);
    } finally {
      void fence.release();
    }
  });

  test("a later successful probe starts owned recovery before reopening admission", async () => {
    let answer: NativeCodexOwnership = "unknown";
    let finishRecovery!: () => void;
    const recoveryBarrier = new Promise<void>(resolve => { finishRecovery = resolve; });
    const f = await fixture("prepared", "source-exact");
    let currentHomeId: string | null = f.manager.context.homeId;
    let ownedReleases = 0;
    const prepared = prepareNativeMainStartupLifecycle({
      manager: f.manager,
      beforeRecovery: () => recoveryBarrier,
      owner: { retryMs: 10, hardenPath: async () => {} },
      currentHomeId: () => currentHomeId,
    }, {
      codexHome: f.codexHome,
      configDir: f.configDir,
    });
    expect(prepared).not.toBeNull();
    const fence = blockNativeMainStartupForUnownedServiceHome("ownership-unknown", {
      reprobe: () => answer,
      expectedHomeId: f.manager.context.homeId,
      startOwnedLifecycle: () => {
        const owned = prepared!.start();
        return {
          get homeId() { return owned.homeId; },
          get settled() { return owned.settled; },
          async release() {
            ownedReleases += 1;
            await owned.release();
          },
        };
      },
    });
    try {
      expect(isNativeMainTrafficBlocked()).toBe(true);
      answer = "owned";

      currentHomeId = "different-home";
      expect(isNativeMainTrafficBlocked()).toBe(true);
      expect(nativeMainStartupGateSnapshot()).toMatchObject({
        status: "blocked",
        reason: "ownership-unknown",
      });
      currentHomeId = f.manager.context.homeId;

      expect(isNativeMainTrafficBlocked()).toBe(true);
      expect(fence.homeId).toBe(f.manager.context.homeId);
      expect(nativeMainStartupGateSnapshot()).toEqual({
        status: "blocked",
        homeId: f.manager.context.homeId,
        reason: "recovery-pending",
      });

      finishRecovery();
      await fence.settled;
      expect(isNativeMainTrafficBlocked()).toBe(false);
    } finally {
      currentHomeId = f.manager.context.homeId;
      finishRecovery();
      await fence.release();
      await fence.release();
    }
    expect(ownedReleases).toBe(1);
  });

  test("startServer promotes one pinned unknown scope through the owned lifecycle", async () => {
    const f = await fixture("prepared", "source-exact", false, "direct");
    process.env.CODEX_HOME = f.codexHome;
    process.env.OPENCODEX_HOME = f.configDir;
    let answer: NativeCodexOwnership = "unknown";
    let finishRecovery!: () => void;
    const recoveryBarrier = new Promise<void>(resolve => { finishRecovery = resolve; });
    const scopes: Array<{
      currentHomes?: { codexHome: string; opencodexHome: string };
      statePaths?: readonly string[];
    }> = [];
    const server = startServer(0, {
      inspectNativeCodexOwnership: (scope = {}) => {
        scopes.push({
          currentHomes: scope.currentHomes ? { ...scope.currentHomes } : undefined,
          statePaths: scope.statePaths ? [...scope.statePaths] : undefined,
        });
        return { ownership: answer, reason: "pinned startup test" };
      },
      nativeMainStartup: {
        manager: f.manager,
        beforeRecovery: () => recoveryBarrier,
        owner: { retryMs: 10, hardenPath: async () => {} },
      },
    });
    try {
      expect(tryAcquireNativeMainProfileClaim()).toBeNull();
      answer = "owned";

      expect(tryAcquireNativeMainProfileClaim()).toBeNull();
      expect(nativeMainStartupGateSnapshot()).toEqual({
        status: "blocked",
        homeId: f.manager.context.homeId,
        reason: "recovery-pending",
      });
      expect(scopes.length).toBeGreaterThanOrEqual(3);
      const firstScope = scopes[0]!;
      expect(firstScope.currentHomes).toEqual({
        codexHome: f.codexHome,
        opencodexHome: f.configDir,
      });
      expect(firstScope.statePaths?.[0]).toBe(join(f.configDir, "service-state.json"));
      for (const scope of scopes.slice(1)) expect(scope).toEqual(firstScope);

      finishRecovery();
      expect(await waitForNativeMainStartupGate()).toEqual({
        status: "ready",
        homeId: f.manager.context.homeId,
      });
      const allowed = tryAcquireNativeMainProfileClaim();
      expect(allowed).not.toBeNull();
      allowed?.release();
    } finally {
      finishRecovery();
      await server.stop(true);
    }
  });

  test("startServer rejects initially owned activation after the inspected homes drift", async () => {
    const inspected = await fixture("prepared", "source-exact", false, "direct");
    process.env.CODEX_HOME = inspected.codexHome;
    process.env.OPENCODEX_HOME = inspected.configDir;
    let inspections = 0;
    let started: ReturnType<typeof startServer> | undefined;
    try {
      expect(() => {
        started = startServer(0, {
          inspectNativeCodexOwnership: scope => {
            inspections += 1;
            expect(scope.currentHomes).toEqual({
              codexHome: inspected.codexHome,
              opencodexHome: inspected.configDir,
            });
            expect(scope.statePaths?.[0]).toBe(join(inspected.configDir, "service-state.json"));
            return { ownership: "owned", reason: "initially owned pinned scope test" };
          },
          nativeMainStartup: {
            manager: inspected.manager,
            currentHomeId: () => null,
            owner: { retryMs: 10, hardenPath: async () => {} },
          },
        });
      }).toThrow("The native-main startup home changed after ownership inspection.");
    } finally {
      await started?.stop(true);
    }
    expect(inspections).toBe(2);
  });

  test("startServer keeps a retry when service homes are initially unavailable", async () => {
    const f = await fixture("prepared", "source-exact", false, "direct");
    process.env.CODEX_HOME = f.codexHome;
    process.env.OPENCODEX_HOME = f.configDir;
    let homesReady = false;
    let statePathsReady = false;
    let homeResolutions = 0;
    let answer: NativeCodexOwnership = "unknown";
    let finishRecovery!: () => void;
    const recoveryBarrier = new Promise<void>(resolve => { finishRecovery = resolve; });
    const scopes: Array<{
      currentHomes?: { codexHome: string; opencodexHome: string };
      statePaths?: readonly string[];
    }> = [];
    const server = startServer(0, {
      resolveServiceHomes: () => {
        homeResolutions += 1;
        if (!homesReady) throw new Error("service homes are not mounted yet");
        return {
          codexHome: f.codexHome,
          opencodexHome: statePathsReady ? f.configDir : (null as unknown as string),
        };
      },
      inspectNativeCodexOwnership: (scope = {}) => {
        scopes.push({
          currentHomes: scope.currentHomes ? { ...scope.currentHomes } : undefined,
          statePaths: scope.statePaths ? [...scope.statePaths] : undefined,
        });
        return { ownership: answer, reason: "deferred startup scope test" };
      },
      nativeMainStartup: {
        manager: f.manager,
        beforeRecovery: () => recoveryBarrier,
        owner: { retryMs: 10, hardenPath: async () => {} },
      },
    });
    try {
      expect(homeResolutions).toBe(1);
      expect(scopes).toHaveLength(0);
      expect(nativeMainStartupGateSnapshot()).toEqual({
        status: "blocked",
        homeId: null,
        reason: "ownership-unknown",
      });

      homesReady = true;
      answer = "owned";
      expect(tryAcquireNativeMainProfileClaim()).toBeNull();
      expect(homeResolutions).toBe(2);
      expect(scopes).toHaveLength(0);
      expect(nativeMainStartupGateSnapshot()).toEqual({
        status: "blocked",
        homeId: null,
        reason: "ownership-unknown",
      });

      statePathsReady = true;
      expect(tryAcquireNativeMainProfileClaim()).toBeNull();
      expect(homeResolutions).toBe(3);
      expect(nativeMainStartupGateSnapshot()).toEqual({
        status: "blocked",
        homeId: f.manager.context.homeId,
        reason: "recovery-pending",
      });

      const pinnedScopes = scopes.filter(scope => scope.currentHomes !== undefined);
      expect(pinnedScopes.length).toBeGreaterThanOrEqual(1);
      for (const scope of pinnedScopes) {
        expect(scope.currentHomes).toEqual({
          codexHome: f.codexHome,
          opencodexHome: f.configDir,
        });
        expect(scope.statePaths?.[0]).toBe(join(f.configDir, "service-state.json"));
      }

      finishRecovery();
      expect(await waitForNativeMainStartupGate()).toEqual({
        status: "ready",
        homeId: f.manager.context.homeId,
      });
      const allowed = tryAcquireNativeMainProfileClaim();
      expect(allowed).not.toBeNull();
      allowed?.release();
    } finally {
      finishRecovery();
      await server.stop(true);
    }
  });

  test("startServer retries lifecycle preparation after a pinned home appears", async () => {
    const f = await fixture("prepared", "source-exact", false, "direct");
    const lateCodexHome = join(f.root, "late-codex-home");
    process.env.CODEX_HOME = lateCodexHome;
    process.env.OPENCODEX_HOME = f.configDir;
    let answer: NativeCodexOwnership = "unknown";
    let finishRecovery!: () => void;
    const recoveryBarrier = new Promise<void>(resolve => { finishRecovery = resolve; });
    const server = startServer(0, {
      inspectNativeCodexOwnership: scope => ({
        ownership: answer,
        reason: scope.currentHomes?.codexHome === lateCodexHome
          ? "pinned missing home test"
          : "unexpected startup scope",
      }),
      nativeMainStartup: {
        beforeRecovery: () => recoveryBarrier,
        owner: { retryMs: 10, hardenPath: async () => {} },
      },
    });
    try {
      expect(nativeMainStartupGateSnapshot()).toEqual({
        status: "blocked",
        homeId: null,
        reason: "ownership-unknown",
      });

      answer = "owned";
      expect(tryAcquireNativeMainProfileClaim()).toBeNull();
      expect(nativeMainStartupGateSnapshot()).toEqual({
        status: "blocked",
        homeId: null,
        reason: "ownership-unknown",
      });

      mkdirSync(lateCodexHome, { recursive: true });
      expect(tryAcquireNativeMainProfileClaim()).toBeNull();
      const pending = nativeMainStartupGateSnapshot();
      expect(pending).toMatchObject({ status: "blocked", reason: "recovery-pending" });
      expect(pending.homeId).not.toBeNull();

      finishRecovery();
      expect(await waitForNativeMainStartupGate()).toEqual({
        status: "ready",
        homeId: pending.homeId,
      });
      const allowed = tryAcquireNativeMainProfileClaim();
      expect(allowed).not.toBeNull();
      allowed?.release();
    } finally {
      finishRecovery();
      await server.stop(true);
    }
  });

  test("an owned activation failure keeps the fence and retry hook intact", () => {
    let activationFails = true;
    let activations = 0;
    const fence = blockNativeMainStartupForUnownedServiceHome("ownership-unknown", {
      reprobe: () => "owned",
      expectedHomeId: OWNERSHIP_REPROBE_TEST_HOME,
      startOwnedLifecycle: () => {
        activations += 1;
        if (activationFails) throw new Error("test activation failure");
        return startReadyOwnershipRetryLifecycle();
      },
    });
    try {
      expect(isNativeMainTrafficBlocked()).toBe(true);
      expect(nativeMainStartupGateSnapshot()).toEqual({
        status: "blocked",
        homeId: null,
        reason: "ownership-unknown",
      });

      activationFails = false;
      expect(isNativeMainTrafficBlocked()).toBe(false);
      expect(activations).toBe(2);
    } finally {
      void fence.release();
    }
  });

  test("activation re-entry stays fenced and starts the owned lifecycle once", () => {
    let activations = 0;
    let reentrantBlocked: boolean | undefined;
    const fence = blockNativeMainStartupForUnownedServiceHome("ownership-unknown", {
      reprobe: () => "owned",
      expectedHomeId: OWNERSHIP_REPROBE_TEST_HOME,
      startOwnedLifecycle: () => {
        activations += 1;
        reentrantBlocked = isNativeMainTrafficBlocked();
        return startReadyOwnershipRetryLifecycle();
      },
    });
    try {
      expect(isNativeMainTrafficBlocked()).toBe(false);
      expect(reentrantBlocked).toBe(true);
      expect(activations).toBe(1);
    } finally {
      void fence.release();
    }
  });

  test("probe re-entry stays fenced and consumes one bounded attempt", () => {
    let probes = 0;
    let activations = 0;
    let reentrantBlocked: boolean | undefined;
    const fence = blockNativeMainStartupForUnownedServiceHome("ownership-unknown", {
      reprobe: () => {
        probes += 1;
        reentrantBlocked = isNativeMainTrafficBlocked();
        return "owned";
      },
      expectedHomeId: OWNERSHIP_REPROBE_TEST_HOME,
      startOwnedLifecycle: () => {
        activations += 1;
        return startReadyOwnershipRetryLifecycle();
      },
    });
    try {
      expect(isNativeMainTrafficBlocked()).toBe(false);
      expect(reentrantBlocked).toBe(true);
      expect(probes).toBe(1);
      expect(activations).toBe(1);
    } finally {
      void fence.release();
    }
  });

  test("preparing an injected manager rejects a different pinned home", async () => {
    const one = await fixture("prepared", "source-exact");
    const other = await fixture("prepared", "source-exact");
    expect(prepareNativeMainStartupLifecycle(
      { manager: one.manager },
      { codexHome: other.codexHome, configDir: other.configDir },
    )).toBeNull();
  });

  test("stale activation cleanup is joined by the wrapper release flight", async () => {
    let finishOrphanRelease!: () => void;
    const orphanBarrier = new Promise<void>(resolve => { finishOrphanRelease = resolve; });
    let orphanReleases = 0;
    let fence!: NativeMainStartupLifecycle;
    fence = blockNativeMainStartupForUnownedServiceHome("ownership-unknown", {
      reprobe: () => "owned",
      expectedHomeId: OWNERSHIP_REPROBE_TEST_HOME,
      startOwnedLifecycle: () => {
        void fence.release();
        return {
          homeId: OWNERSHIP_REPROBE_TEST_HOME,
          settled: Promise.resolve({ status: "ready", homeId: OWNERSHIP_REPROBE_TEST_HOME }),
          release: async () => {
            orphanReleases += 1;
            await orphanBarrier;
          },
        };
      },
    });
    expect(isNativeMainTrafficBlocked()).toBe(true);
    let releaseSettled = false;
    const release = fence.release().then(() => { releaseSettled = true; });
    await Bun.sleep(0);
    expect(orphanReleases).toBe(1);
    expect(releaseSettled).toBe(false);
    finishOrphanRelease();
    await release;
    expect(releaseSettled).toBe(true);
  });

  test("server lifecycle cleanup callers join one release flight", async () => {
    const server = {};
    let finishRelease!: () => void;
    const releaseBarrier = new Promise<void>(resolve => { finishRelease = resolve; });
    let releases = 0;
    bindNativeMainStartupLifecycle(server, {
      homeId: OWNERSHIP_REPROBE_TEST_HOME,
      settled: Promise.resolve({ status: "ready", homeId: OWNERSHIP_REPROBE_TEST_HOME }),
      release: async () => {
        releases += 1;
        await releaseBarrier;
      },
    });
    let secondSettled = false;
    const first = releaseNativeMainStartupLifecycle(server);
    const second = releaseNativeMainStartupLifecycle(server).then(() => { secondSettled = true; });
    await Bun.sleep(0);
    expect(releases).toBe(1);
    expect(secondSettled).toBe(false);
    finishRelease();
    await Promise.all([first, second]);
    expect(releases).toBe(1);
    await releaseNativeMainStartupLifecycle(server);
    expect(releases).toBe(1);
  });

  test("a null or mismatched owned lifecycle never spends the unknown fence", async () => {
    for (const homeId of [null, "different-home"] as const) {
      let releases = 0;
      const gate = { status: "ready", homeId } as const;
      const fence = blockNativeMainStartupForUnownedServiceHome("ownership-unknown", {
        reprobe: () => "owned",
        expectedHomeId: OWNERSHIP_REPROBE_TEST_HOME,
        startOwnedLifecycle: () => ({
          homeId,
          settled: Promise.resolve(gate),
          release: async () => { releases += 1; },
        }),
      });
      try {
        expect(isNativeMainTrafficBlocked()).toBe(true);
        await Promise.resolve();
        expect(releases).toBe(1);
        expect(nativeMainStartupGateSnapshot()).toMatchObject({
          status: "blocked",
          reason: "ownership-unknown",
        });
      } finally {
        await fence.release();
      }
    }
  });

  test("a foreign owner is a fact, not a question — it never retries", () => {
    let asked = 0;
    let activations = 0;
    const fence = blockNativeMainStartupForUnownedServiceHome("foreign-ownership", {
      reprobe: () => { asked += 1; return "owned"; },
      expectedHomeId: OWNERSHIP_REPROBE_TEST_HOME,
      startOwnedLifecycle: () => {
        activations += 1;
        return startReadyOwnershipRetryLifecycle();
      },
    });
    try {
      expect(isNativeMainTrafficBlocked()).toBe(true);
      expect(isNativeMainTrafficBlocked()).toBe(true);
      expect(asked).toBe(0);
      expect(activations).toBe(0);
    } finally {
      void fence.release();
    }
  });

  test("a host that stays unaskable stops being asked", () => {
    let asked = 0;
    let activations = 0;
    const fence = blockNativeMainStartupForUnownedServiceHome("ownership-unknown", {
      reprobe: () => { asked += 1; return "unknown"; },
      expectedHomeId: OWNERSHIP_REPROBE_TEST_HOME,
      startOwnedLifecycle: () => {
        activations += 1;
        return startReadyOwnershipRetryLifecycle();
      },
    });
    try {
      for (let i = 0; i < 25; i++) isNativeMainTrafficBlocked();

      expect(isNativeMainTrafficBlocked()).toBe(true);
      expect(asked).toBe(NATIVE_MAIN_OWNERSHIP_RETRY_LIMIT);
      expect(activations).toBe(0);
    } finally {
      void fence.release();
    }
  });

  test("with no reprobe wired the fence behaves exactly as before", () => {
    const fence = blockNativeMainStartupForUnownedServiceHome("ownership-unknown");
    try {
      expect(isNativeMainTrafficBlocked()).toBe(true);
    } finally {
      void fence.release();
    }
  });
});

/*
 * Two defects an audit found in the first cut of the retryable fence, both from keying the
 * reprobe by REASON while the fence refcount is per-fence.
 */
describe("the retryable fence respects its own refcount (#2108)", () => {
  afterEach(() => {
    __resetNativeMainOwnershipRetries();
  });

  test("raising a second fence does not hand out a fresh retry budget", () => {
    let asked = 0;
    const probe = () => { asked += 1; return "unknown" as NativeCodexOwnership; };
    const first = blockNativeMainStartupForUnownedServiceHome("ownership-unknown", {
      reprobe: probe,
      expectedHomeId: OWNERSHIP_REPROBE_TEST_HOME,
      startOwnedLifecycle: startReadyOwnershipRetryLifecycle,
    });
    for (let i = 0; i < 20; i++) isNativeMainTrafficBlocked();
    const afterFirst = asked;

    const second = blockNativeMainStartupForUnownedServiceHome("ownership-unknown", {
      reprobe: probe,
      expectedHomeId: OWNERSHIP_REPROBE_TEST_HOME,
      startOwnedLifecycle: startReadyOwnershipRetryLifecycle,
    });
    try {
      for (let i = 0; i < 20; i++) isNativeMainTrafficBlocked();

      // A caller raising fences in a loop must not be able to spin the probe forever.
      expect(asked).toBe(afterFirst);
    } finally {
      void first.release();
      void second.release();
    }
  });

  test("one successful probe does not lift a fence it never spoke for", () => {
    const hookless = blockNativeMainStartupForUnownedServiceHome("ownership-unknown");
    const hooked = blockNativeMainStartupForUnownedServiceHome("ownership-unknown", {
      reprobe: () => "owned" as NativeCodexOwnership,
      expectedHomeId: OWNERSHIP_REPROBE_TEST_HOME,
      startOwnedLifecycle: startReadyOwnershipRetryLifecycle,
    });
    try {
      isNativeMainTrafficBlocked();

      // The hookless fence is still held, so traffic stays blocked until IT releases.
      expect(isNativeMainTrafficBlocked()).toBe(true);
    } finally {
      void hooked.release();
      void hookless.release();
    }
  });
});

/*
 * The audit noted the "foreign never retries" property was single-covered: the guard exists
 * in two places, and ablating either alone stayed green. This pins the OUTCOME rather than
 * one of the two implementations, so removing either is caught.
 */
describe("a foreign fence is never reopened by a probe (#2108)", () => {
  afterEach(() => {
    __resetNativeMainOwnershipRetries();
  });

  test("a foreign fence stays closed even when the host reports owned", () => {
    const fence = blockNativeMainStartupForUnownedServiceHome("foreign-ownership", {
      reprobe: () => "owned" as NativeCodexOwnership,
      expectedHomeId: OWNERSHIP_REPROBE_TEST_HOME,
      startOwnedLifecycle: () => { throw new Error("foreign ownership must never activate"); },
    });
    try {
      for (let i = 0; i < 10; i++) isNativeMainTrafficBlocked();

      expect(isNativeMainTrafficBlocked()).toBe(true);
      expect(nativeMainStartupGateSnapshot()).toMatchObject({ status: "blocked", reason: "foreign-ownership" });
    } finally {
      void fence.release();
    }
  });
});

/*
 * The double-decrement a second audit round found: the probe paid for the hooked fence, and
 * then that fence's own release() paid for it again. One fence, two decrements, so a fence
 * another holder still owns was lifted. Plus the wedge: once a hook was spent, no LATER
 * fence could install one, which is the #2108 symptom returning by another route.
 */
describe("a spent reprobe leaves the refcount coherent (#2108)", () => {
  afterEach(() => {
    __resetNativeMainOwnershipRetries();
  });

  test("the hooked fence's release does not pay twice for the same fence", () => {
    const hookless = blockNativeMainStartupForUnownedServiceHome("ownership-unknown");
    const hooked = blockNativeMainStartupForUnownedServiceHome("ownership-unknown", {
      reprobe: () => "owned" as NativeCodexOwnership,
      expectedHomeId: OWNERSHIP_REPROBE_TEST_HOME,
      startOwnedLifecycle: startReadyOwnershipRetryLifecycle,
    });
    try {
      isNativeMainTrafficBlocked();
      void hooked.release();

      // The hookless fence is still held by its owner and must keep traffic closed.
      expect(isNativeMainTrafficBlocked()).toBe(true);
    } finally {
      void hookless.release();
    }
    expect(isNativeMainTrafficBlocked()).toBe(false);
  });

  test("a fence raised after a spent probe still gets to re-ask", () => {
    let firstStarts = 0;
    const first = blockNativeMainStartupForUnownedServiceHome("ownership-unknown", {
      reprobe: () => "owned" as NativeCodexOwnership,
      expectedHomeId: OWNERSHIP_REPROBE_TEST_HOME,
      startOwnedLifecycle: () => {
        firstStarts += 1;
        return startReadyOwnershipRetryLifecycle();
      },
    });
    isNativeMainTrafficBlocked();
    void first.release();

    let asked = 0;
    let laterStarts = 0;
    const later = blockNativeMainStartupForUnownedServiceHome("ownership-unknown", {
      reprobe: () => { asked += 1; return "owned" as NativeCodexOwnership; },
      expectedHomeId: OWNERSHIP_REPROBE_TEST_HOME,
      startOwnedLifecycle: () => {
        laterStarts += 1;
        return startReadyOwnershipRetryLifecycle();
      },
    });
    try {
      isNativeMainTrafficBlocked();

      // A server started after an earlier probe must not be stuck needing `ocx restart`.
      expect(asked).toBeGreaterThan(0);
      expect(firstStarts).toBe(1);
      expect(laterStarts).toBe(1);
      expect(isNativeMainTrafficBlocked()).toBe(false);
    } finally {
      void later.release();
    }
  });

  // The wedge, by a third route. If a NON-owner fence's release dropped the entry, the
  // owner's hook would be destroyed and the fence stuck until `ocx restart` — the #2108
  // symptom. This class of bug recurred across three audit rounds, so the guard that
  // prevents it is pinned rather than merely present.
  test("a non-owner release does not destroy the owner's hook", () => {
    let asked = 0;
    const owner = blockNativeMainStartupForUnownedServiceHome("ownership-unknown", {
      reprobe: () => { asked += 1; return "owned" as NativeCodexOwnership; },
      expectedHomeId: OWNERSHIP_REPROBE_TEST_HOME,
      startOwnedLifecycle: startReadyOwnershipRetryLifecycle,
    });
    const other = blockNativeMainStartupForUnownedServiceHome("ownership-unknown");
    try {
      void other.release();

      isNativeMainTrafficBlocked();

      expect(asked).toBe(1);
    } finally {
      void owner.release();
    }
  });
});

/*
 * The multi-unit conflict branch was a fail-closed decision with nothing pinning it.
 */
