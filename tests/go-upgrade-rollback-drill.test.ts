/**
 * Upgrade-in-place + rollback drill (ADR-0008 spec #7 stories 11–12, ticket #43).
 *
 * The two subprocess drills prove the release-shaped Go binary (`./cmd/ocx`,
 * built with the release build's meaningful flags: CGO_ENABLED=0, from the
 * same `./cmd/ocx` package the release script compiles) can take over a home
 * the last-TypeScript-release CLI created, and that the TypeScript CLI can
 * take the same home back after the Go runtime released it. Both directions
 * must hold with no reconfiguration and no state loss.
 *
 * The last-TypeScript-release side is the REAL TypeScript CLI in this checkout
 * (src/cli/index.ts under Bun), the same process shape the pre-flip release
 * shipped. The Go side is a freshly built static `ocx` binary named exactly
 * `ocx`, because the runtime identity matcher accepts a standalone `ocx`/
 * `opencodex` token — a differently named binary would be refused as a foreign
 * process (#34 command-line identity guard), which is itself a contract this
 * drill would then trip over.
 *
 * Harness constraints learned from the probe (do not regress these):
 *  - NEVER run `ocx stop` through Bun.spawnSync: the synchronous wait blocks
 *    Bun's event loop, so the Go child's zombie is not reaped and `ocx stop`'s
 *    bounded liveness poll sees a zombie that outlives its 8s deadline,
 *    reporting a false "did not exit". Stop through an async spawn and await
 *    it while the event loop stays live.
 *  - Bun's `child.exited` promise resolves before the process is actually
 *    gone in this environment. Process liveness must be judged with kill(2)
 *    (kill -0) or /proc, never `exited !== null`.
 *  - The Go runtime must be spawned with `stdio: "ignore"` (or consumed
 *    continuously): its stdout stays open for the whole server lifetime, so a
 *    buffered pipe never EOFs and `Response(child.stdout).text()` hangs.
 *
 * The drills spawn real listeners on loopback ports in isolated temp homes and
 * are therefore network- and process-intense; they run in CI's go-job
 * "Differential oracles" step with the 60s per-file timeout.
 *
 * POSIX-only: the process probes use `kill -0` and the health probe uses
 * `curl`, neither of which the Windows full-suite lane provides. The whole
 * file skips when the Go toolchain is absent; that gate is about Go, not the
 * platform, so win32 also skips explicitly.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { removeTreeWithRetry } from "./helpers/remove-tree";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const goRoot = join(repoRoot, "go");
const tsCli = join(repoRoot, "src", "cli", "index.ts");

/**
 * The final TypeScript CLI behavior snapshot (story 13). Generated from the
 * real TypeScript CLI of the last pre-flip release and committed as the golden
 * oracle: once TS code leaves the release path, this fixture is what the Go
 * binary's observable surface must keep reproducing. Each row pairs argv with
 * the TS CLI's exact {code, stdout, stderr}.
 */
interface TsCommandSnapshot {
  code: number;
  stdout: string;
  stderr: string;
}

const snapshotPath = join(repoRoot, "tests", "fixtures", "ts-cli-command-snapshot.json");

/** argv per snapshot row name (kept in sync with the fixture's generator). */
const SNAPSHOT_ARGV: Readonly<Record<string, string[]>> = {
  version: ["--version"],
  versionShort: ["-v"],
  versionWord: ["version"],
  helpRoot: ["--help"],
  helpShort: ["-h"],
  helpWord: ["help"],
  helpHealth: ["help", "health"],
  helpReady: ["help", "ready"],
  unknown: ["not-a-command"],
  healthUnavailable: ["health", "--json"],
  readyUsage: ["ready", "--wat"],
  readyUsageTimeout: ["ready", "--timeout", "5"],
};

function readSnapshot(): Record<string, TsCommandSnapshot> {
  return JSON.parse(readFileSync(snapshotPath, "utf8")) as Record<string, TsCommandSnapshot>;
}

/** An isolated, proxy-free home so stateful rows behave identically everywhere. */
function snapshotHome(): string {
  const home = mkdtempSync(join(tmpdir(), "ocx-ts-snapshot-"));
  mkdirSync(join(home, "codex"), { recursive: true });
  registerCleanup(() => removeTreeWithRetry(home));
  return home;
}

