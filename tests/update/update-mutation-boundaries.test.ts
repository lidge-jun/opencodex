import { guardedUpdateIo, guardedTrayIo } from "../helpers/update-guarded-io.mjs";
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { repoPath } from "../helpers/repo-root";
import { createUpdateServiceHomePolicy, type UpdateServiceHomeAuthority } from "../../src/update/service-home-policy.mjs";
import { planUpdateRuntimeHandling } from "../../src/update/runtime-ownership.mjs";
import { handoffWindowsTrayForUpdate, planWindowsTrayUpdate } from "../../src/update/tray-update-plan.mjs";
import { prepareWorkerUpdateHome, packageOnlyUpdateSucceeded } from "../../src/update/job-update-home";

const node = readFileSync(repoPath("bin/ocx.mjs"), "utf8");
const bun = readFileSync(repoPath("src/update/index.ts"), "utf8");
const worker = readFileSync(repoPath("src/update/job.ts"), "utf8");
const tray = readFileSync(repoPath("src/update/job-update-tray.ts"), "utf8");
function section(source: string, start: string, end: string) {
  const from = source.indexOf(start), to = source.indexOf(end, from);
  expect(from).toBeGreaterThanOrEqual(0); expect(to).toBeGreaterThan(from);
  return source.slice(from, to);
}
async function execute(code: string, deps: object): Promise<any> {
  // Execute production bodies; only module loading and external process/store I/O are injected.
  code = code.replaceAll('await import("../codex/shim")', "await moduleIo.shim()")
    .replaceAll('await import("./guarded-tray-ops")', "guardedTrayIo(await moduleIo.tray())")
    .replaceAll("import.meta.url", '"file:///fixture"')
    .replaceAll('await import("../service")', "await moduleIo.service()")
    .replaceAll('await import("./guarded-port-reclaim")', "await moduleIo.reclaim()");
  const js = new Bun.Transpiler({ loader: "ts" }).transformSync(`async function run(){${code}}`);
  return new Function("deps", `with(deps){${js};return run();}`)({ ...deps, guardedTrayIo, ...guardedUpdateIo(deps) });
}
const quiet = { log() {}, warn() {}, error() {} };

for (const lane of ["Node", "Bun"]) for (const phase of ["shim", "tray"]) {
  if (lane === "Node" && phase === "tray") continue; // Existing launcher terminal gate already covers this control.
  test(`${lane} refuses a cold update when home changes during ${phase} control`, async () => {
    for (const change of [false, true]) {
      let home: UpdateServiceHomeAuthority = { kind: "absent" }, refusals = 0;
      const events: string[] = [], exits: number[] = [];
      const homePolicy = createUpdateServiceHomePolicy(() => home, () => refusals++);
      const code = lane === "Node"
        ? section(node, "function repairCodexShimIfNeeded(", "\nfunction trayInstallState()")
          + section(node, "  const postInstallPlan =", "\n  if (trayBeforeUpdate.restoreOnFailure && postUpdateLauncherUsable")
        : section(bun, "  if (r.status === 0) {", "  } else {\n    if (stopAttempted && trayWasRunning") + "}";
      const result = await execute(code, {
        homePolicy, planUpdateRuntimeHandling, readOwnership: () => ({ ownership: null }), serviceWasInstalled: false,
        observeSupervision: () => false, postInstallPlan: planUpdateRuntimeHandling({ ownership: null, serviceInstalled: false }),
        r: { status: 0 }, res: { status: 0 }, latest: "2.0.0", authorityLauncher: "old", postUpdateLauncher: "fixture",
        postUpdateLauncherUsable: true, trayBeforeUpdate: { refreshAfterReplacement: true, installArgs: ["tray", "install", "--no-start"] },
        trayWasInstalled: true, trayWasRunning: false, stopAttempted: false, existsSync: () => true,
        bakePort: 19001, capturedListen: { port: 19001 }, console: quiet,
        process: { argv: [], execPath: "fixture", env: {}, exit: (n: number) => { exits.push(n); throw n; } },
        shouldRepairCodexShim: () => true, planWindowsTrayUpdate,
        moduleIo: { shim: async () => ({ isCodexShimInstalled: () => true }) },
        spawnSync: (_bin: string, args: string[]) => {
          events.push(args[1]); if (change && args.includes(phase === "shim" ? "codex-shim" : "tray")) home = { kind: "unknown" };
          return { status: 0 };
        },
        mutation: { unprivilegedEnvironment: () => ({}) }, releaseUpdateLease() {}, launcherStartHint: () => "manual",
      }).catch(error => { if (typeof error !== "number") throw error; return error; });
      expect(events).toEqual(change && phase === "shim" ? ["codex-shim"] : ["codex-shim", "tray"]);
      expect(lane === "Node" ? exits[0] : result).toBe(change ? 1 : lane === "Node" ? 0 : undefined);
      expect(refusals).toBe(change ? 1 : 0);
    }
  });
}

