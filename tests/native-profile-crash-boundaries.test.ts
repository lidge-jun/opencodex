import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { saveConfig } from "../src/config";
import { MAIN_CODEX_ACCOUNT_ID } from "../src/codex/main-account";
import { NativeProfileManager, type NativeProfileSwitchBoundary } from "../src/codex/native-profile-manager";
import { readNativeProfileJournal, readNativeProfileVault } from "../src/codex/native-profile-store";
import type { NativeProfileKey, NativeProfileKeyProvider } from "../src/codex/native-profile-types";
import type { OcxConfig } from "../src/types";
import { INTERNAL_DEADLINE_MS } from "./helpers/test-budget";
import { watchdogMs } from "./helpers/ci-watchdog";

/**
 * How long to wait for a spawned startup child to publish its port file.
 *
 * That wait is intrinsic: the child is a real `ocx` startup that binds a port and
 * writes the file, and these cases exist to drive its crash and teardown
 * branches. But a fixed 10s is a latency assertion on the Windows shards, which
 * run four Bun pools on one runner -- the bounded-teardown case died on "timed
 * out waiting for ...\\port" before reaching the teardown it is named for.
 */
const STARTUP_FILE_WAIT_MS = watchdogMs(10_000);

/**
 * Budget for a case that spawns startup children, derived from the wait above.
 *
 * A fixed 20s or 30s silently became SHORTER than the CI wait it contains, which
 * kills the case before its own wait can name the step that stalled. Two child
 * spawns plus a bounded teardown fit inside three of those waits.
 */
const STARTUP_CHILD_BUDGET_MS = Math.max(30_000, STARTUP_FILE_WAIT_MS * 3);

const roots: string[] = [];
const oldOcx = process.env.OPENCODEX_HOME;
const oldCodex = process.env.CODEX_HOME;

function restoreEnv(name: "OPENCODEX_HOME" | "CODEX_HOME", value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

afterEach(() => {
  restoreEnv("OPENCODEX_HOME", oldOcx);
  restoreEnv("CODEX_HOME", oldCodex);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

class MemoryKeyProvider implements NativeProfileKeyProvider {
  constructor(private readonly bytes: Buffer) {}
  async get(): Promise<NativeProfileKey> { return { keyRef: "memory:switch-test", key: Buffer.from(this.bytes) }; }
  async create(): Promise<NativeProfileKey> { return { keyRef: "memory:switch-test", key: Buffer.from(this.bytes) }; }
}

function envelope(accountId: string, marker: string): string {
  return ` {\n  "auth_mode": "chatgpt",\n  "tokens": {\n    "id_token": "opaque-id-${marker}",\n    "access_token": "opaque-access-${marker}",\n    "refresh_token": "opaque-refresh-${marker}",\n    "account_id": "${accountId}"\n  }\n}\n`;
}

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "ocx-native-crash-"));
  roots.push(root);
  const home = join(root, "home");
  const codexHome = join(home, ".codex");
  const configDir = join(home, ".opencodex");
  mkdirSync(codexHome, { recursive: true });
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(codexHome, "config.toml"), 'cli_auth_credentials_store = "file"\n');
  const source = envelope("account-source", "source");
  const target = envelope("account-target", "target");
  writeFileSync(join(codexHome, "auth.json"), source);
  const key = Buffer.alloc(32, 0x33);
  const manager = new NativeProfileManager({
    codexHome,
    configDir,
    keyProvider: new MemoryKeyProvider(key),
    hardenPath: async () => {},
    processProbe: async () => ({ status: "clear", count: 0 }),
  });
  const sourceProfile = (await manager.register("source")).profile;
  const stage = await manager.prepareStage();
  writeFileSync(join(stage.stagingCodexHome, "auth.json"), target);
  const targetProfile = (await manager.finishStage(stage.stageId, stage.writerToken, "target")).profile;
  const initialRevision = readNativeProfileVault(manager.context)!.revision;

  process.env.OPENCODEX_HOME = configDir;
  process.env.CODEX_HOME = codexHome;
  saveConfig({
    port: 0,
    hostname: "127.0.0.1",
    defaultProvider: "openai",
    providers: { openai: { adapter: "openai-responses", baseUrl: "https://chatgpt.com/backend-api/codex", authMode: "forward", codexAccountMode: "pool" } },
    codexAccounts: [],
    activeCodexAccountId: MAIN_CODEX_ACCOUNT_ID,
    autoSwitchThreshold: 0,
  } as OcxConfig);
  restoreEnv("OPENCODEX_HOME", oldOcx);
  restoreEnv("CODEX_HOME", oldCodex);
  return { root, home, codexHome, configDir, source, target, key, manager, sourceProfile, targetProfile, initialRevision };
}

