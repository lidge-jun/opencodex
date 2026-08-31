import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { runNpmCachePreflight } from "../src/update/npm-cache-preflight.mjs";
import { isProcessAlive, killProxy } from "../src/lib/process-control";

const repoRoot = join(import.meta.dir, "..");

function freePort(): Promise<number> {
  const { promise, resolve, reject } = Promise.withResolvers<number>();
  const server = createServer();
  server.on("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    server.close(() => port ? resolve(port) : reject(new Error("no free port")));
  });
  return promise;
}

/**
 * Budget for the whole recovery case, and the arithmetic that keeps it honest.
 *
 * A cold detached proxy takes ~2s locally, but this test runs inside a CI batch of twelve files
 * on a shared runner where the same boot has blown a 15s budget. Raising the readiness wait to
 * 45s fixed that and introduced a worse failure: the case ALSO spawns `node launcher update`
 * (up to 30s) before the wait even starts, and `node launcher stop` (up to 30s) after it. With
 * a 60s Bun timeout, a 45s wait leaves the readiness probe unable to finish inside the case at
 * all — observed failing at 46-47s on macOS, which reads as a product defect and is not one.
 *
 * So the budget is derived from the timeout rather than guessed against it: the wait gets what
 * remains after the spawns, and the Bun timeout is stated as the sum of its parts. The deadline
 * exists to stop a HUNG proxy, not to assert a boot deadline the suite never intended to
 * enforce — a slow-but-live proxy must still pass.
 */
const UPDATE_SPAWN_TIMEOUT_MS = 30_000;
// 45s exhausted repeatedly on loaded shared runners (46-47s failures recorded
// on at least four unrelated PRs; the detached Bun proxy can take >45s to
// serve /healthz there). 90s keeps the derived case budget honest below.
const PROXY_READY_TIMEOUT_MS = 90_000;
/** Spawn + readiness + teardown spawn, plus headroom for fixture IO on a loaded runner. */
const RECOVERY_CASE_TIMEOUT_MS = UPDATE_SPAWN_TIMEOUT_MS + PROXY_READY_TIMEOUT_MS + UPDATE_SPAWN_TIMEOUT_MS + 15_000;