test("Bun tray handoff checks authority after its module import", async () => {
  for (const change of [false, true]) {
    let home: UpdateServiceHomeAuthority = { kind: "same" }, running = true, stops = 0;
    const homePolicy = createUpdateServiceHomePolicy(() => home, () => {});
    const result = await execute(section(bun, "  let trayWasInstalled =", "  // Capture listen target"), {
      homePolicy, process: { platform: "win32" }, console: quiet, handoffWindowsTrayForUpdate,
      moduleIo: { tray: async () => {
        await Promise.resolve(); if (change) home = { kind: "unknown" };
        return { getWindowsTrayStatus: () => ({ installed: true, running }),
          stopWindowsTray: () => { stops++; running = false; return { running }; }, startWindowsTray: () => { running = true; } };
      } },
    });
    expect(stops).toBe(change ? 0 : 1); expect(result).toBe(change ? 1 : undefined);
  }
});

for (const phase of ["handoff-import", "tray-refresh"]) test(`full worker refuses ${phase} home changes`, async () => {
  for (const change of [false, true]) {
    let home: UpdateServiceHomeAuthority = { kind: "same" }, running = true, job: any;
    const events: string[] = [];
    const helper = tray.slice(tray.indexOf("export async function defaultWorkerTrayHandoff")).replace("export ", "");
    const entry = worker.slice(worker.indexOf("export async function runGuiUpdateWorker(")).replace("export ", "");
    await execute(helper + entry + 'return runGuiUpdateWorker("probe", "latest", false, io);', {
      readUpdateJob: () => null, readRuntimePort: () => null, readPid: () => null, loadConfig: () => ({ port: 19001 }),
      packageLauncherPath: () => "fixture", writeJob: (j: any) => { job = j; },
      updateJob: (j: any, patch: any, line?: string) => { Object.assign(j, patch); if (line) j.log.push(line); job = j; return j; },
      updateExecutionCommand: () => ({ bin: "fixture", args: ["update"], display: "fixture" }),
      prepareWorkerUpdateHome, packageOnlyUpdateSucceeded, nodeBin: () => "fixture", planWindowsTrayUpdate, handoffWindowsTrayForUpdate,
      withUpdateTeardownHandover: (x: any) => x, withoutUpdateTeardownHandover: (x: any) => x, process: { env: {} },
      PKG: "fixture", UPDATE_TIMEOUT_MS: 1000,
      moduleIo: { tray: async () => {
        await Promise.resolve(); if (change && phase === "handoff-import") home = { kind: "unknown" };
        return { getWindowsTrayStatus: () => ({ installed: true, running }),
          stopWindowsTray: () => { events.push("stop"); running = false; return { running }; },
          startWindowsTray: () => { events.push("restore"); running = true; } };
      } },
      io: { platform: "win32", checkForUpdateFn: () => ({ canUpdate: true, currentVersion: "1.0.0", latestVersion: "2.0.0",
        channel: "latest", installer: "npm", command: "fixture" }), integrityFn: () => ({ ok: true, integrity: "fixture" }),
        cachePreflightFn: () => ({ ok: true }), serviceHomeAuthorityFn: () => home, launcherSupportsUpdateHomeFn: () => true,
        runCommandFn: () => { events.push("package"); return { status: 0 }; },
        trayCommandFn: (_j: any, _bin: any, args: string[]) => {
          events.push(args[2]); if (change && phase === "tray-refresh") home = { kind: "unknown" }; return { status: 0 };
        } },
      withheldSummary: () => "fixture error", GUI_UPDATE_FAILURE_NEXT_STEP: "fixture",
    });
    expect(job.status).toBe(change ? "failed" : "succeeded");
    if (change && phase === "handoff-import") expect(events).toEqual([]);
    if (change) expect(job.error).toContain("ocx service status");
    else expect(events).toEqual(["stop", "package", "install"]);
  }
});

