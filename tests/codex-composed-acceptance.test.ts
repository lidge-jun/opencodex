/**
 * Workstation-safe composed acceptance for the native-integration toggles.
 *
 * These tests deliberately execute `src/cli/index.ts` in child Bun processes
 * and use a real server.  Calling a route handler or an injector in this
 * process would miss exactly the configuration, runtime-record, and lock
 * boundaries this suite is intended to cover.
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { createHash } from "node:crypto";
import { Database } from "bun:sqlite";

import { watchdogMs } from "./helpers/ci-watchdog";

/**
 * Per-case budget. A case can start a server twice and stop it, so it must exceed the sum of
 * the watchdogs inside it or the case dies before the watchdog it was meant to bound can
 * report anything useful. On CI those watchdogs take the 30s floor, so this scales with them.
 */
const CASE_TIMEOUT_MS = process.env.CI === "true" ? 150_000 : 45_000;

import {
  canonicalizeCodexHome,
} from "../src/codex/codex-write-lock";
import {
  resolveCodexCoordinatorDatabasePath,
  resolveEffectiveUserIdentity,
} from "../src/codex/user-identity";
import { claimOwnedServiceHome } from "./helpers/owned-service-home";
import { SERVER_BUDGET_MS } from "./helpers/test-budget";

const repoRoot = resolve(import.meta.dir, "..");
const cliPath = resolve(repoRoot, "src/cli/index.ts");
const lockChildPath = resolve(repoRoot, "tests/helpers/codex-write-lock-child.ts");
const roots: Fixture[] = [];

type CliResult = { exitCode: number; stdout: string; stderr: string };
type RuntimeRecord = { pid: number; port: number; hostname?: string };
type StartedServer = {
  process: ReturnType<typeof Bun.spawn>;
  runtime: RuntimeRecord;
  /** Captured during start(): the child's streams can only be read once. */
  stdout: Promise<string>;
  stderr: Promise<string>;
};

/** A byte manifest: paths plus bytes, not mtimes or parsed JSON. */
function manifest(root: string): Record<string, string> {
  const entries: Record<string, string> = {};
  const walk = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      const stat = lstatSync(path);
      const key = relative(root, path);
      if (stat.isDirectory()) walk(path);
      else if (stat.isFile()) entries[key] = readFileSync(path).toString("base64");
      else entries[key] = `non-file:${stat.mode}`;
    }
  };
  walk(root);
  return entries;
}

/** The catalog/cache artifacts an explicit side-profile sync may legitimately write while OFF. */
function manifestWithoutCatalogArtifacts(entries: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(entries).filter(([key]) => !key.includes("opencodex-catalog") && key !== "models_cache.json"),
  );
}

async function waitFor<T>(
  read: () => T | null | Promise<T | null>,
  label: string,
  // These wait on a REAL `ocx start` child: spawn a Bun runtime, load the CLI, read config,
  // bind a port, then publish runtime-port.json. On the Windows shards that exceeded 10s
  // while the child was still alive and still working — `child exit=null` with both streams
  // open, which is a slow start, not a crash. The watchdog exists to bound a hung test, not
  // to assert startup latency, so it takes the repository's CI floor.
  timeoutMs = watchdogMs(10_000),
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== null) return value;
    // The record/marker above, rather than elapsed time, is the readiness
    // condition. This only yields while watching that explicit sentinel.
    await Bun.sleep(20);
  }
  throw new Error(`timed out waiting for ${label}`);
}

class Fixture {
  readonly root = mkdtempSync(join(tmpdir(), "ocx-composed-"));
  readonly codex = join(this.root, "codex");
  readonly ocx = join(this.root, "ocx");
  readonly homeA = join(this.root, "home-a");
  readonly homeB = join(this.root, "home-b");
  readonly userprofileA = join(this.root, "userprofile-a");
  readonly userprofileB = join(this.root, "userprofile-b");
  readonly runtime = join(this.root, "runtime");
  readonly provider = join(this.root, "fixture");
  readonly dataToken = "composed-data-token";
  readonly managementToken = "composed-admin-token";
  readonly lockPath: string;
  readonly lockAllowlist: string[];
  readonly serviceManagerEnv: Record<string, string>;
  readonly children: Array<ReturnType<typeof Bun.spawn>> = [];

