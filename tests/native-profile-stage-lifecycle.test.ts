import { afterEach, describe, expect, test } from "bun:test";
import {
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { NativeProfileManager } from "../src/codex/native-profile-manager";
import {
  startNativeMainStartupLifecycle,
  type NativeMainStartupLifecycle,
} from "../src/codex/native-profile-startup";
import { NativeProfileError, type NativeProfileKey, type NativeProfileKeyProvider } from "../src/codex/native-profile-types";

const roots: string[] = [];
const lifecycles: NativeMainStartupLifecycle[] = [];

afterEach(async () => {
  while (lifecycles.length > 0) await lifecycles.pop()!.release();
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 });
});

class MemoryKeyProvider implements NativeProfileKeyProvider {
  private readonly key = Buffer.alloc(32, 0x71);
  async get(): Promise<NativeProfileKey> { return { keyRef: "memory:stage-lifecycle", key: Buffer.from(this.key) }; }
  async create(): Promise<NativeProfileKey> { return { keyRef: "memory:stage-lifecycle", key: Buffer.from(this.key) }; }
}

function auth(accountId: string, marker: string): string {
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

async function atomic(path: string, content: string): Promise<void> {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.stage-test.tmp`;
  writeFileSync(temp, content, { mode: 0o600 });
  renameSync(temp, path);
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "ocx-stage-lifecycle-"));
  roots.push(root);
  const codexHome = join(root, "codex");
  const configDir = join(root, "opencodex");
  mkdirSync(codexHome, { recursive: true });
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(codexHome, "config.toml"), 'cli_auth_credentials_store = "file"\n');
  writeFileSync(join(codexHome, "auth.json"), auth("account-source", "source"));
  let now = 1_800_000_000_000;
  const manager = new NativeProfileManager({
    codexHome,
    configDir,
    keyProvider: new MemoryKeyProvider(),
    atomicWrite: atomic,
    hardenPath: async () => {},
    processProbe: async () => ({ status: "clear", count: 0 }),
    now: () => now,
    stageLeaseMs: 1_000,
  });
  return {
    root,
    manager,
    target: auth("account-target", "target"),
    advance(ms: number) { now += ms; },
  };
}

function emptyFixture(options: { lockUnavailable?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), "ocx-empty-stage-lifecycle-"));
  roots.push(root);
  const codexHome = join(root, "codex");
  const configDir = join(root, "opencodex");
  mkdirSync(codexHome, { recursive: true });
  mkdirSync(configDir, { recursive: true });
  let profileLockAttempts = 0;
  const unavailable = Object.assign(new Error("injected unavailable profile lock"), { code: "EACCES" });
  const manager = new NativeProfileManager({
    codexHome,
    configDir,
    keyProvider: new MemoryKeyProvider(),
    atomicWrite: atomic,
    hardenPath: async () => {},
    processProbe: async () => ({ status: "clear", count: 0 }),
    ...(options.lockUnavailable ? {
      stableLockOpen: () => {
        profileLockAttempts += 1;
        throw unavailable;
      },
    } : {}),
  });
  return { root, manager, profileLockAttempts: () => profileLockAttempts };
}

async function caught(operation: () => Promise<unknown>): Promise<NativeProfileError> {
  try {
    await operation();
  } catch (error) {
    expect(error).toBeInstanceOf(NativeProfileError);
    return error as NativeProfileError;
  }
  throw new Error("expected native-profile operation to fail");
}

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) await Bun.sleep(20);
  if (!predicate()) throw new Error("timed out waiting for native stage lifecycle");
}

describe("native main stage writer lifecycle", () => {
  test("zero-profile startup stays ready without acquiring the profile transaction lock (#1120)", async () => {
    const f = emptyFixture({ lockUnavailable: true });
    expect(await f.manager.list()).toMatchObject({ activeProfileId: null, profiles: [] });
    expect(f.manager.stageSweepRequired()).toBe(false);

    const lifecycle = startNativeMainStartupLifecycle({
      manager: f.manager,
      owner: { retryMs: 10, hardenPath: async () => {} },
      stageSweepIntervalMs: 20,
    });
    lifecycles.push(lifecycle);

    expect(await lifecycle.settled).toMatchObject({ status: "ready" });
    await Bun.sleep(75);
    expect(f.profileLockAttempts()).toBe(0);
  });

  test("a present stage artifact keeps the locked fail-closed sweep (#1120)", async () => {
    const f = emptyFixture({ lockUnavailable: true });
    mkdirSync(f.manager.context.stagingRoot, { recursive: true });
    expect(f.manager.stageSweepRequired()).toBe(true);

    const lifecycle = startNativeMainStartupLifecycle({
      manager: f.manager,
      owner: { retryMs: 10, hardenPath: async () => {} },
      stageSweepIntervalMs: 10_000,
    });
    lifecycles.push(lifecycle);

    expect(await lifecycle.settled).toMatchObject({
      status: "blocked",
      reason: "stage-cleanup-required",
    });
    expect(f.profileLockAttempts()).toBeGreaterThan(0);
  });

  test("requires the writer token and heartbeat protects a live login beyond its original lease", async () => {
    const f = fixture();
    await f.manager.register("source");
    const stage = await f.manager.prepareStage();
    const wrong = "wrong-writer-token-that-is-long-enough-for-validation";

    expect((await caught(() => f.manager.heartbeatStage(stage.stageId, wrong))).code).toBe("STAGING_NOT_FOUND");
    expect((await caught(() => f.manager.finishStage(stage.stageId, wrong, "target"))).code).toBe("STAGING_NOT_FOUND");
    expect((await caught(() => f.manager.cancelStage(stage.stageId, wrong))).code).toBe("STAGING_NOT_FOUND");
    expect(existsSync(stage.stagingCodexHome)).toBe(true);

    const registry = readFileSync(f.manager.context.stageRegistryPath, "utf8");
    const marker = readFileSync(join(stage.stagingCodexHome, "stage.json"), "utf8");
    expect(registry).not.toContain(stage.writerToken);
    expect(marker).not.toContain(stage.writerToken);
    expect(registry).not.toContain("access-source");
    expect(registry).not.toContain("refresh-source");

    f.advance(900);
    const renewed = await f.manager.heartbeatStage(stage.stageId, stage.writerToken);
    expect(renewed.leaseExpiresAt).toBeGreaterThan(stage.leaseExpiresAt);
    f.advance(200);
    expect((await f.manager.sweepStages()).live).toBe(1);
    expect(existsSync(stage.stagingCodexHome)).toBe(true);

    writeFileSync(join(stage.stagingCodexHome, "auth.json"), f.target);
    const finished = await f.manager.finishStage(stage.stageId, stage.writerToken, "target");
    expect(finished.plaintextMayRemain).toBe(false);
    expect(existsSync(stage.stagingCodexHome)).toBe(false);
    expect((await caught(() => f.manager.heartbeatStage(stage.stageId, stage.writerToken))).code).toBe("STAGING_NOT_FOUND");
  });

  test("an abandoned writer expires, is scrubbed, and cannot revive its stage", async () => {
    const f = fixture();
    await f.manager.register("source");
    const stage = await f.manager.prepareStage();
    writeFileSync(join(stage.stagingCodexHome, "auth.json"), f.target);
    f.advance(1_001);

    const expired = await caught(() => f.manager.heartbeatStage(stage.stageId, stage.writerToken));
    expect(expired.code).toBe("STAGING_EXPIRED");
    expect(expired.plaintextMayRemain).toBe(false);
    expect(existsSync(stage.stagingCodexHome)).toBe(false);
    expect((await caught(() => f.manager.heartbeatStage(stage.stageId, stage.writerToken))).code).toBe("STAGING_NOT_FOUND");
  });

  test("a recreated stage path fails closed and is never blessed by a late heartbeat", async () => {
    const f = fixture();
    await f.manager.register("source");
    const stage = await f.manager.prepareStage();
    const marker = readFileSync(join(stage.stagingCodexHome, "stage.json"), "utf8");
    const displaced = `${stage.stagingCodexHome}.displaced`;
    renameSync(stage.stagingCodexHome, displaced);
    mkdirSync(stage.stagingCodexHome, { mode: 0o700 });
    writeFileSync(join(stage.stagingCodexHome, "stage.json"), marker, { mode: 0o600 });
    writeFileSync(join(stage.stagingCodexHome, "auth.json"), f.target, { mode: 0o600 });

    const error = await caught(() => f.manager.heartbeatStage(stage.stageId, stage.writerToken));
    expect(error.code).toBe("PROFILE_STORAGE_UNSAFE");
    expect(error.plaintextMayRemain).toBe(true);
    expect(existsSync(stage.stagingCodexHome)).toBe(true);
    expect(existsSync(displaced)).toBe(true);
  });

  test("writer-held-open cleanup either proves truncation or reports possible plaintext until retry", async () => {
    const f = fixture();
    await f.manager.register("source");
    const stage = await f.manager.prepareStage();
    const authPath = join(stage.stagingCodexHome, "auth.json");
    writeFileSync(authPath, f.target, { mode: 0o600 });
    const fd = openSync(authPath, "r+");
    let closed = false;
    try {
      try {
        const cleanup = await f.manager.cancelStage(stage.stageId, stage.writerToken);
        expect(cleanup).toEqual({ removed: true, plaintextMayRemain: false });
        expect(fstatSync(fd).size).toBe(0);
      } catch (error) {
        expect(error).toBeInstanceOf(NativeProfileError);
        expect((error as NativeProfileError).code).toBe("STAGING_CLEANUP_REQUIRED");
        expect((error as NativeProfileError).plaintextMayRemain).toBe(true);
        closeSync(fd);
        closed = true;
        expect(await f.manager.cancelStage(stage.stageId, stage.writerToken)).toEqual({
          removed: true,
          plaintextMayRemain: false,
        });
      }
    } finally {
      if (!closed) closeSync(fd);
    }
  });

  test("the owner performs startup and recursive scheduled sweeps", async () => {
    const f = fixture();
    await f.manager.register("source");
    const startupResidue = await f.manager.prepareStage();
    writeFileSync(join(startupResidue.stagingCodexHome, "auth.json"), f.target);
    f.advance(1_001);

    const lifecycle = startNativeMainStartupLifecycle({
      manager: f.manager,
      owner: { retryMs: 10, hardenPath: async () => {} },
      stageSweepIntervalMs: 20,
    });
    lifecycles.push(lifecycle);
    expect((await lifecycle.settled).status).toBe("ready");
    expect(existsSync(startupResidue.stagingCodexHome)).toBe(false);

    const scheduledResidue = await f.manager.prepareStage();
    writeFileSync(join(scheduledResidue.stagingCodexHome, "auth.json"), f.target);
    f.advance(1_001);
    await waitFor(() => !existsSync(scheduledResidue.stagingCodexHome));
    expect(readFileSync(f.manager.context.stageRegistryPath, "utf8")).not.toContain(scheduledResidue.stageId);
  }, 10_000);
});