async function waitForProxy(port: number): Promise<boolean> {
  const deadline = Date.now() + PROXY_READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/healthz`, {
        // A loaded runner can exceed 500ms on the very first connection while
        // the process is still binding; a short per-probe timeout there reads
        // as "not ready" for a proxy that is merely slow to accept.
        signal: AbortSignal.timeout(2_000),
      });
      if (response.ok) return true;
    } catch { /* detached proxy is still starting */ }
    // The detached process exposes readiness only over HTTP; fake timers cannot advance it.
    await Bun.sleep(100);
  }
  return false;
}
const updateSource = readFileSync(join(import.meta.dir, "..", "src", "update", "index.ts"), "utf8");
const launcherSource = readFileSync(join(import.meta.dir, "..", "bin", "ocx.mjs"), "utf8");
const serverSource = readFileSync(join(import.meta.dir, "..", "src", "server", "index.ts"), "utf8");
const dispatchSource = readFileSync(join(import.meta.dir, "..", "src", "cli", "dispatch.ts"), "utf8");

describe("update stops the running proxy before replacing files", () => {
  // The recovery case starts a real detached proxy, and its own result says nothing about
  // whether cleanup reaped it — it stayed green while an escapee spun on a deleted tree for
  // hours. Auditing the pid once the suite is done turns a silent leak back into a red test.
  let auditedRecoveryPid: number | undefined;

  afterAll(() => {
    if (auditedRecoveryPid === undefined) return;
    expect(isProcessAlive(auditedRecoveryPid)).toBe(false);
  });

  test("a failed cache pre-flight aborts before the stop callback can run", () => {
    let stopped = false;
    const malformedSpawn = (() => ({ status: 0, signal: null, stdout: "not-json", stderr: "" })) as never;
    const preflight = runNpmCachePreflight({ platform: "linux", spawnSyncFn: malformedSpawn });

    if (preflight.ok) stopped = true;

    expect(preflight).toEqual({ ok: false, reason: "worker_output_malformed" });
    expect(stopped).toBe(false);
  });

  test("bun/source update path gates on the pid file and spawns 'stop' before the package manager", () => {
    expect(updateSource).toContain('spawnSync(process.execPath, selfLaunchArgv(["stop"])');
    const stopAt = updateSource.indexOf('selfLaunchArgv(["stop"])');
    const updateAt = updateSource.indexOf("spawnSync(target.bin, target.args");
    expect(stopAt).toBeGreaterThan(-1);
    expect(updateAt).toBeGreaterThan(-1);
    expect(stopAt).toBeLessThan(updateAt);
    expect(updateSource).toContain("if (serviceWasInstalled || readPid() || readRuntimePort() || pendingTeardownOutstanding())");
  });

  test("integrity pre-flight runs BEFORE the stop so anomalous metadata never unloads the proxy", () => {
    const gateAt = updateSource.indexOf("const integrity = checkUpdatePackageIntegrity(latest);");
    const abortAt = updateSource.indexOf("aborting the update before stopping the proxy");
    const stopAt = updateSource.indexOf('selfLaunchArgv(["stop"])');
    expect(gateAt).toBeGreaterThan(-1);
    expect(abortAt).toBeGreaterThan(-1);
    expect(gateAt).toBeLessThan(stopAt);
    expect(abortAt).toBeLessThan(stopAt);
  });

  test("cache access gates in both CLI entry points precede every tray/proxy stop", () => {
    const runtimeGate = updateSource.indexOf("const cachePreflight = runNpmCachePreflight();");
    const runtimeStop = updateSource.indexOf('selfLaunchArgv(["stop"])');
    const launcherGate = launcherSource.indexOf("const cachePreflight = runNpmCachePreflight();");
    const launcherTrayStop = launcherSource.indexOf('runTrayLifecycle(launcher, "stop")');
    const launcherProxyStop = launcherSource.indexOf('[launcher, "stop"]');

    expect(runtimeGate).toBeGreaterThan(-1);
    expect(launcherGate).toBeGreaterThan(-1);
    expect(runtimeGate).toBeLessThan(runtimeStop);
    expect(launcherGate).toBeLessThan(launcherTrayStop);
    expect(launcherGate).toBeLessThan(launcherProxyStop);
  });

  test("npm launcher update path stops via its own launcher path before npm install", () => {
    expect(launcherSource).toContain('spawnSync(process.execPath, [launcher, "stop"]');
    const stopAt = launcherSource.indexOf('[launcher, "stop"]');
    // #1942: the destructive step is now the transactional staged update, not a direct
    // global npm install. The stop must still precede it.
    const installAt = launcherSource.indexOf("transactionalNpmUpdate({");
    expect(stopAt).toBeGreaterThan(-1);
    expect(installAt).toBeGreaterThan(-1);
    expect(stopAt).toBeLessThan(installAt);
    expect(launcherSource).toContain('existsSync(join(configDir(), "ocx.pid"))');
    expect(launcherSource).toContain('existsSync(join(configDir(), "runtime-port.json"))');
  });

  test("Windows npm paths resolve safely before stop and never use shell:true", () => {
    const updateResolveAt = updateSource.indexOf("const target = updateSpawnTarget(bin, cmdArgs);");
    const updateStopAt = updateSource.indexOf('selfLaunchArgv(["stop"])');
    const launcherResolveAt = launcherSource.indexOf("const installInvocation = npmInvocation(");
    const launcherStopAt = launcherSource.indexOf('[launcher, "stop"]');

    expect(updateResolveAt).toBeGreaterThan(-1);
    expect(launcherResolveAt).toBeGreaterThan(-1);
    expect(updateResolveAt).toBeLessThan(updateStopAt);
    expect(launcherResolveAt).toBeLessThan(launcherStopAt);
    expect(updateSource).not.toContain("shell: true");
    expect(launcherSource).not.toContain("shell: true");
    expect(updateSource).not.toContain('"npm.cmd"');
    expect(launcherSource).not.toContain('"npm.cmd"');
  });

  test("both paths abort when the stop fails, and REPAIR a managed service after success", () => {
    expect(updateSource).toContain("aborting the update");
    // 260804 #970: the refresh must not re-register. `install` reaches `schtasks /create`
    // on Windows scheduler backends, which a non-elevated updater cannot run — it would
    // stop a working proxy and then fail to bring its service back.
    expect(updateSource).toContain("serviceReinstallArgs()");
    expect(launcherSource).toContain("aborting the update");
    expect(launcherSource).toContain('"service", "repair"');
    // The launcher still reads service-state.json for service-installed detection, and
    // for the backend choice on the genuinely-absent install fallback.
    expect(launcherSource).toContain('"service-state.json"');
    // That marker can be STALE, so the fallback asks for structured state rather than
    // parsing a failure message; bin/ocx.mjs is plain Node and cannot import
    // diagnoseService(), so it reads startup.serviceInstalled from `status --json`.
    expect(launcherSource).toContain("startup?.serviceInstalled");
    expect(updateSource).toContain("OCX_BAKE_PORT");
    expect(launcherSource).toContain("OCX_BAKE_PORT");
    // Live runtime port 10100 must not be discarded as a missing-port sentinel.
    expect(launcherSource).toContain("sawRuntimePort");
    expect(updateSource).toContain("runtimeTrusted");
  });

  test.skipIf(process.platform === "win32")(
    "npm launcher restarts the stopped runtime after a staged update failure",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "ocx-update-recovery-"));
      const packageRoot = join(root, "node_modules", "@bitkyc08", "opencodex");
      const launcher = join(packageRoot, "bin", "ocx.mjs");
      const opencodexHome = join(root, "opencodex-home");
      const fakeBin = join(root, "fake-bin");
      const fakeNpm = join(fakeBin, "npm");
      const cache = join(root, "npm-cache");
      const bundledBun = join(repoRoot, "node_modules", "bun");
      const env = {
        ...process.env,
        HOME: root,
        USERPROFILE: root,
        OPENCODEX_HOME: opencodexHome,
        OCX_FAKE_NPM_CACHE: cache,
        PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
      };
      let recoveredPid: number | undefined;

      try {
        const port = await freePort();
        expect(existsSync(bundledBun)).toBe(true);
        mkdirSync(dirname(launcher), { recursive: true });
        mkdirSync(join(packageRoot, "node_modules"), { recursive: true });
        mkdirSync(opencodexHome, { recursive: true });
        mkdirSync(fakeBin, { recursive: true });
        mkdirSync(cache, { recursive: true });
        copyFileSync(join(repoRoot, "bin", "ocx.mjs"), launcher);
        chmodSync(launcher, 0o755);
        symlinkSync(join(repoRoot, "src"), join(packageRoot, "src"), "dir");
        symlinkSync(bundledBun, join(packageRoot, "node_modules", "bun"), "dir");
        writeFileSync(join(packageRoot, "package.json"), JSON.stringify({
          name: "@bitkyc08/opencodex",
          version: "1.0.0",
          type: "module",
        }));
        writeFileSync(join(opencodexHome, "config.json"), JSON.stringify({ port }));
        writeFileSync(join(opencodexHome, "runtime-port.json"), JSON.stringify({ port, pid: 999_999_999 }));
        writeFileSync(fakeNpm, `#!/bin/sh
case "$1" in
  view) printf '2.0.0\\n' ;;
  config) printf '%s\\n' "$OCX_FAKE_NPM_CACHE" ;;
  install) exit 1 ;;
  *) exit 1 ;;