  constructor() {
    for (const path of [this.codex, this.ocx, this.homeA, this.homeB, this.userprofileA, this.userprofileB, this.runtime, this.provider]) {
      mkdirSync(path, { recursive: true, mode: 0o700 });
    }
    this.lockPath = resolveCodexCoordinatorDatabasePath(resolveEffectiveUserIdentity(), realpathSync.native(this.codex));
    this.lockAllowlist = [this.lockPath, `${this.lockPath}-journal`, `${this.lockPath}-wal`, `${this.lockPath}-shm`];
    for (const path of this.lockAllowlist) {
      if (existsSync(path)) throw new Error(`lock preflight found pre-existing case path: ${path}`);
    }
    writeFileSync(join(this.codex, "config.toml"), 'model = "gpt-5"\n');
    this.serviceManagerEnv = claimOwnedServiceHome(this.codex, this.ocx, this.homeA).env;
  }

  env(home = this.homeA, userprofile = this.userprofileA): Record<string, string> {
    // Do not inherit ambient homes or proxy configuration.  `process.execPath`
    // is absolute, so a PATH is intentionally unnecessary for CLI children.
    return {
      HOME: home,
      USERPROFILE: userprofile,
      // Windows os.homedir() follows USERPROFILE, while POSIX follows HOME.
      // Pin the client-specific home so this fixture exercises the same Grok
      // installation on every platform instead of reporting not_installed.
      GROK_HOME: join(home, ".grok"),
      CODEX_HOME: this.codex,
      OPENCODEX_HOME: this.ocx,
      XDG_RUNTIME_DIR: this.runtime,
      OPENCODEX_API_AUTH_TOKEN: this.dataToken,
      // `/api/*` is the management plane, distinct from the data-plane token.
      // A fixed fixture value avoids reading the generated credential file.
      OPENCODEX_ADMIN_AUTH_TOKEN: this.managementToken,
      NO_PROXY: "127.0.0.1,localhost",
      // The env is a whitelist, so CI does not reach the child unless it is named. It must:
      // the CLI's Windows identity lookup keeps an 8s budget locally and widens on CI, and
      // without this the child spawned by a CI runner refuses with "Windows effective-account
      // lookup timed out" while powershell.exe is still starting.
      ...(process.env.CI === "true" ? { CI: "true" } : {}),
      ...this.serviceManagerEnv,
    };
  }

  writeConfig(overrides: Record<string, unknown> = {}): void {
    writeFileSync(join(this.ocx, "config.json"), JSON.stringify({
      port: 0,
      hostname: "127.0.0.1",
      syncResumeHistory: false,
      claudeCode: { systemEnv: false },
      providers: {
        fixture: {
          adapter: "openai-chat",
          baseUrl: "http://127.0.0.1:1/v1",
          apiKey: "fixture-key",
          allowPrivateNetwork: true,
          liveModels: false,
          models: ["fixture-model"],
        },
      },
      defaultProvider: "fixture",
      ...overrides,
    }, null, 2));
  }

  spawnCli(argv: string[], home = this.homeA, userprofile = this.userprofileA) {
    const child = Bun.spawn([process.execPath, cliPath, ...argv], {
      cwd: this.root,
      env: this.env(home, userprofile),
      stdout: "pipe",
      stderr: "pipe",
    });
    this.children.push(child);
    return child;
  }

