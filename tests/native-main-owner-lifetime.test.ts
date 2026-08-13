import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { saveConfig } from "../src/config";
import { saveCodexAccountCredential } from "../src/codex/account-store";
import { MAIN_CODEX_ACCOUNT_ID } from "../src/codex/main-account";
import {
  NATIVE_MAIN_OWNER_DB,
  nativeMainOwnerFilesystemSupported,
  retainNativeMainOwner,
  withNativeMainOwnerOperation,
} from "../src/codex/native-main-owner";
import { NativeProfileManager } from "../src/codex/native-profile-manager";
import { probeNativeProfileRecoveryState } from "../src/codex/native-profile-store";
import type { NativeProfileKey, NativeProfileKeyProvider } from "../src/codex/native-profile-types";
import type { OcxConfig } from "../src/types";

const roots: string[] = [];
const previousCodexHome = process.env.CODEX_HOME;
const previousOpenCodexHome = process.env.OPENCODEX_HOME;

function restoreEnv(name: "CODEX_HOME" | "OPENCODEX_HOME", value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

afterEach(() => {
  restoreEnv("CODEX_HOME", previousCodexHome);
  restoreEnv("OPENCODEX_HOME", previousOpenCodexHome);
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

class MemoryKeyProvider implements NativeProfileKeyProvider {
  constructor(private readonly bytes: Buffer) {}
  async get(): Promise<NativeProfileKey> { return { keyRef: "memory:native-owner-test", key: Buffer.from(this.bytes) }; }
  async create(): Promise<NativeProfileKey> { return { keyRef: "memory:native-owner-test", key: Buffer.from(this.bytes) }; }
}

function auth(account: string, marker: string): string {
  return JSON.stringify({
    auth_mode: "chatgpt",
    tokens: {
      id_token: `id-${marker}`,
      access_token: `access-${marker}`,
      refresh_token: `refresh-${marker}`,
      account_id: account,
    },
  }, null, 2) + "\n";
}

interface Fixture {
  root: string;
  codexHome: string;
  configDir: string;
  key: Buffer;
  manager: NativeProfileManager;
}

function writeConfig(
  codexHome: string,
  configDir: string,
  active = MAIN_CODEX_ACCOUNT_ID,
  includePool = true,
): void {
  mkdirSync(configDir, { recursive: true });
  process.env.CODEX_HOME = codexHome;
  process.env.OPENCODEX_HOME = configDir;
  saveConfig({
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
      direct: {
        adapter: "openai-chat",
        baseUrl: "https://direct.example.com/v1",
        apiKey: "direct-test-key",
      },
    },
    codexAccounts: includePool ? [{ id: "pool-a", email: "pool@example.test", isMain: false }] : [],
    activeCodexAccountId: active,
    autoSwitchThreshold: 0,
  } as OcxConfig);
  if (includePool) {
    saveCodexAccountCredential("pool-a", {
      accessToken: "pool-access",
      refreshToken: "pool-refresh",
      expiresAt: Date.now() + 60 * 60_000,
      chatgptAccountId: "pool-account",
    });
  }
  restoreEnv("CODEX_HOME", previousCodexHome);
  restoreEnv("OPENCODEX_HOME", previousOpenCodexHome);
}

function fixture(configName = "opencodex", includePool = true): Fixture {
  const root = mkdtempSync(join(tmpdir(), "ocx-native-owner-"));
  roots.push(root);
  const codexHome = join(root, "codex");
  const configDir = join(root, configName);
  mkdirSync(codexHome, { recursive: true });
  writeFileSync(join(codexHome, "config.toml"), 'cli_auth_credentials_store = "file"\n');
  writeFileSync(join(codexHome, "auth.json"), auth("account-main", "main"));
  writeConfig(codexHome, configDir, MAIN_CODEX_ACCOUNT_ID, includePool);
  const key = Buffer.alloc(32, 0x5c);
  const manager = new NativeProfileManager({
    codexHome,
    configDir,
    keyProvider: new MemoryKeyProvider(key),
    hardenPath: async () => {},
    processProbe: async () => ({ status: "clear", count: 0 }),
  });
  return { root, codexHome, configDir, key, manager };
}

async function waitUntil<T>(probe: () => T | null, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = probe();
    if (value !== null) return value;
    await Bun.sleep(20);
  }
  throw new Error("timed out waiting for owner state");
}

type Event = Record<string, unknown>;

class ChildHarness {
  readonly child: ReturnType<typeof Bun.spawn>;
  readonly events: Event[] = [];
  readonly stderr: Promise<string>;
  private nextId = 0;
  private readonly waiters = new Set<() => void>();

  constructor(f: Fixture, extraEnv: Record<string, string> = {}) {
    this.child = Bun.spawn([process.execPath, join(import.meta.dir, "helpers", "native-main-owner-child.ts")], {
      cwd: join(import.meta.dir, ".."),
      env: {
        ...process.env,
        HOME: f.root,
        USERPROFILE: f.root,
        CODEX_HOME: f.codexHome,
        OPENCODEX_HOME: f.configDir,
        OPENCODEX_ADMIN_AUTH_TOKEN: "owner-test-admin",
        NATIVE_OWNER_CODEX_HOME: f.codexHome,
        NATIVE_OWNER_CONFIG_DIR: f.configDir,
        NATIVE_OWNER_KEY: f.key.toString("base64"),
        ...extraEnv,
      },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      windowsHide: true,
    });
    this.stderr = new Response(this.child.stderr).text();
    void (async () => {
      const reader = this.child.stdout.getReader();
      const decoder = new TextDecoder();
      let buffered = "";
      for (;;) {
        const { done, value } = await reader.read();
        buffered += decoder.decode(value, { stream: !done });
        const lines = buffered.split(/\r?\n/);
        buffered = done ? "" : lines.pop() ?? "";
        for (const line of lines) {
          if (!line.startsWith("@@native-owner@@")) continue;
          this.events.push(JSON.parse(line.slice("@@native-owner@@".length)) as Event);
          for (const wake of this.waiters) wake();
          this.waiters.clear();
        }
        if (done) break;
      }
    })();
  }

  async waitFor(predicate: (event: Event) => boolean, timeoutMs = 10_000): Promise<Event> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = this.events.find(predicate);
      if (found) return found;
      if (Date.now() >= deadline) {
        throw new Error(`child event timeout; events=${JSON.stringify(this.events)} stderr=${await this.stderr}`);
      }
      await Promise.race([
        new Promise<void>(resolve => this.waiters.add(resolve)),
        Bun.sleep(50),
      ]);
    }
  }

  async command(op: string, fields: Record<string, unknown> = {}): Promise<Event> {
    const id = String(++this.nextId);
    this.child.stdin.write(`${JSON.stringify({ id, op, ...fields })}\n`);
    await this.child.stdin.flush();
    return this.waitFor(event => event.event === "reply" && event.id === id);
  }

  async snapshot(predicate: (event: Event) => boolean, timeoutMs = 10_000): Promise<Event> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const event = await this.command("snapshot");
      if (predicate(event)) return event;
      await Bun.sleep(25);
    }
    throw new Error(`snapshot timeout; events=${JSON.stringify(this.events)}`);
  }

  async stop(): Promise<Event | null> {
    if (this.child.exitCode !== null) return null;
    const reply = await this.command("stop");
    expect(reply.ok).toBe(true);
    const exit = await Promise.race([this.child.exited, Bun.sleep(10_000).then(() => null)]);
    if (exit === null) throw new Error("child did not stop");
    if (exit !== 0) throw new Error(await this.stderr);
    return reply;
  }

  async hardKill(): Promise<void> {
    if (this.child.exitCode === null) this.child.kill(9);
    await this.child.exited;
  }
}