esac
`);
        chmodSync(fakeNpm, 0o755);

        const result = Bun.spawnSync(["node", launcher, "update"], {
          cwd: root,
          env,
          stdout: "pipe",
          stderr: "pipe",
          timeout: UPDATE_SPAWN_TIMEOUT_MS,
        });
        const output = result.stdout.toString() + result.stderr.toString();

        expect(result.exitCode).toBe(1);
        expect(output).toContain("Stopping the running proxy before updating");
        expect(output).toContain("restarting the previous version directly");
        expect(output).toContain(`Attempting to restart the proxy on port ${port}.`);
        expect(await waitForProxy(port)).toBe(true);
        const runtime = JSON.parse(readFileSync(join(opencodexHome, "runtime-port.json"), "utf8"));
        expect(runtime.pid).toBeGreaterThan(0);
        recoveredPid = runtime.pid;
      } finally {
        // Resolve the pid FIRST. `stop` rewrites runtime-port.json and the rmSync below
        // deletes it outright, so this is the last moment the detached proxy the recovery
        // path started can still be identified at all.
        if (!recoveredPid) {
          try {
            recoveredPid = JSON.parse(readFileSync(join(opencodexHome, "runtime-port.json"), "utf8")).pid;
          } catch { /* the proxy never wrote runtime state */ }
        }
        auditedRecoveryPid = Number.isSafeInteger(recoveredPid) && recoveredPid! > 0
          ? recoveredPid
          : undefined;
        if (existsSync(launcher)) {
          Bun.spawnSync(["node", launcher, "stop"], {
            cwd: root,
            env,
            stdout: "ignore",
            stderr: "ignore",
            timeout: UPDATE_SPAWN_TIMEOUT_MS,
          });
        }
        try {
          // `stop` exiting 0 is a claim, not proof: it also reports success when it finds no
          // live runtime to stop, which is indistinguishable here from one it failed to stop.
          // Gating the reap on that exit code let a detached proxy survive, get reparented to
          // init, and then spin on a fixture tree this same block had already deleted — one
          // escapee burned a full core for hours. Verify liveness and reap regardless.
          // bin/ocx.mjs mirrors its Bun child's exit, so reaping the recorded child pid takes
          // the node launcher with it.
          if (Number.isSafeInteger(recoveredPid) && recoveredPid! > 0 && isProcessAlive(recoveredPid!)) {
            killProxy(recoveredPid!);
          }
        } finally {
          // Ordered after the reap on purpose: deleting the tree out from under a live
          // detached proxy is what turned a missed kill into a permanently spinning orphan.
          rmSync(root, { recursive: true, force: true });
        }
      }
    },
    RECOVERY_CASE_TIMEOUT_MS,
  );

  /**
   * The budget arithmetic itself, pinned.
   *
   * The recovery case spawns `update`, waits for readiness, then spawns `stop`. A wait budget
   * chosen independently of the Bun timeout is how this test became flaky: 45s of readiness
   * inside a 60s case that also spends up to 60s on two spawns cannot finish, and it failed at
   * 46-47s on macOS while the product was healthy.
   *
   * This asserts the relationship rather than the numbers, so raising any single budget in
   * future cannot silently recreate the impossible one.
   */
  test("the recovery case timeout can actually contain its own spawns and readiness wait", () => {
    // Both spawns plus the readiness wait must fit, with room left for fixture IO.
    const consumed = UPDATE_SPAWN_TIMEOUT_MS * 2 + PROXY_READY_TIMEOUT_MS;
    expect(RECOVERY_CASE_TIMEOUT_MS).toBeGreaterThanOrEqual(consumed);
    expect(RECOVERY_CASE_TIMEOUT_MS - consumed).toBeGreaterThanOrEqual(10_000);
  });


  test("both update paths surface an incomplete manifest-backed history restore after the stop", () => {
    // A codex-history-backup-*.json surviving `ocx stop` means exact metadata restoration
    // remains pending. It can be contention or an integrity refusal, so neither update path
    // may claim a DB lock or that every routed thread is hidden.
    expect(updateSource).toContain("export function historyRestoreIncomplete(");
    expect(updateSource).toContain('name.startsWith("codex-history-backup-") && name.endsWith(".json")');
    // The warning now also fires on the dedicated stop code, so the manifest check is one
    // of two triggers rather than the whole condition (#3008).
    expect(updateSource).toContain("if (historyOnlyStop || historyRestoreIncomplete())");
    expect(launcherSource).toContain("function historyRestoreIncomplete()");
    expect(launcherSource).toContain('name.startsWith("codex-history-backup-") && name.endsWith(".json")');
    expect(launcherSource).toContain("if (historyOnlyStop || historyRestoreIncomplete())");
    const warnAt = launcherSource.indexOf("Codex resume-history metadata restore is incomplete");
    const installAt = launcherSource.indexOf("transactionalNpmUpdate({");
    expect(warnAt).toBeGreaterThan(-1);
    expect(installAt).toBeGreaterThan(-1);
    expect(warnAt).toBeLessThan(installAt);
    expect(updateSource).toContain("manifest/target may need review");
    expect(launcherSource).toContain("untracked routed history is intentionally unchanged");
  });

  test("the stop gate covers service-managed and orphaned proxies whose pid file is stale/missing", () => {
    // A pending-teardown receipt is a fourth reason to stop: after a parent crashed
    // mid-deferral the service, pid and runtime records can all be absent while shared
    // client config still points at a proxy that is gone (#3008).
    expect(updateSource).toContain("if (serviceWasInstalled || readPid() || readRuntimePort() || pendingTeardownOutstanding())");
    expect(launcherSource).toContain("if (serviceWasInstalled || hasRuntimeState || hasPendingTeardown)");
    // The rule now lives in the shared post-stop decision both lanes import (#3008): a
    // history-only stop proceeds, every other nonzero status and any surviving runtime
    // state aborts. Pinned by tests/update-stop-classification.test.ts.
    expect(launcherSource).toContain("decidePostStopUpdate({");
    expect(launcherSource).toContain("hasRuntimeState: stillHasRuntimeState");
  });

  test("GUI worker update children use pipe stdio so background updates do not open consoles", () => {
    expect(updateSource).toContain("function updateChildStdio()");
    expect(updateSource).toContain('process.env.OCX_SERVICE === "1"');
    expect(updateSource).toContain('return "pipe"');
    // All three update children (stop, installer, service reinstall) go through it.
    expect(updateSource).toContain("stdio: stopStdio");
    expect(updateSource).toContain("stdio: installStdio");
    expect(updateSource).toContain("stdio: svcStdio");
    expect(updateSource).toContain("windowsHide: true");
  });
});

describe("ocx update --help has no side effects (#168)", () => {
  test("the Bun CLI short-circuits help before importing the update runner", () => {
    const caseAt = dispatchSource.indexOf('update: async');
    const helpAt = dispatchSource.indexOf('printSubcommandUsage("update")');
    const runAt = dispatchSource.indexOf("await runUpdate()");
    expect(caseAt).toBeGreaterThan(-1);
    expect(helpAt).toBeGreaterThan(caseAt);
    expect(helpAt).toBeLessThan(runAt);
  });

  test("the npm launcher intercepts update --help before the self-update path", () => {
    const helpAt = launcherSource.indexOf("updateHelpRequested");
    const updateAt = launcherSource.indexOf("runNpmSelfUpdate();");
    expect(helpAt).toBeGreaterThan(-1);
    expect(launcherSource).toContain('process.argv[2] === "update" &&');
    // The guard that CALLS the self-update must come after the help exit.
    const guardAt = launcherSource.lastIndexOf('process.argv[2] === "update" && isNodeModulesInstall()');
    expect(helpAt).toBeLessThan(guardAt);
    expect(updateAt).toBeGreaterThan(guardAt);
  });
});

describe("/healthz identity fields", () => {
  test("healthz advertises service identity, pid, and port", () => {
    expect(serverSource).toContain('service: "opencodex"');
    expect(serverSource).toContain("pid: process.pid");
    expect(serverSource).toContain("port: healthPort");
  });
});
