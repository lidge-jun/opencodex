import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
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
  initializeNativeMainStartupGate,
  isNativeMainTrafficBlocked,
  nativeMainStartupGateSnapshot,
} from "../src/codex/native-profile-startup";
import {
  tryAcquireNativeMainProfileClaim,
  tryClaimNativeMainProfileForTurn,
} from "../src/codex/native-main-admission";
import {
  getNativeMainProfileRequestCount,
  resetLifecycleDrainStateForTests,
  tryAdmitTurn,
} from "../src/server/lifecycle";

const roots: string[] = [];
const previousOpencodexHome = process.env.OPENCODEX_HOME;
const previousCodexHome = process.env.CODEX_HOME;

function restoreEnv(name: "OPENCODEX_HOME" | "CODEX_HOME", value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

afterEach(() => {
  restoreEnv("OPENCODEX_HOME", previousOpencodexHome);
  restoreEnv("CODEX_HOME", previousCodexHome);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
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

async function fixture(phase: Phase, observation: Observation, activePool = false): Promise<Fixture> {
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
        codexAccountMode: "pool",
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
async function waitForPort(path: string, timeoutMs = 10_000): Promise<number> {
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
    body: JSON.stringify({ model: "gpt-5.6-sol", input: "startup gate", stream: false }),
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