/** Home fixture: config.json + a codex home (the TS CLI requires it to exist). */
function makeHome(port: number): string {
  const home = mkdtempSync(join(tmpdir(), "ocx-drill-home-"));
  mkdirSync(join(home, "codex"), { recursive: true });
  writeFileSync(
    join(home, "config.json"),
    JSON.stringify({
      port,
      hostname: "127.0.0.1",
      defaultProvider: "fixture",
      providers: {
        fixture: {
          adapter: "openai-chat",
          baseUrl: "https://example.test/v1",
          apiKey: "probe-secret",
          defaultModel: "fixture-model",
          models: ["fixture-model", "second"],
          contextWindow: 128000,
        },
      },
    }),
  );
  registerCleanup(() => removeTreeWithRetry(home));
  return home;
}

function runTsCliIn(args: string[], home: string): TsCommandSnapshot {
  const result = Bun.spawnSync([process.execPath, tsCli, ...args], {
    cwd: repoRoot,
    env: childEnv(home),
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    code: result.exitCode,
    stdout: new TextDecoder().decode(result.stdout),
    stderr: new TextDecoder().decode(result.stderr),
  };
}

function goToolchainAvailable(): boolean {
  return Bun.spawnSync(["go", "version"], { stdout: "ignore", stderr: "ignore" }).success;
}

function buildReleaseShapedBinary(): string {
  const dir = mkdtempSync(join(tmpdir(), "ocx-go-drill-"));
  const binary = join(dir, process.platform === "win32" ? "ocx.exe" : "ocx");
  const build = Bun.spawnSync(
    ["go", "build", "-buildvcs=false", "-trimpath", "-o", binary, "./cmd/ocx"],
    {
      cwd: goRoot,
      env: { ...process.env, CGO_ENABLED: "0" },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  if (build.exitCode !== 0) {
    throw new Error(
      `go build ./cmd/ocx failed (${build.exitCode}):\n${new TextDecoder().decode(build.stderr)}`,
    );
  }
  return binary;
}

// POSIX-only helpers (kill -0, curl); win32 never runs this file.
const posixPlatform = process.platform !== "win32";
const goAvailable = posixPlatform && goToolchainAvailable();
const goBinary: string | null = goAvailable ? buildReleaseShapedBinary() : null;
const cleanups: (() => void)[] = [];
const spawned: { pid: number; kill: () => void }[] = [];

function registerCleanup(fn: () => void): void {
  cleanups.push(fn);
}

afterAll(() => {
  for (const child of spawned) {
    try {
      child.kill();
    } catch {
      // already gone
    }
  }
  for (const cleanup of cleanups.reverse()) {
    try {
      cleanup();
    } catch {
      // best-effort teardown
    }
  }
});

/** Home fixture: config.json + a codex home (the TS CLI requires it to exist). */
function makeHome(port: number): string {
  const home = mkdtempSync(join(tmpdir(), "ocx-drill-home-"));
  mkdirSync(join(home, "codex"), { recursive: true });
  writeFileSync(
    join(home, "config.json"),
    JSON.stringify({
      port,
      hostname: "127.0.0.1",
      defaultProvider: "fixture",
      providers: {
        fixture: {
          adapter: "openai-chat",
          baseUrl: "https://example.test/v1",
          apiKey: "probe-secret",
          defaultModel: "fixture-model",
          models: ["fixture-model", "second"],
          contextWindow: 128000,
        },
      },
    }),
  );
  registerCleanup(() => removeTreeWithRetry(home));
  return home;
}

/** Fully isolated environment for every child; the sandboxed preload is not inherited. */
function childEnv(home: string): Record<string, string> {
  return {
    ...process.env,
    HOME: home,
    OPENCODEX_HOME: home,
    CODEX_HOME: join(home, "codex"),
    CI: "1",
    OPENCODEX_API_AUTH_TOKEN: "data-probe-token",
    OPENCODEX_ADMIN_AUTH_TOKEN: "admin-probe-token",
    // Keep the process under test off any real desktop integration; these
    // homes are throwaway.
    OPENCODEX_SKIP_SERVICE_OWNERSHIP: "1",
  };
}

function processAlive(pid: number): boolean {
  if (!pid || pid <= 0) return false;
  return Bun.spawnSync(["kill", "-0", String(pid)], { stdout: "ignore", stderr: "ignore" }).exitCode === 0;
}

async function waitFor(probe: () => boolean, what: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (probe()) return true;
    await Bun.sleep(150);
  }
  return false;
}

function runtimeRecord(home: string): { pid: number; port: number } | null {
  try {
    const raw = readFileSync(join(home, "runtime-port.json"), "utf8");
    const parsed = JSON.parse(raw) as { pid: number; port: number };
    return typeof parsed.pid === "number" && typeof parsed.port === "number" ? parsed : null;
  } catch {
    return null;
  }
}

function pidFile(home: string): string | null {
  try {
    return readFileSync(join(home, "ocx.pid"), "utf8");
  } catch {
    return null;
  }
}

/** Unauthenticated GET /healthz answers 200 on the port the runtime recorded. */
function healthzHealthy(home: string): boolean {
  const record = runtimeRecord(home);
  if (!record) return false;
  const probe = Bun.spawnSync(
    ["curl", "-s", "-o", "/dev/null", "-w", "%{http_code}", `http://127.0.0.1:${record.port}/healthz`],
    { stdout: "pipe", stderr: "ignore" },
  );
  return new TextDecoder().decode(probe.stdout) === "200";
}

/**
 * True once a home's runtime records name `pid` AND /healthz answers 200 on
 * the recorded port. Distinguishes "the runtime is up" from a stale record
 * left by a previous owner: the handoff wait asserts the Go pid explicitly
 * rather than accepting any 200, so a record deletion by the draining TS
 * process during the handoff (its graceful-drain cleanup) cannot read as a
 * false failure.
 */
function healthServedBy(home: string, pid: number): boolean {
  const record = runtimeRecord(home);
  if (!record || record.pid !== pid) return false;
  return healthzHealthy(home);
}

function startTsProxy(home: string, port: number): { pid: number; kill: () => void } {
  const child = Bun.spawn([process.execPath, tsCli, "start", "--port", String(port)], {
    cwd: repoRoot,
    env: childEnv(home),
    stdout: "ignore",
    stderr: "ignore",
  });
  const handle = { pid: child.pid, kill: () => { try { child.kill("SIGTERM"); } catch { /* gone */ } } };
  spawned.push(handle);
  return handle;
}

function startGoProxy(home: string): { pid: number; kill: () => void } {
  const child = Bun.spawn([goBinary!, "start"], {
    cwd: goRoot,
    env: childEnv(home),
    stdout: "ignore",
    stderr: "ignore",
  });
  const handle = { pid: child.pid, kill: () => { try { child.kill("SIGTERM"); } catch { /* gone */ } } };
  spawned.push(handle);
  return handle;
}

/** Async stop (never spawnSync): the event loop must stay live to reap the child. */
async function stopGoProxy(home: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const child = Bun.spawn([goBinary!, "stop"], {
    cwd: goRoot,
    env: childEnv(home),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code, stdout, stderr };
}

const describeDrill = goAvailable ? describe : describe.skip;

describeDrill("Go upgrade-in-place and rollback drill (ADR-0008 spec #7, ticket #43)", () => {
  test("release-shaped Go binary is buildable and named ocx", () => {
    expect(goBinary).toBeTruthy();
    expect(existsSync(goBinary!)).toBe(true);
    // The command-line identity guard (#34) matches a standalone `ocx` token;
    // a binary with any other name would be refused as a foreign process.
    expect(process.platform === "win32" ? "ocx.exe" : "ocx").toBe(goBinary!.split(/[\\/]/).pop());
  });

  test(
    "upgrade-in-place: Go start reclaims a TS-run port and reads the TS-written home with no reconfiguration",
    async () => {
      const port = 19101;
      const home = makeHome(port);
      const ts = startTsProxy(home, port);
      expect(await waitFor(() => healthzHealthy(home), "TS proxy on " + port, 60_000)).toBe(true);
      expect(processAlive(ts.pid)).toBe(true);
      const tsRecord = runtimeRecord(home);
      expect(tsRecord).not.toBeNull();
      expect(tsRecord!.pid).toBe(ts.pid);
      expect(tsRecord!.port).toBe(port);
      expect(pidFile(home)).toBe(String(ts.pid));

      // Upgrade: the Go runtime takes the port from the running TS release.
      const go = startGoProxy(home);
      expect(await waitFor(() => !processAlive(ts.pid), "TS process exit after Go reclaim", 20_000)).toBe(true);
      expect(await waitFor(() => healthServedBy(home, go.pid), "Go proxy on " + port, 20_000)).toBe(true);
      expect(processAlive(go.pid)).toBe(true);
      // The runtime records now name the Go process, not the TS process.
      const goRecord = runtimeRecord(home);
      expect(goRecord).not.toBeNull();
      expect(goRecord!.pid).toBe(go.pid);
      expect(goRecord!.port).toBe(port);
      expect(pidFile(home)).toBe(String(go.pid));

      // The TS-written config was read as-is: no reconfiguration happened.
      const config = JSON.parse(readFileSync(join(home, "config.json"), "utf8")) as {
        port: number;
        defaultProvider: string;
        providers: Record<string, { apiKey: string; defaultModel: string }>;
      };
      expect(config.port).toBe(port);
      expect(config.defaultProvider).toBe("fixture");
      expect(config.providers.fixture.apiKey).toBe("probe-secret");
      expect(config.providers.fixture.defaultModel).toBe("fixture-model");

      // Go-owned read commands answer from the same home (status projection).
      const status = Bun.spawnSync([goBinary!, "status", "--json"], {
        cwd: goRoot,
        env: childEnv(home),
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(status.exitCode).toBe(0);
      const statusJson = JSON.parse(new TextDecoder().decode(status.stdout)) as {
        proxy?: { running?: boolean; pid?: number | null };
      };
      expect(statusJson.proxy?.running).toBe(true);
      expect(statusJson.proxy?.pid).toBe(go.pid);
    },
    { timeout: 180_000 },
  );

  test(
    "rollback drill: TS reads Go-written state and restarts on the same home after Go stop",
    async () => {
      const port = 19102;
      const home = makeHome(port);
      // Roll forward to the Go runtime.
      const go = startGoProxy(home);
      expect(await waitFor(() => healthServedBy(home, go.pid), "Go proxy on " + port, 30_000)).toBe(true);
      expect(processAlive(go.pid)).toBe(true);

      // Go-owned config writes mutate config.json through the Go native writer.
      const set = Bun.spawnSync([goBinary!, "config", "set", "autoSwitchThreshold", "70", "--json"], {
        cwd: goRoot,
        env: childEnv(home),
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(set.exitCode).toBe(0);
      const config = JSON.parse(readFileSync(join(home, "config.json"), "utf8")) as {
        autoSwitchThreshold?: number;
        port: number;
        providers: Record<string, { apiKey: string }>;
      };
      expect(config.autoSwitchThreshold).toBe(70);
      // The Go write preserved the TS-authored fields byte-compatibly.
      expect(config.port).toBe(port);
      expect(config.providers.fixture.apiKey).toBe("probe-secret");

      // Roll back: Go stop releases the home; the TS CLI must be able to read
      // the state and restart on the same home.
      const stopped = await stopGoProxy(home);
      expect(stopped.code).toBe(0);
      expect(stopped.stderr).toBe("");
      expect(await waitFor(() => !processAlive(go.pid), "Go exit after stop", 15_000)).toBe(true);
      expect(await waitFor(() => !healthzHealthy(home), "port release after Go stop", 10_000)).toBe(true);
      // Go stop removed its own runtime records.
      expect(runtimeRecord(home)).toBeNull();
      expect(pidFile(home)).toBeNull();

      // TS status reads the same home with no repair step.
      const status = runTsCliIn(["status", "--json"], home);
      expect(status.code).toBe(0);
      const statusJson = JSON.parse(status.stdout) as { proxy?: { running?: boolean } };
      expect(statusJson.proxy?.running).toBe(false);

      // TS restart on the same home: the rollback direction of the drill.
      const ts = startTsProxy(home, port);
      expect(await waitFor(() => healthzHealthy(home), "TS proxy restart on " + port, 60_000)).toBe(true);
      expect(processAlive(ts.pid)).toBe(true);
      const tsRecord = runtimeRecord(home);
      expect(tsRecord).not.toBeNull();
      expect(tsRecord!.pid).toBe(ts.pid);
      expect(tsRecord!.port).toBe(port);
    },
    { timeout: 180_000 },
  );

  test("the committed TS CLI snapshot stays current against the real TS CLI", () => {
    // Story 13: the final TS snapshot is the golden oracle. As long as the TS
    // CLI is still in this checkout, this test proves the committed fixture is
    // what the real CLI emits — so the fixture cannot rot silently into a
    // record of a behavior nobody shipped.
    const home = snapshotHome();
    const snapshot = readSnapshot();
    expect(Object.keys(SNAPSHOT_ARGV).sort()).toEqual(Object.keys(snapshot).sort());
    for (const [name, argv] of Object.entries(SNAPSHOT_ARGV)) {
      expect(runTsCliIn(argv, home), `${name} argv ${JSON.stringify(argv)}`).toEqual(snapshot[name]);
    }
  });

  test("the Go CLI surface reproduces the committed TS snapshot rows", () => {
    // Story 13, rollback direction: rows of the snapshot that name commands
    // the Go CLI owns (version aliases, health-unavailable JSON) must come out
    // of the Go binary byte-for-byte identical to the TS snapshot — the
    // post-flip regression oracle. Rows that name TypeScript-owned or
    // environment-dependent behavior are deliberately excluded here; the
    // upgrade/rollback drills and the go-cli-parity suite own those.
    const home = snapshotHome();
    const snapshot = readSnapshot();
    // The Go binary stamps the same version string, under every alias the TS
    // snapshot pins, with the same silence on stderr the TS CLI had.
    for (const alias of ["--version", "-v", "version"] as const) {
      const result = Bun.spawnSync([goBinary!, alias], { cwd: goRoot, env: childEnv(home), stdout: "pipe", stderr: "pipe" });
      expect(result.exitCode).toBe(0);
      expect(new TextDecoder().decode(result.stdout)).toBe(snapshot.version.stdout);
      expect(new TextDecoder().decode(result.stderr)).toBe(snapshot.version.stderr);
    }
    const health = Bun.spawnSync([goBinary!, "health", "--json"], { cwd: goRoot, env: childEnv(home), stdout: "pipe", stderr: "pipe" });
    // No proxy in the home: both runtimes report the same unavailable JSON.
    expect(health.exitCode).toBe(snapshot.healthUnavailable.code);
    expect(new TextDecoder().decode(health.stdout)).toBe(snapshot.healthUnavailable.stdout);
    expect(new TextDecoder().decode(health.stderr)).toBe(snapshot.healthUnavailable.stderr);
  });

  test(
    "runtime handoff leaves the TS-authored home byte-stable across both directions",
    async () => {
      const port = 19103;
      const home = makeHome(port);
      const configPath = join(home, "config.json");

      // The TS runtime migrates its own config on first start (schema
      // completion); that migration is TS-owned and not part of this drill.
      // The handoff contract under test is narrower: after the TS runtime has
      // settled, neither the Go takeover nor the Go release may rewrite
      // config.json, and a TS restart after Go stop must not need another
      // migration pass.
      const ts = startTsProxy(home, port);
      expect(await waitFor(() => healthzHealthy(home), "TS proxy on " + port, 60_000)).toBe(true);
      const settled = readFileSync(configPath, "utf8");

      const go = startGoProxy(home);
      expect(await waitFor(() => !processAlive(ts.pid), "TS exit after Go reclaim", 20_000)).toBe(true);
      expect(await waitFor(() => healthServedBy(home, go.pid), "Go proxy on " + port, 20_000)).toBe(true);
      // The Go runtime read the TS-settled config and must not have rewritten it.
      expect(readFileSync(configPath, "utf8")).toBe(settled);

      const stopped = await stopGoProxy(home);
      expect(stopped.code).toBe(0);
      // Go stop must not rewrite config either (state-file removal only).
      expect(readFileSync(configPath, "utf8")).toBe(settled);

      const ts2 = startTsProxy(home, port);
      expect(await waitFor(() => healthzHealthy(home), "TS proxy restart on " + port, 60_000)).toBe(true);
      // A TS restart after the Go runtime released the home starts from the
      // same settled config: no second migration, no reconfiguration.
      expect(readFileSync(configPath, "utf8")).toBe(settled);
    },
    { timeout: 180_000 },
  );
});