async function waitFor(path: string, timeout = STARTUP_FILE_WAIT_MS): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!existsSync(path) && Date.now() < deadline) await Bun.sleep(10);
  if (!existsSync(path)) throw new Error(`timed out waiting for ${path}`);
}

/*
 * #1061. `waitFor` proves a file EXISTS, which is not the precondition a caller
 * that immediately parses it actually needs — a partially written document
 * satisfies the wait and then throws `Unexpected EOF`. This waits for the real
 * precondition instead.
 */
async function waitForJson<T>(path: string, timeout = STARTUP_FILE_WAIT_MS): Promise<T> {
  const deadline = Date.now() + timeout;
  let lastError: unknown;
  while (Date.now() < deadline) {
    if (existsSync(path)) {
      try {
        return JSON.parse(readFileSync(path, "utf8")) as T;
      } catch (error) {
        lastError = error;
      }
    }
    await Bun.sleep(10);
  }
  throw new Error(`timed out waiting for parseable JSON in ${path}`, { cause: lastError });
}

const KILL_GRACE_MS = 2_000;

/*
 * #1061. The teardown used to `await child.exited` with no deadline, so a child
 * stalled in `server.stop(true)` hung the run until CI killed the job — a
 * 30-minute wait for a test that had already done its work. Every wait here is
 * bounded, including the ones after a signal: an ignored SIGTERM would otherwise
 * reproduce the same hang one layer down.
 */
async function stopStartup(
  child: Bun.Subprocess,
  paths: { release: string; stop: string },
  timeoutMs: number = INTERNAL_DEADLINE_MS,
): Promise<void> {
  writeFileSync(paths.release, "recover");
  writeFileSync(paths.stop, "stop");
  const exit = await Promise.race([child.exited, Bun.sleep(timeoutMs).then(() => null)]);
  if (exit === null) {
    child.kill();
    const killed = await Promise.race([child.exited, Bun.sleep(KILL_GRACE_MS).then(() => null)]);
    if (killed === null) {
      child.kill("SIGKILL");
      // Observe the escalation before throwing, so a caller asserting on
      // `exitCode` is not racing the reap.
      await Promise.race([child.exited, Bun.sleep(KILL_GRACE_MS).then(() => null)]);
    }
    throw new Error("startup child did not stop");
  }
  if (exit !== 0) throw new Error(`startup child exited ${exit}`);
}

function spawnSwitch(f: Awaited<ReturnType<typeof fixture>>, options: { boundary?: NativeProfileSwitchBoundary; marker?: string; release?: string; contention?: string; result: string }) {
  return Bun.spawn([process.execPath, join(import.meta.dir, "helpers", "native-profile-switch-child.ts")], {
    cwd: join(import.meta.dir, ".."),
    env: {
      ...process.env,
      HOME: f.home,
      USERPROFILE: f.home,
      CODEX_HOME: f.codexHome,
      OPENCODEX_HOME: f.configDir,
      NATIVE_SWITCH_CODEX_HOME: f.codexHome,
      NATIVE_SWITCH_CONFIG_DIR: f.configDir,
      NATIVE_SWITCH_KEY: f.key.toString("base64"),
      NATIVE_SWITCH_RESULT: options.result,
      ...(options.boundary ? { NATIVE_SWITCH_CRASH_BOUNDARY: options.boundary } : {}),
      ...(options.marker ? { NATIVE_SWITCH_MARKER: options.marker } : {}),
      ...(options.release ? { NATIVE_SWITCH_RELEASE: options.release } : {}),
      ...(options.contention ? { NATIVE_SWITCH_CONTENTION: options.contention } : {}),
    },
    stdin: "ignore", stdout: "pipe", stderr: "pipe",
  });
}

function startupPaths(f: Awaited<ReturnType<typeof fixture>>) {
  return { port: join(f.root, "port"), release: join(f.root, "recover"), settled: join(f.root, "settled"), upstream: join(f.root, "upstream"), stop: join(f.root, "stop") };
}