test("worker rechecks service permission after a blocking PID kill", async () => {
  for (const changed of ["same", "absent", "unknown"] as const) {
    let home: UpdateServiceHomeAuthority = { kind: "same" }, kills = 0;
    const wrappers: string[] = [];
    const result = await execute(section(worker, "async function restartAfterUpdate(", "/** Compact listen-holder summary")
      + 'return restartAfterUpdate({installer:"npm"}, {port:19001,hostname:"127.0.0.1"}, io);', {
      createUpdateServiceHomePolicy, loadConfig: () => ({}), restartCommand: () => ({ bin: "fixture", args: [], display: "fixture" }),
      updateJob() {}, RESTART_PORT_RECLAIM_MS: 30000, process: { env: { OCX_SERVICE: "1" }, platform: "win32", pid: 99 },
      moduleIo: { service: async () => ({ serviceReinstallArgs: () => ["service", "install"] }) },
      io: { serviceHomeAuthorityFn: () => home, serviceInstalledFn: () => true, packageLauncherPathFn: () => "fixture",
        waitForPort: async (_p: any, _h: any, opts: any) => opts.mayMutateFn(), listListenPidsFn: () => [],
        verifyOcxFn: () => null, isAliveFn: () => false, stopServiceWrappersFn: () => wrappers.push(home.kind),
        restartServiceManagerFn: async () => "failed", reacquireForDirectStartFn: () => null, readPidFn: () => 17,
        killProxyFn: () => { kills++; home = { kind: changed }; }, spawnStart() {} },
    });
    expect(kills).toBe(1); expect(wrappers).toEqual(changed === "same" ? ["same", "same"] : ["same"]);
    if (changed === "unknown") expect(result).toBe(false);
  }
});

for (const lane of ["Node", "Bun"]) test(`${lane} manager ownership veto is successful skipped recovery`, async () => {
  for (const refusal of [false, true]) {
    let reads = 0, repairs = 0, restarts = 0;
    let home: UpdateServiceHomeAuthority = { kind: "same" };
    const manager = lane === "Node"
      ? section(node, "  function restartThroughServiceManager()", '  /**\n   * Returns "unsupervised"')
      : section(bun, "  const restartThroughServiceManager = async", "  /** Direct start as the last resort");
    const caller = lane === "Node"
      ? section(node, "  function refreshBackgroundServiceOrStartDirect()", "  let updateLease =") + "return refreshBackgroundServiceOrStartDirect();"
      : section(bun, "    if (postInstallPlan.mayRestoreService) {", "    } else if (postInstallPlan.mayStopRuntime) {") + "}";
    const ownership = () => {
      const veto = ++reads === (lane === "Node" ? 3 : 4);
      if (veto && refusal) home = { kind: "unknown" };
      return { ownership: { owner: veto ? "desktop" : "cli" }, ownershipUnknown: false };
    };
    const result = await execute(manager + caller, {
      homePolicy: createUpdateServiceHomePolicy(() => home, () => {}), hasRestartableServiceManager: () => true,
      releaseUpdateLease() {}, mutation: { release() {}, controlEnvironment: () => ({}) },
      resolvedRuntimeOwnership: async () => ownership(), readOwnership: ownership,
      ownershipIdentity: (x: any) => x.ownership?.owner, initialOwnership: { ownership: { owner: "cli" } },
      sameOwner: (x: any) => x.ownership?.owner === "cli", observeSupervision: () => false, planUpdateRuntimeHandling,
      restartServiceManagerJob: () => { restarts++; return { ok: false }; }, postInstallPlan: { mayRestoreService: true },
      console: quiet, process: { env: {}, execPath: "fixture" }, authorityLauncher: "fixture", postUpdateLauncher: "fixture",
      bakePort: 19001, capturedListen: { port: 19001, hostname: "127.0.0.1" }, mutationChildEnvironment: () => ({}),
      serviceRefreshArgs: () => ["service", "repair"], readServiceInstalledFromStatus: () => null,
      moduleIo: { service: async () => ({ serviceReinstallArgs: () => ["service", "repair"] }),
        reclaim: async () => ({ guardedReclaimListenPort: async () => true }) },
      updateChildStdio: () => "inherit", spawnSync: () => { repairs++; return { status: 1 }; },
    });
    expect(repairs).toBe(1); expect(restarts).toBe(0);
    expect(result).toBe(refusal ? lane === "Node" ? "refused" : 1 : undefined);
  }
});