  async runCli(
    argv: string[],
    home = this.homeA,
    userprofile = this.userprofileA,
    timeoutMs = watchdogMs(15_000),
  ): Promise<CliResult> {
    const child = this.spawnCli(argv, home, userprofile);
    const completed = await Promise.race([
      Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`CLI watchdog: ocx ${argv.join(" ")}`)), timeoutMs)),
    ]);
    const [stdout, stderr, exitCode] = completed;
    return { exitCode, stdout, stderr };
  }

  async start(): Promise<StartedServer> {
    const child = this.spawnCli(["start"]);
    const runtimePath = join(this.ocx, "runtime-port.json");
    // Capture the child's streams while we wait. Without this, a start that dies for a
    // concrete reason — a throw, a port bind refusal, a missing artifact — surfaces only as
    // "timed out waiting for runtime-port record", which is the symptom and never the cause.
    // That is exactly how the Windows failures read for two CI rounds.
    const stderr = new Response(child.stderr).text();
    const stdout = new Response(child.stdout).text();
    const diagnose = async (label: string): Promise<never> => {
      const exited = child.exitCode ?? (await Promise.race([
        child.exited,
        new Promise<null>(resolve => setTimeout(() => resolve(null), 500)),
      ]));
      const [err, out] = await Promise.all([
        Promise.race([stderr, new Promise<string>(resolve => setTimeout(() => resolve("<stderr still open>"), 500))]),
        Promise.race([stdout, new Promise<string>(resolve => setTimeout(() => resolve("<stdout still open>"), 500))]),
      ]);
      throw new Error(`${label}; child exit=${String(exited)}\n--- stderr ---\n${err.slice(-4000)}\n--- stdout ---\n${out.slice(-2000)}`);
    };
    const runtime = await waitFor(() => {
      if (!existsSync(runtimePath)) return null;
      try {
        const record = JSON.parse(readFileSync(runtimePath, "utf8")) as RuntimeRecord;
        return Number.isInteger(record.pid) && record.pid === child.pid && Number.isInteger(record.port) && record.port > 0
          ? record
          : null;
      } catch {
        return null;
      }
    }, "runtime-port record").catch(() => diagnose("timed out waiting for runtime-port record"));
    const health = await waitFor(async () => {
      try {
        const response = await fetch(`http://127.0.0.1:${runtime.port}/healthz`, { signal: AbortSignal.timeout(500) });
        const body = await response.json() as { pid?: unknown; port?: unknown };
        return response.ok && body.pid === child.pid && body.port === runtime.port ? body : null;
      } catch {
        return null;
      }
    }, "child /healthz");
    expect(health).toMatchObject({ pid: child.pid, port: runtime.port });
    return { process: child, runtime, stdout, stderr };
  }

  async stop(server: StartedServer): Promise<void> {
    if (server.process.exitCode === null) server.process.kill("SIGTERM");
    const exitCode = await Promise.race([
      server.process.exited,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("server shutdown watchdog")), watchdogMs(10_000))),
    ]);
    // Bun reports a forced SIGTERM as 128 + 15 on Windows; POSIX children may
    // run the CLI shutdown handler and exit cleanly instead.
    expect(exitCode === 0 || (process.platform === "win32" && exitCode === 143)).toBe(true);
  }

  async request(
    runtime: RuntimeRecord,
    path: string,
    init: RequestInit = {},
    // Scaled like every other budget in this file. This one was left unscaled, and it is what
    // actually failed `A-reduced` on Windows: the case has a 150 s ceiling and reported ~80 s
    // elapsed, so the outer budget was never the constraint — a single request hit this fixed
    // 10 s AbortSignal and aborted the case from inside (#2152).
    timeoutMs = watchdogMs(10_000),
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    const response = await fetch(`http://127.0.0.1:${runtime.port}${path}`, {
      ...init,
      headers: {
        "x-opencodex-api-key": this.managementToken,
        ...(init.body ? { "content-type": "application/json" } : {}),
        ...(init.headers ?? {}),
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
    return { status: response.status, body: await response.json() as Record<string, unknown> };
  }

  async cleanup(): Promise<void> {
    // Teardown must not be able to leave a child behind. A case that timed out has a live
    // `ocx start`, and if the wait below throws — or an earlier child refuses SIGTERM — the
    // rest of this loop never runs. The survivor is then killed by Bun's between-file
    // "killed N dangling process" sweep, which on the Windows shard surfaced as the NEXT
    // case failing with exit 143: one slow case cascading into unrelated ones.
    //
    // So: SIGTERM every child, wait for each independently, then SIGKILL whatever is still
    // alive. Errors are collected rather than thrown mid-loop.
    for (const child of this.children) {
      if (child.exitCode === null) child.kill("SIGTERM");
    }
    const stubborn: Array<ReturnType<typeof Bun.spawn>> = [];
    for (const child of this.children) {
      if (child.exitCode === null) {
        const exited = await Promise.race([
          child.exited.then(() => true),
          new Promise<boolean>(resolve => setTimeout(() => resolve(false), 10_000)),
        ]);
        if (!exited) stubborn.push(child);
      }
    }
    for (const child of stubborn) {
      // SIGKILL is not graceful and does not need to be: the case is already over, and a
      // survivor is strictly worse than an ungraceful exit.
      try { child.kill("SIGKILL"); } catch { /* already gone */ }
      await Promise.race([
        child.exited,
        new Promise<void>(resolve => setTimeout(resolve, 2_000)),
      ]);
    }
    // Re-resolve before the limited four-name removal: never glob or inspect a
    // shared runtime namespace beyond the exact identities this case created.
    const checked = resolveCodexCoordinatorDatabasePath(resolveEffectiveUserIdentity(), realpathSync.native(this.codex));
    if (checked !== this.lockPath) throw new Error("lock teardown identity changed");
    for (const path of this.lockAllowlist) {
      if (existsSync(path)) unlinkSync(path);
    }
    rmSync(this.root, { recursive: true, force: true });
  }
}

function fixture(): Fixture {
  const value = new Fixture();
  roots.push(value);
  return value;
}

afterEach(async () => {
  // One fixture's teardown failure must not strand the next fixture's children. Drain every
  // fixture, then report. Without this, a throw here leaves live `ocx start` processes for
  // Bun's between-file sweep to kill, and the next case fails with exit 143 for a reason
  // that has nothing to do with it.
  const failures: unknown[] = [];
  while (roots.length) {
    try {
      await roots.pop()!.cleanup();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) throw failures[0];
});

describe("WP13 composed toggle acceptance", () => {
  /** RED: read the server's startup config snapshot in the /api/sync route; a hand edit made after start is lost. */
  test("#1802: /api/sync applies the on-disk config, not the server's startup snapshot", async () => {
    const fx = fixture();
    fx.writeConfig({ clientIntegrations: { codex: false } });
    const server = await fx.start();
    try {
      // The server is now holding a config object from startup. Edit the file out of band,
      // exactly as a user editing config.json by hand would, so disk is strictly newer.
      const configPath = join(fx.ocx, "config.json");
      const onDisk = JSON.parse(readFileSync(configPath, "utf-8")) as Record<string, any>;
      onDisk.providers["hand-edited"] = {
        adapter: "openai-chat",
        baseUrl: "http://127.0.0.1:2/v1",
        apiKey: "hand-edited-key",
        allowPrivateNetwork: true,
        liveModels: false,
        models: ["hand-edited-model"],
      };
      onDisk.modelCosts = { "fixture/fixture-model": { input: 7, output: 11 } };
      writeFileSync(configPath, JSON.stringify(onDisk, null, 2));

      const sync = await fx.request(server.runtime, "/api/sync", { method: "POST" });
      expect(sync.status).toBe(200);

      // Assert against DISK, not the response body: the failure this pins is the route
      // persisting a stale snapshot back over the file.
      const after = JSON.parse(readFileSync(configPath, "utf-8")) as Record<string, any>;
      expect(after.providers["hand-edited"]).toMatchObject({ apiKey: "hand-edited-key" });
      expect(after.modelCosts).toEqual({ "fixture/fixture-model": { input: 7, output: 11 } });
      expect(Object.keys(after.providers)).toEqual(expect.arrayContaining(["fixture", "hand-edited"]));
    } finally {
      await fx.stop(server);
    }
  }, CASE_TIMEOUT_MS);

  /**
   * RED: remove shouldSyncCodexOnStart or the under-lock desired-state read; an
   * OFF row writes native config bytes. Explicit CLI sync/sync-cache may still
   * refresh the catalog/cache for side profiles (catalog-only), so those two
   * commands are compared without catalog artifacts; config/history must not move.
   */
  test("A-reduced: real CLI and HTTP entry points preserve an OFF Codex config/home", async () => {
    const fx = fixture();
    fx.writeConfig({ clientIntegrations: { codex: false, grok: false, "claude-desktop": false } });
    mkdirSync(join(fx.homeA, ".grok"));
    writeFileSync(join(fx.homeA, ".grok", "config.toml"), "# user config\n");
    const before = manifest(fx.codex);
    const server = await fx.start();
    try {
      expect(manifest(fx.codex)).toEqual(before);
      for (const argv of [["ensure"], ["restore"]]) {
        const result = await fx.runCli(argv);
        expect(result.exitCode).toBe(0);
        expect(manifest(fx.codex)).toEqual(before);
      }
      for (const argv of [["sync"], ["sync-cache"]]) {
        const result = await fx.runCli(argv);
        expect(result.exitCode).toBe(0);
        expect(manifestWithoutCatalogArtifacts(manifest(fx.codex))).toEqual(manifestWithoutCatalogArtifacts(before));
      }
      const sync = await fx.request(server.runtime, "/api/sync", { method: "POST" });
      expect(sync.status).toBe(200);
      expect(sync.body).toMatchObject({ status: "skipped", skippedReason: "desired_disabled", ok: true });
      for (const clientId of ["codex", "grok", "claude-desktop"] as const) {
        const toggle = await fx.request(server.runtime, `/api/native-integrations/${clientId}`, {
          method: "PUT", body: JSON.stringify({ enabled: false }),
        });
        expect([200, 404]).toContain(toggle.status);
        expect(toggle.body).toHaveProperty("desiredEnabled", false);
      }
      expect(manifestWithoutCatalogArtifacts(manifest(fx.codex))).toEqual(manifestWithoutCatalogArtifacts(before));
      // P08 is intentionally the ON control: it must reach the same running
      // server through the real CLI without passing a port flag.
      const enabled = await fx.request(server.runtime, "/api/native-integrations/codex", {
        method: "PUT", body: JSON.stringify({ enabled: true }),
      });
      expect(enabled.status).toBe(200);
      const back = await fx.runCli(["restore", "back"]);
      // The fixture records itself as the active service install, so the
      // production ownership preflight admits this home and P08 completes the
      // enable transition through the real CLI.
      // The CLI's own output is the assertion message: a bare "expected 0, got 1" sent two
      // Windows CI rounds chasing a timeout that was never the cause.
      expect(`exit=${back.exitCode}\nstderr: ${back.stderr}\nstdout: ${back.stdout}`).toContain("exit=0");
      expect((await fx.request(server.runtime, "/api/native-integrations/codex", {
        method: "PUT", body: JSON.stringify({ enabled: false }),
      })).body).toMatchObject({ desiredEnabled: false });
    } finally {
      await fx.stop(server);
    }
  }, CASE_TIMEOUT_MS);

  /** RED: bypass the persisted OFF mutation or the under-lock re-read; stale P19 writes its candidate after gather. */
  test("B-reduced: a held local provider cannot commit after the HTTP route persists OFF", async () => {
    const fx = fixture();
    let hold = false;
    let release!: () => void;
    let entered!: () => void;
    const released = new Promise<void>(resolveRelease => { release = resolveRelease; });
    const enteredGather = new Promise<void>(resolveEntered => { entered = resolveEntered; });
    const provider = Bun.serve({
      port: 0,
      // This fixture HOLDS the /models response open on purpose — that hold is the test's
      // instrument for keeping a provider-discovery request in flight while the toggle flips.
      // Bun's default request idleTimeout is 10s, so on a loaded Windows shard the runtime
      // cancelled the very request the test was holding and the assertion saw a 500 instead
      // of the 200 it was waiting for. The hold is bounded by `released`, not by this value.
      idleTimeout: 255,
      fetch: async request => {
        if (new URL(request.url).pathname.endsWith("/models")) {
          if (hold) {
            entered();
            await released;
          }
          return Response.json({ data: [{ id: "held-model" }] });
        }
        return new Response("not found", { status: 404 });
      },
    });
    try {
      // Keep the asynchronous startup registry from becoming the held flight.
      // The route reloads this persisted config, so enable discovery only once
      // its own request is about to begin.
      fx.writeConfig({ clientIntegrations: { codex: false } });
      const server = await fx.start();
      try {
        writeFileSync(join(fx.codex, "opencodex-catalog.json"), JSON.stringify({ models: [] }));
        fx.writeConfig({ providers: { fixture: {
          adapter: "openai-chat", baseUrl: `http://127.0.0.1:${provider.port}/v1`, apiKey: "fixture-key",
          allowPrivateNetwork: true, liveModels: true,
        } }, defaultProvider: "fixture", clientIntegrations: { codex: true } });
        hold = true;
        // This request is intentionally held open while a second real HTTP
        // mutation crosses the Windows process-backed identity path.
        const stale = fx.request(server.runtime, "/api/sync", { method: "POST" }, SERVER_BUDGET_MS);
        await Promise.race([
          enteredGather,
          stale.then(result => Promise.reject(new Error(
            `held /api/sync completed before provider discovery: ${result.status} ${JSON.stringify(result.body)}`,
          ))),
        ]);
        const off = await fx.request(server.runtime, "/api/native-integrations/codex", {
          method: "PUT", body: JSON.stringify({ enabled: false }),
        }, SERVER_BUDGET_MS);
        expect(off.status).toBe(200);
        const afterOff = manifest(fx.codex);
        release();
        const result = await stale;
        expect(result.status).toBe(200);
        expect(result.body).toMatchObject({ status: "skipped", skippedReason: "desired_disabled", ok: true });
        expect(manifest(fx.codex)).toEqual(afterOff);
      } finally {
        release();
        await fx.stop(server);
      }
    } finally {
      provider.stop(true);
    }
  }, CASE_TIMEOUT_MS);

  /** RED: omit `admitCodexWrite` ownership refusal; start/ensure/P19 create a coordinator or native artifact. */
  test("D-reduced: foreign service-home evidence refuses real CLI and HTTP writers before artifacts", async () => {
    const fx = fixture();
    fx.writeConfig({
      defaultProvider: "openai",
      providers: {
        openai: {
          adapter: "openai-responses",
          baseUrl: "https://chatgpt.com/backend-api/codex",
          authMode: "forward",
          codexAccountMode: "pool",
        },
      },
      codexAccounts: [],
      activeCodexAccountId: "__main__",
      autoSwitchThreshold: 0,
    });
    const expiredPayload = Buffer.from(JSON.stringify({
      exp: Math.floor(Date.now() / 1000) - 60,
    })).toString("base64url");
    writeFileSync(join(fx.codex, "auth.json"), JSON.stringify({
      tokens: {
        access_token: `header.${expiredPayload}.signature`,
        account_id: "foreign-main-account",
      },
    }));
    writeFileSync(join(fx.codex, "opencodex-catalog.json"), JSON.stringify({
      models: [{ slug: "foreign-sentinel" }],
    }));
    writeFileSync(join(fx.codex, "models_cache.json"), "foreign-cache-sentinel\n");
    writeFileSync(join(fx.ocx, "service-state.json"), JSON.stringify({
      version: 2,
      codexHome: join(fx.root, "foreign-codex"),
      opencodexHome: join(fx.root, "foreign-ocx"),
      backend: "scheduler",
    }));
    const before = manifest(fx.codex);
    const server = await fx.start();
    try {
      const nativeRead = await fx.request(server.runtime, "/v1/responses", {
        method: "POST",
        body: JSON.stringify({ model: "openai/gpt-test", input: "foreign owner", stream: false }),
      });
      expect(nativeRead.status).toBe(503);
      const ensure = await fx.runCli(["ensure"]);
      expect(ensure.exitCode).toBe(0);
      const sync = await fx.request(server.runtime, "/api/sync", { method: "POST" });
      expect(sync.status).toBe(409);
      expect(String(sync.body.message ?? sync.body.error)).toMatch(/Refusing|service|ownership/i);
      const restore = await fx.runCli(["restore"]);
      expect(restore.exitCode).toBe(1);
      expect(manifest(fx.codex)).toEqual(before);
      expect(fx.lockAllowlist.some(existsSync)).toBe(false);
    } finally {
      await fx.stop(server);
    }
  }, CASE_TIMEOUT_MS);

  test("D-unknown: unprovable service-home ownership refuses native reads and cache writes", async () => {
    const fx = fixture();
    fx.writeConfig({
      defaultProvider: "openai",
      providers: {
        openai: {
          adapter: "openai-responses",
          baseUrl: "https://chatgpt.com/backend-api/codex",
          authMode: "forward",
          codexAccountMode: "pool",
        },
      },
      codexAccounts: [],
      activeCodexAccountId: "__main__",
      autoSwitchThreshold: 0,
    });
    writeFileSync(join(fx.codex, "auth.json"), JSON.stringify({
      tokens: {
        access_token: "opaque-main-token",
        account_id: "unknown-main-account",
      },
    }));
    writeFileSync(join(fx.codex, "opencodex-catalog.json"), JSON.stringify({
      models: [{ slug: "unknown-sentinel" }],
    }));
    writeFileSync(join(fx.codex, "models_cache.json"), "unknown-cache-sentinel\n");
    writeFileSync(join(fx.ocx, "service-state.json"), "{malformed-service-state\n");
    const before = manifest(fx.codex);
    const server = await fx.start();
    try {
      const nativeRead = await fx.request(server.runtime, "/v1/responses", {
        method: "POST",
        body: JSON.stringify({ model: "openai/gpt-test", input: "unknown owner", stream: false }),
      });
      expect(nativeRead.status).toBe(503);
      const sync = await fx.request(server.runtime, "/api/sync", { method: "POST" });
      expect(sync.status).toBe(409);
      expect(String(sync.body.message ?? sync.body.error)).toMatch(/ownership|proven|read|malformed/i);
      expect(manifest(fx.codex)).toEqual(before);
      expect(fx.lockAllowlist.some(existsSync)).toBe(false);
    } finally {
      await fx.stop(server);
    }
  }, CASE_TIMEOUT_MS);

  /** RED: key N by HOME/USERPROFILE instead of effective uid plus canonical CODEX_HOME; both children acquire. */
  test("E: separate fake homes share the effective-user Codex lock", async () => {
    const fx = fixture();
    fx.writeConfig();
    // The current lock result exposes `busy` but not the lock id.  The parent
    // derives the one production id and checks both children use its database;
    // a typed busy result is still required from the contender.
    const held = join(fx.root, "held");
    const release = join(fx.root, "release");
    const holder = Bun.spawn([process.execPath, lockChildPath], {
      cwd: repoRoot,
      // The hold has to outlast the contender's process spawn, which is the slow part on a
      // Windows shard. The release marker below still ends it early everywhere else, so this
      // is a ceiling rather than a sleep the test pays for.
      env: {
        ...fx.env(fx.homeA, fx.userprofileA),
        OCX_LOCK_CHILD_PAYLOAD: JSON.stringify({
          timeoutMs: 5_000,
          holdMarker: held,
          releaseMarker: release,
          holdMs: watchdogMs(3_000),
        }),
      },
      stdout: "pipe", stderr: "pipe",
    });
    fx.children.push(holder);
    await waitFor(() => existsSync(held) ? true : null, "held coordinator lock");
    const contender = Bun.spawn([process.execPath, lockChildPath], {
      cwd: repoRoot,
      env: { ...fx.env(fx.homeB, fx.userprofileB), OCX_LOCK_CHILD_PAYLOAD: JSON.stringify({ timeoutMs: 0 }) },
      stdout: "pipe", stderr: "pipe",
    });
    fx.children.push(contender);
    const [out, code] = await Promise.all([new Response(contender.stdout).text(), contender.exited]);
    expect(code).toBe(0);
    const identity = canonicalizeCodexHome(fx.codex);
    expect(identity.ok).toBe(true);
    expect(JSON.parse(out)).toMatchObject({
      status: "busy", reason: "deadline", lockId: identity.ok ? identity.home.lockId : "unreachable",
    });
    expect(existsSync(fx.lockPath)).toBe(true);
    expect(existsSync(join(fx.homeA, "native-write-locks"))).toBe(false);
    expect(existsSync(join(fx.homeB, "native-write-locks"))).toBe(false);
    writeFileSync(release, "release");
    expect(await holder.exited).toBe(0);
  }, CASE_TIMEOUT_MS);

  /** RED: delete the durable Grok intent or bypass `shouldSyncGrokOnStart`; startup recreates the fence. */
  test("Grok E2E: route-disabled Grok stays absent across a real startup", async () => {
    const fx = fixture();
    fx.writeConfig();
    const grokHome = join(fx.homeA, ".grok");
    mkdirSync(grokHome);
    writeFileSync(join(grokHome, "config.toml"), "# user grok config\n");
    const first = await fx.start();
    try {
      const disabled = await fx.request(first.runtime, "/api/native-integrations/grok", {
        method: "PUT", body: JSON.stringify({ enabled: false }),
      });
      expect(disabled.status).toBe(200);
      expect(disabled.body).toMatchObject({ desiredEnabled: false, state: "absent" });
    } finally {
      await fx.stop(first);
    }
    const second = await fx.start();
    const secondOutput = second.stdout;
    try {
      expect(readFileSync(join(grokHome, "config.toml"), "utf8")).not.toContain("opencodex managed block");
    } finally {
      await fx.stop(second);
    }
    expect(await secondOutput).not.toContain("Grok Build config updated");
  }, CASE_TIMEOUT_MS);

  /** RED: report restore success after a blocked history worker; config recovery must not hide history contention. */
  test("Restore truth: JSON distinguishes a busy history restore from native artifact recovery", async () => {
    const fx = fixture();
    fx.writeConfig({ clientIntegrations: { codex: false } });
    const original = 'model = "gpt-5"\n';
    const injected = `${original}# Auto-injected by opencodex\nopenai_base_url = "http://127.0.0.1:45678/v1"\n`;
    const profile = "# opencodex profile\n";
    writeFileSync(join(fx.codex, "config.toml"), injected);
    writeFileSync(join(fx.codex, "opencodex.config.toml"), profile);
    writeFileSync(join(fx.codex, "opencodex-journal.json"), JSON.stringify({
      version: 1,
      originalConfig: Buffer.from(original).toString("base64"),
      originalProfile: null,
      injectedConfigHash: createHash("sha256").update(injected).digest("hex"),
      injectedProfileHash: createHash("sha256").update(profile).digest("hex"),
      pid: process.pid,
      timestamp: new Date().toISOString(),
    }));
    const stateDb = join(fx.codex, "state_5.sqlite");
    const rollout = join(fx.codex, "restore-rollout.jsonl");
    writeFileSync(rollout, `${JSON.stringify({ type: "session_meta", payload: { id: "restore-1", model_provider: "opencodex", source: "cli" } })}\n`);
    const seeded = new Database(stateDb);
    seeded.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL, model_provider TEXT NOT NULL, source TEXT NOT NULL, first_user_message TEXT NOT NULL, has_user_event INTEGER NOT NULL)");
    seeded.run("INSERT INTO threads VALUES ('restore-1', ?, 'opencodex', 'cli', 'hello', 1)", [rollout]);
    seeded.close();
    const historyBefore = readFileSync(stateDb);
    const held = join(fx.root, "history-held");
    const release = join(fx.root, "history-release");
    const holder = Bun.spawn([process.execPath, "--eval", `
      import { Database } from "bun:sqlite";
      import { existsSync, writeFileSync } from "node:fs";
      const db = new Database(${JSON.stringify(stateDb)});
      db.exec("PRAGMA busy_timeout = 0; BEGIN IMMEDIATE");
      writeFileSync(${JSON.stringify(held)}, "held");
      const waiter = new Int32Array(new SharedArrayBuffer(4));
      while (!existsSync(${JSON.stringify(release)})) Atomics.wait(waiter, 0, 0, 20);
      db.exec("COMMIT"); db.close();
    `], { cwd: repoRoot, env: fx.env(), stdout: "pipe", stderr: "pipe" });
    fx.children.push(holder);
    await waitFor(() => existsSync(held) ? true : null, "history BEGIN IMMEDIATE");
    // The contended restore deliberately waits out PRODUCTION's retry budget:
    // a 5 s SQLite busy timeout per attempt, two attempts, plus the delay
    // between them — ~11 s of intentional waiting before it can report `busy`.
    // A 15 s watchdog left almost no margin and fired on a loaded macOS runner
    // (dev CI run 31105071651). Give the wait its budget plus real headroom;
    // the case's own 45 s test timeout still bounds it.
    const blocked = await fx.runCli(["restore", "--json"], fx.homeA, fx.userprofileA, watchdogMs(30_000));
    expect(blocked.exitCode).toBe(1);
    const envelope = JSON.parse(blocked.stdout) as { success: boolean; artifacts: { history: { state: string; reason?: string } } };
    expect(envelope).toMatchObject({ success: false, artifacts: { history: { state: "failed", reason: "busy" } } });
    expect(readFileSync(join(fx.codex, "config.toml"), "utf8")).toBe(original);
    expect(readFileSync(stateDb).equals(historyBefore)).toBe(true);
    writeFileSync(release, "release");
    expect(await holder.exited).toBe(0);
    const converged = await fx.runCli(["restore", "--json"]);
    expect(converged.exitCode).toBe(0);
    expect(JSON.parse(converged.stdout)).toMatchObject({ success: true, artifacts: { history: { state: "ok" } } });
    const after = new Database(stateDb, { readonly: true });
    expect(after.query<{ model_provider: string }, []>("SELECT model_provider FROM threads WHERE id = 'restore-1'").get()?.model_provider).toBe("openai");
    after.close();
  }, CASE_TIMEOUT_MS);
});