function spawnStartup(
  f: Awaited<ReturnType<typeof fixture>>,
  p: ReturnType<typeof startupPaths>,
  extraEnv: Record<string, string> = {},
) {
  return Bun.spawn([process.execPath, join(import.meta.dir, "helpers", "native-profile-startup-child.ts")], {
    cwd: join(import.meta.dir, ".."),
    env: {
      ...process.env, HOME: f.home, USERPROFILE: f.home, CODEX_HOME: f.codexHome, OPENCODEX_HOME: f.configDir,
      OPENCODEX_ADMIN_AUTH_TOKEN: "crash-test-admin",
      NATIVE_STARTUP_CODEX_HOME: f.codexHome, NATIVE_STARTUP_CONFIG_DIR: f.configDir,
      NATIVE_STARTUP_KEY: f.key.toString("base64"), NATIVE_STARTUP_KEY_REF: "memory:switch-test", NATIVE_STARTUP_PORT: p.port,
      NATIVE_STARTUP_RECOVERY_RELEASE: p.release, NATIVE_STARTUP_SETTLED: p.settled,
      NATIVE_STARTUP_UPSTREAM: p.upstream, NATIVE_STARTUP_STOP: p.stop,
      ...extraEnv,
    },
    stdin: "ignore", stdout: "pipe", stderr: "pipe",
  });
}

async function mainRequest(port: number) {
  return fetch(`http://127.0.0.1:${port}/v1/responses`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "gpt-5.5", input: "crash recovery", stream: false }) });
}

const boundaries: Array<{
  boundary: NativeProfileSwitchBoundary;
  auth: "source" | "target";
  owner: "source" | "target";
  phase: "prepared" | "auth-replaced" | "vault-committed" | null;
}> = [
  { boundary: "journal-prepared", auth: "source", owner: "source", phase: "prepared" },
  { boundary: "auth-replaced", auth: "target", owner: "source", phase: "prepared" },
  { boundary: "vault-committed", auth: "target", owner: "target", phase: "auth-replaced" },
  { boundary: "runtime-transition-published", auth: "target", owner: "target", phase: "vault-committed" },
  { boundary: "journal-deleted", auth: "target", owner: "target", phase: null },
];