function isHeldReady(event: Event): boolean {
  const owner = event.owner as { status?: string } | undefined;
  const gate = event.gate as { status?: string } | undefined;
  return owner?.status === "held" && gate?.status === "ready";
}

function isContended(event: Event): boolean {
  const owner = event.owner as { status?: string } | undefined;
  const gate = event.gate as { reason?: string } | undefined;
  return owner?.status === "contended" && gate?.reason === "owner-conflict";
}

describe("native-main process owner lease", () => {
  test("one coded ACL timeout retries once before ownership becomes held", async () => {
    const f = fixture("acl-timeout-recovery");
    let attempts = 0;
    const trace: string[] = [];
    const owner = retainNativeMainOwner(f.manager.context, {
      retryMs: 10,
      hardenPath: async () => {
        attempts += 1;
        if (attempts === 1) throw Object.assign(new Error("transient"), { code: "ETIMEDOUT" });
      },
    });
    const unsubscribe = owner.subscribe(snapshot => { trace.push(snapshot.status); });
    try {
      await waitUntil(() => owner.snapshot().status === "held" ? true : null);
      expect(attempts).toBe(2);
      expect(trace).toEqual(["acquiring", "held"]);
    } finally {
      unsubscribe();
      await owner.release();
    }
  });

  test("a second coded ACL timeout becomes terminal and a release cancels a pending retry", async () => {
    const f = fixture("acl-timeout-terminal");
    let attempts = 0;
    const trace: string[] = [];
    const owner = retainNativeMainOwner(f.manager.context, {
      retryMs: 10,
      hardenPath: async () => {
        attempts += 1;
        throw Object.assign(new Error("transient"), { code: "ETIMEDOUT" });
      },
    });
    const unsubscribe = owner.subscribe(snapshot => { trace.push(snapshot.status); });
    try {
      await waitUntil(() => owner.snapshot().status === "unavailable" ? true : null);
      await Bun.sleep(50);
      expect(attempts).toBe(2);
      expect(trace).toEqual(["acquiring", "unavailable"]);
    } finally {
      unsubscribe();
      await owner.release();
    }

    const f2 = fixture("acl-timeout-release");
    let releasedAttempts = 0;
    const releasing = retainNativeMainOwner(f2.manager.context, {
      retryMs: 100,
      hardenPath: async () => {
        releasedAttempts += 1;
        throw Object.assign(new Error("transient"), { code: "ETIMEDOUT" });
      },
    });
    await waitUntil(() => releasedAttempts === 1 ? true : null);
    await releasing.release();
    await Bun.sleep(150);
    expect(releasedAttempts).toBe(1);
  });

  test("an ETIMEDOUT-looking message without the code remains a permanent failure", async () => {
    const f = fixture("acl-timeout-message-only");
    let attempts = 0;
    const owner = retainNativeMainOwner(f.manager.context, {
      retryMs: 10,
      hardenPath: async () => {
        attempts += 1;
        throw new Error("ETIMEDOUT in untrusted prose");
      },
    });
    try {
      await waitUntil(() => owner.snapshot().status === "unavailable" ? true : null);
      await Bun.sleep(50);
      expect(attempts).toBe(1);
    } finally {
      await owner.release();
    }
  });

  test("same-process references retain one owner and do not deadlock the transaction lock", async () => {
    const f = fixture();
    const first = retainNativeMainOwner(f.manager.context, { retryMs: 10, hardenPath: async () => {} });
    const second = retainNativeMainOwner(f.manager.context, { retryMs: 10, hardenPath: async () => {} });
    await waitUntil(() => first.snapshot().status === "held" ? first.snapshot() : null);

    const contender = () => {
      const database = new Database(join(f.codexHome, NATIVE_MAIN_OWNER_DB));
      try { database.exec("PRAGMA busy_timeout=0; BEGIN IMMEDIATE"); }
      finally { database.close(); }
    };
    expect(contender).toThrow();
    await expect(withNativeMainOwnerOperation(f.manager.context, () => f.manager.recover(false)))
      .resolves.toMatchObject({ recovered: false });

    await first.release();
    expect(contender).toThrow();
    await second.release();
    expect(contender).not.toThrow();
    expect(existsSync(join(f.codexHome, NATIVE_MAIN_OWNER_DB))).toBe(true);
  });

  test("distinct homes are independent and obvious network or WSL DrvFS paths are unsupported", async () => {
    const firstFixture = fixture("one");
    const secondFixture = fixture("two");
    const first = retainNativeMainOwner(firstFixture.manager.context, { hardenPath: async () => {} });
    const second = retainNativeMainOwner(secondFixture.manager.context, { hardenPath: async () => {} });
    await waitUntil(() => first.snapshot().status === "held" ? true : null);
    await waitUntil(() => second.snapshot().status === "held" ? true : null);
    expect(first.snapshot().status).toBe("held");
    expect(second.snapshot().status).toBe("held");
    expect(nativeMainOwnerFilesystemSupported("\\\\server\\share\\.codex", "win32", {})).toBe(false);
    expect(nativeMainOwnerFilesystemSupported("/mnt/c/Users/test/.codex", "linux", { WSL_INTEROP: "1" })).toBe(false);
    expect(nativeMainOwnerFilesystemSupported("/home/test/.codex", "linux", { WSL_INTEROP: "1" })).toBe(true);
    await first.release();
    await second.release();
  });

  test("a contender keeps Pool, Direct, health, and metadata usable before graceful takeover", async () => {
    const firstFixture = fixture("owner-a");
    const secondConfig = join(firstFixture.root, "owner-b");
    writeConfig(firstFixture.codexHome, secondConfig, MAIN_CODEX_ACCOUNT_ID, false);
    const secondFixture = { ...firstFixture, configDir: secondConfig };
    const first = new ChildHarness(firstFixture);
    let second: ChildHarness | undefined;
    let support: ChildHarness | undefined;
    try {
      await first.waitFor(event => event.event === "listening");
      await first.snapshot(isHeldReady);
      second = new ChildHarness(secondFixture);
      await second.waitFor(event => event.event === "listening");
      await second.snapshot(isContended);

      const supportConfig = join(firstFixture.root, "owner-support");
      writeConfig(firstFixture.codexHome, supportConfig);
      support = new ChildHarness({ ...firstFixture, configDir: supportConfig });
      await support.waitFor(event => event.event === "listening");
      await support.snapshot(isContended);
      expect((await support.command("set-mode", { mode: "pool" })).ok).toBe(true);
      const pool = await support.command("request", { kind: "pool" });
      expect(pool.status).toBe(200);
      expect((pool.lastReceipt as { authorization?: string }).authorization).toBe("Bearer pool-access");

      const direct = await support.command("request", { kind: "direct" });
      expect(direct).toMatchObject({ status: 200 });
      expect((direct.lastReceipt as { authorization?: string }).authorization).toBe("Bearer direct-test-key");
      expect((await support.command("request", { kind: "health" })).status).toBe(200);
      expect((await support.command("request", { kind: "management-list" })).status).toBe(200);
      await support.stop();

      const before = await second.command("snapshot");
      const main = await second.command("request", { kind: "main" });
      expect(Number(main.status)).toBeGreaterThanOrEqual(400);
      expect(main.upstreamCalls).toBe(before.upstreamCalls);
      const doctor = await second.command("request", { kind: "management-doctor" });
      expect(doctor.status).toBe(503);
      expect(doctor.text).toContain("NATIVE_MAIN_OWNER_BUSY");

      const stopped = await first.stop();
      expect(stopped?.owner).toBeNull();
      await second.snapshot(isHeldReady);
      const recoveredMain = await second.command("request", { kind: "main" });
      expect(recoveredMain.status).toBe(200);
      expect((recoveredMain.lastReceipt as { authorization?: string }).authorization).toBe("Bearer access-main");
    } finally {
      await first.stop().catch(() => first.hardKill());
      if (second) await second.stop().catch(() => second!.hardKill());
      if (support) await support.stop().catch(() => support!.hardKill());
    }
  }, 30_000);

  test("a hard-killed owner releases the OS lease and the successor recovers before opening main", async () => {
    const f = fixture("crash-a", false);
    const source = await f.manager.register("source");
    const stage = await f.manager.prepareStage();
    writeFileSync(join(stage.stagingCodexHome, "auth.json"), auth("account-target", "target"));
    const target = await f.manager.finishStage(stage.stageId, stage.writerToken, "target");
    expect(source.profile.state).toBe("active");

    const successorFixture = { ...f };
    const owner = new ChildHarness(f, { NATIVE_OWNER_HOLD_SWITCH_BOUNDARY: "auth-replaced" });
    let successor: ChildHarness | undefined;
    try {
      const listening = await owner.waitFor(event => event.event === "listening");
      await owner.snapshot(isHeldReady);
      const switchRequest = fetch(`http://127.0.0.1:${Number(listening.port)}/api/native-main-profiles/switch`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-opencodex-api-key": "owner-test-admin" },
        body: JSON.stringify({ target: target.profile.id, confirmedStopped: true }),
      }).catch(() => null);
      await owner.waitFor(event => event.event === "switch-boundary" && event.boundary === "auth-replaced");
      expect(probeNativeProfileRecoveryState(f.manager.context)).toBe("journal");

      successor = new ChildHarness(successorFixture);
      await successor.waitFor(event => event.event === "listening");
      await successor.snapshot(isContended);
      const before = await successor.command("snapshot");
      const blockedMain = await successor.command("request", { kind: "main" });
      expect(Number(blockedMain.status)).toBeGreaterThanOrEqual(400);
      expect(blockedMain.upstreamCalls).toBe(before.upstreamCalls);

      await owner.hardKill();
      await switchRequest;
      await successor.snapshot(isHeldReady);
      expect(probeNativeProfileRecoveryState(f.manager.context)).toBe("none");
      const main = await successor.command("request", { kind: "main" });
      expect(main.status).toBe(200);
      expect((main.lastReceipt as { authorization?: string }).authorization).toBe("Bearer access-target");
      expect(readFileSync(join(f.codexHome, "auth.json"), "utf8")).toContain("access-target");
    } finally {
      await owner.stop().catch(() => owner.hardKill());
      if (successor) await successor.stop().catch(() => successor!.hardKill());
    }
  }, 30_000);

  test("a successor scrubs a hard-killed production auth write before recovery or main admission", async () => {
    const f = fixture("temp-crash", false);
    const source = await f.manager.register("source");
    const stage = await f.manager.prepareStage();
    writeFileSync(join(stage.stagingCodexHome, "auth.json"), auth("account-target", "target"));
    const target = await f.manager.finishStage(stage.stageId, stage.writerToken, "target");
    expect(source.profile.state).toBe("active");

    const owner = new ChildHarness(f, { NATIVE_OWNER_HOLD_AUTH_TEMP: "1" });
    let successor: ChildHarness | undefined;
    try {
      const listening = await owner.waitFor(event => event.event === "listening");
      await owner.snapshot(isHeldReady);
      const switchRequest = fetch(`http://127.0.0.1:${Number(listening.port)}/api/native-main-profiles/switch`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-opencodex-api-key": "owner-test-admin" },
        body: JSON.stringify({ target: target.profile.id, confirmedStopped: true }),
      }).catch(() => null);
      const written = await Promise.race([
        owner.waitFor(event => event.event === "auth-temp-written"),
        switchRequest.then(async response => {
          if (response === null) throw new Error("switch connection closed before the auth temp write");
          throw new Error(`switch returned before the auth temp write: ${response.status} ${await response.text()}`);
        }),
      ]);
      const tempName = String(written.name);
      expect(tempName).toMatch(/^auth\.json\.ocx\.[1-9]\d*\.[1-9]\d*\.tmp$/);
      const tempPath = join(f.codexHome, tempName);
      expect(readFileSync(tempPath, "utf8")).toContain("access-target");
      expect(probeNativeProfileRecoveryState(f.manager.context)).toBe("journal");

      successor = new ChildHarness(f, { NATIVE_OWNER_HOLD_RECOVERY: "1" });
      await successor.waitFor(event => event.event === "listening");
      await successor.snapshot(isContended);
      await owner.hardKill();
      await switchRequest;

      await successor.waitFor(event => event.event === "before-recovery");
      expect(existsSync(tempPath)).toBe(false);
      expect(probeNativeProfileRecoveryState(f.manager.context)).toBe("journal");
      const blockedSnapshot = await successor.command("snapshot");
      const blockedMain = await successor.command("request", { kind: "main" });
      expect(Number(blockedMain.status)).toBeGreaterThanOrEqual(400);
      expect(blockedMain.upstreamCalls).toBe(blockedSnapshot.upstreamCalls);

      expect((await successor.command("release-recovery")).ok).toBe(true);
      await successor.snapshot(isHeldReady);
      expect(probeNativeProfileRecoveryState(f.manager.context)).toBe("none");
      const main = await successor.command("request", { kind: "main" });
      expect(main.status).toBe(200);
      expect((main.lastReceipt as { authorization?: string }).authorization).toBe("Bearer access-main");
    } finally {
      await owner.hardKill();
      if (successor) await successor.hardKill();
    }
  }, 45_000);

  test("an ambiguous exact residue keeps native-main startup fail closed", async () => {
    const f = fixture("unsafe-residue", false);
    const target = join(f.codexHome, "hardlink-target");
    const residue = join(f.codexHome, "auth.json.ocx.123.1.tmp");
    writeFileSync(target, "hardlink-private-value");
    linkSync(target, residue);
    const child = new ChildHarness(f);
    try {
      await child.waitFor(event => event.event === "listening");
      const blocked = await child.snapshot(event => {
        const owner = event.owner as { status?: string } | undefined;
        const gate = event.gate as { status?: string; reason?: string } | undefined;
        return owner?.status === "held" && gate?.status === "blocked" && gate.reason === "manual-recovery";
      });
      const main = await child.command("request", { kind: "main" });
      expect(Number(main.status)).toBeGreaterThanOrEqual(400);
      expect(main.upstreamCalls).toBe(blocked.upstreamCalls);
      expect(readFileSync(target, "utf8")).toBe("hardlink-private-value");
      expect(readFileSync(residue, "utf8")).toBe("hardlink-private-value");
    } finally {
      await child.stop().catch(() => child.hardKill());
    }
  }, 30_000);

  test("same-process server references retain ownership until the last server stops", async () => {
    const f = fixture("refs-a");
    const contenderConfig = join(f.root, "refs-b");
    writeConfig(f.codexHome, contenderConfig);
    const contenderFixture = { ...f, configDir: contenderConfig };
    const owner = new ChildHarness(f);
    let contender: ChildHarness | undefined;
    try {
      await owner.waitFor(event => event.event === "listening");
      await owner.snapshot(isHeldReady);
      const alias = resolve(f.codexHome, ".", "..", "codex", ".");
      const extra = await owner.command("start-extra-server", { codexHomeAlias: alias });
      expect(extra.ok).toBe(true);
      contender = new ChildHarness(contenderFixture);
      await contender.waitFor(event => event.event === "listening");
      await contender.snapshot(isContended);

      expect((await owner.command("stop-server", { index: 0 })).ok).toBe(true);
      await Bun.sleep(150);
      await contender.snapshot(isContended);

      expect((await owner.command("stop-server", { index: 1 })).ok).toBe(true);
      await contender.snapshot(isHeldReady);
    } finally {
      await owner.stop().catch(() => owner.hardKill());
      if (contender) await contender.stop().catch(() => contender!.hardKill());
    }
  }, 30_000);
});