describe("native profile OpenCodex process-exit phases", () => {
  test("hard OpenCodex process exit after each published transaction phase converges exact auth, vault, journal, gate, and runtime bearer", async () => {
    for (const scenario of boundaries) {
      const f = await fixture();
      const marker = join(f.root, `crash-${scenario.boundary}`);
      const result = join(f.root, `result-${scenario.boundary}`);
      const child = spawnSwitch(f, { boundary: scenario.boundary, marker, result });
      await Promise.race([
        waitFor(marker),
        child.exited.then(async exit => {
          if (existsSync(marker)) return;
          const detail = existsSync(result) ? readFileSync(result, "utf8") : await new Response(child.stderr).text();
          throw new Error(`${scenario.boundary} child exited ${exit} before marker: ${detail}`);
        }),
      ]);
      expect(await child.exited).toBe(86);
      expect(existsSync(result)).toBe(false);

      expect(readFileSync(f.manager.context.authPath, "utf8")).toBe(scenario.auth === "source" ? f.source : f.target);
      const vault = readNativeProfileVault(f.manager.context)!;
      expect(vault.activeProfileId).toBe(scenario.owner === "source" ? f.sourceProfile.id : f.targetProfile.id);
      expect(vault.revision).toBe(f.initialRevision + (scenario.owner === "target" ? 1 : 0));
      const rawVault = readFileSync(f.manager.context.vaultPath, "utf8");
      expect(rawVault).not.toContain("opaque-access");
      expect(rawVault).not.toContain("opaque-refresh");
      const journal = readNativeProfileJournal(f.manager.context);
      expect(journal?.phase ?? null).toBe(scenario.phase);

      const p = startupPaths(f);
      const restart = spawnStartup(f, p);
      try {
        await waitFor(p.port);
        const port = Number(readFileSync(p.port, "utf8"));
        if (scenario.phase) {
          expect((await mainRequest(port)).status).toBeGreaterThanOrEqual(400);
          expect(existsSync(p.upstream)).toBe(false);
          writeFileSync(p.release, "recover");
        }
        expect(await waitForJson(p.settled)).toMatchObject({ gate: { status: "ready" } });
        expect((await mainRequest(port)).status).toBe(200);
        await waitFor(p.upstream);
        const receipt = JSON.parse(readFileSync(p.upstream, "utf8").trim().split("\n").at(-1)!);
        const finalTarget = scenario.boundary !== "journal-prepared";
        expect(receipt.authorization).toBe(`Bearer opaque-access-${finalTarget ? "target" : "source"}`);
        expect(readFileSync(f.manager.context.authPath, "utf8")).toBe(finalTarget ? f.target : f.source);
        const recoveredVault = readNativeProfileVault(f.manager.context)!;
        expect(recoveredVault.activeProfileId).toBe(finalTarget ? f.targetProfile.id : f.sourceProfile.id);
        expect(recoveredVault.revision).toBe(f.initialRevision + (finalTarget ? 1 : 0));
        expect(readNativeProfileJournal(f.manager.context)).toBeNull();
      } finally {
        await stopStartup(restart, p);
      }
    }
  }, 90_000);

  test("two concurrent real switches serialize to one commit without credential overlap", async () => {
    const f = await fixture();
    const firstReady = join(f.root, "first-ready");
    const firstRelease = join(f.root, "first-release");
    const firstResult = join(f.root, "first-result");
    const secondResult = join(f.root, "second-result");
    const secondContention = join(f.root, "second-contention");
    const first = spawnSwitch(f, { marker: firstReady, release: firstRelease, result: firstResult });
    let second: ReturnType<typeof spawnSwitch> | undefined;
    try {
      await waitFor(firstReady);
      second = spawnSwitch(f, { contention: secondContention, result: secondResult });
      await waitFor(secondContention);
      expect(existsSync(secondResult)).toBe(false);
      writeFileSync(firstRelease, "release");
      expect(await first.exited).toBe(0);
      expect(await second.exited).toBe(0);
      const results = [JSON.parse(readFileSync(firstResult, "utf8")), JSON.parse(readFileSync(secondResult, "utf8"))];
      if (results.filter(item => item.ok).length !== 1) throw new Error(`unexpected concurrent results: ${JSON.stringify(results)}`);
      expect(results.filter(item => !item.ok).map(item => item.code)).toEqual(["INVALID_REQUEST"]);
      expect(readFileSync(f.manager.context.authPath, "utf8")).toBe(f.target);
      expect(readNativeProfileVault(f.manager.context)!.activeProfileId).toBe(f.targetProfile.id);
      expect(readNativeProfileJournal(f.manager.context)).toBeNull();
    } finally {
      try { writeFileSync(firstRelease, "release"); } catch { /* fixture cleanup */ }
      if (first.exitCode === null) first.kill();
      if (second?.exitCode === null) second.kill();
      await first.exited;
      if (second) await second.exited;
    }
  }, STARTUP_CHILD_BUDGET_MS);

  /*
   * #1061 activation evidence for the teardown deadline. A green suite says nothing
   * about a timeout branch nobody drives, so this drives it: the child is told to
   * stall exactly where the reported hang occurred (before `server.stop(true)`),
   * and the teardown must give up and reap it instead of waiting forever.
   *
   * The reap assertion is the part that matters — it proves cleanup happened, not
   * merely that a deadline was noticed. A signalled child reports `signalCode`
   * rather than `exitCode`, so this checks that the process settled either way.
   */
  test("a stalled startup child is killed by the bounded teardown instead of hanging", async () => {
    const f = await fixture();
    const p = startupPaths(f);
    const child = spawnStartup(f, p, { OCX_TEST_STALL_ON_STOP: "1" });
    try {
      await waitFor(p.port);
      await expect(stopStartup(child, p, 1_000)).rejects.toThrow("startup child did not stop");
      expect(child.killed).toBe(true);
      expect(child.exitCode ?? child.signalCode).not.toBeNull();
    } finally {
      if (child.exitCode === null) {
        child.kill("SIGKILL");
        await child.exited;
      }
    }
  }, STARTUP_CHILD_BUDGET_MS);

  /*
   * #1061 the other half: the settled file is parsed the moment it appears, so a
   * reader that only checks existence sees a partial document. This drives that
   * exact sequence — partial content first, then the real document — and asserts
   * the wait holds out for something parseable.
   */
  test("waitForJson holds out for a complete document instead of parsing a partial write", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ocx-settled-race-"));
    const target = join(dir, "settled.json");
    try {
      writeFileSync(target, "{\"gate\":");   // what a half-finished write looks like
      const pending = waitForJson<{ gate: { status: string } }>(target, 5_000);
      await Bun.sleep(50);
      writeFileSync(target, JSON.stringify({ gate: { status: "ready" } }));
      expect(await pending).toMatchObject({ gate: { status: "ready" } });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 15_000);
});
