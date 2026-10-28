import { updateSourceFunction } from "../helpers/update-source-body";
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { repoPath } from "../helpers/repo-root";
import { createUpdateServiceHomePolicy, type UpdateServiceHomeAuthority } from "../../src/update/service-home-policy.mjs";
import { planUpdateRuntimeHandling, planStoppedRuntimeRecovery } from "../../src/update/runtime-ownership.mjs";

const bunUpdate = readFileSync(repoPath("src/update/index.ts"), "utf8");
const nodeUpdate = readFileSync(repoPath("bin/ocx.mjs"), "utf8");
function section(source: string, start: string, end: string) {
  const from = source.indexOf(start), to = source.indexOf(end, from);
  expect(from).toBeGreaterThan(0); expect(to).toBeGreaterThan(from);
  return source.slice(from, to);
}
function runUpdateBody(code: string) {
  // Only replace module-loading I/O; execute the unchanged production function bodies.
  code = code.replaceAll('await import("../service")', "await deps.service()")
    .replaceAll('await import("./guarded-port-reclaim")', "await deps.reclaim()");
  const js = new Bun.Transpiler({ loader: "ts" }).transformSync(`async function run() { ${code} }`);
  return updateSourceFunction("deps", `with (deps) { ${js}; return run(); }`);
}

for (const lane of ["service refresh", "failed-update repair", "proxy stop"] as const) {
  for (const changed of ["unknown", "foreign", "absent"] as const) {
    test(`production ${lane} rechecks ${changed} home after final ownership await`, async () => {
      let home: UpdateServiceHomeAuthority = { kind: "same" }, reads = 0, directStarts = 0;
      const commands: string[][] = [], warnings: string[] = [];
      const flipAt = lane === "failed-update repair" ? 3 : lane === "service refresh" ? 2 : 1;
      const homePolicy = createUpdateServiceHomePolicy(() => home, message => warnings.push(message));
      const code = lane === "service refresh"
        ? section(bunUpdate, "    if (postInstallPlan.mayRestoreService) {", "    } else if (postInstallPlan.mayStopRuntime) {") + "}"
        : lane === "failed-update repair"
          ? section(bunUpdate, "  const recoverStoppedRuntime = async", "  try {\n  // Never replace package files") + 'return await recoverStoppedRuntime("fixture failure");'
          : section(bunUpdate, "  if (!homePolicy.packageOnly && runtimePlan.mayStopRuntime", '    if (stopStdio === "pipe") logSpawnOutput') + "}";
      const result = await runUpdateBody(code)({
        deps: { service: async () => ({ serviceReinstallArgs: () => ["service", "repair"], isServiceViable: () => true }),
          reclaim: async () => ({ guardedReclaimListenPort: async () => true }) },
        homePolicy, postInstallPlan: { mayRestoreService: true }, planUpdateRuntimeHandling, planStoppedRuntimeRecovery,
        resolvedRuntimeOwnership: async () => {
          if (++reads === flipAt) home = changed === "foreign" ? { kind: changed, subject: "a".repeat(64) } : { kind: changed };
          return { ownership: null, ownershipUnknown: false };
        },
        observeSupervision: () => false, sameOwner: () => true,
        mutation: { release() {}, controlEnvironment: () => ({}) },
        serviceWasInstalled: true, stopAttempted: true, hadRuntimeState: true,
        postUpdateLauncherUsable: true, postUpdateLauncher: "/fixture/launcher", existsSync: () => true,
        currentPackageRuntimeLiveness: () => "dead", capturedListen: { port: 19001, hostname: "127.0.0.1" },
        process: { execPath: "/fixture/bun", env: {}, platform: "linux" },
        console: { log() {}, warn: (message: string) => warnings.push(message), error() {} }, updateChildStdio: () => "inherit",
        spawnSync: (_bin: string, args: string[]) => { commands.push(args); return { status: 0 }; },
        runtimePlan: { mayStopRuntime: true }, readPid: () => 200, readRuntimePort: () => null,
        pendingTeardownOutstanding: () => false, supervisionLatch: { observe: () => false },
        inspectDesktopSupervision: () => false, runtimeTrusted: false, selfLaunchArgv: (args: string[]) => args,
        startProxyDirectly: async () => { directStarts++; return true; },
      });
      expect(reads).toBe(flipAt);
      expect(commands).toEqual([]);
      if (changed === "absent" && lane !== "proxy stop") expect(directStarts).toBe(1);
      else {
        expect(directStarts).toBe(0);
        expect(warnings.some(message => message.includes("ocx service status"))).toBe(true);
        if (lane !== "failed-update repair") expect(result).toBe(1);
      }
    });
  }
}

for (const lane of ["Bun", "Node"] as const) for (const boundary of ["lease", "owner"] as const) {
  test(`${lane} successful-update caller fails on direct home refusal after ${boundary}`, async () => {
    const source = lane === "Bun" ? bunUpdate : nodeUpdate;
    const direct = section(source, lane === "Bun" ? "  const startProxyDirectly = async" : "  function startProxyDirectly()", "  // #7043:");
    let code: string;
    if (lane === "Bun") {
      code = direct + section(source, "  const startUnsupervisedFallback = async", "  const recoverStoppedRuntime = async")
        + section(source, "    if (postInstallPlan.mayRestoreService) {", "    } else if (postInstallPlan.mayStopRuntime) {") + "}";
    } else {
      const from = source.indexOf("    if (postInstallPlan.mayRestoreService) {");
      const to = source.indexOf("    guardedExit(homePolicy.authorizeMutation, \"publish\", 0);", from) + "    guardedExit(homePolicy.authorizeMutation, \"publish\", 0);".length;
      code = direct + section(source, "  function refreshBackgroundServiceOrStartDirect()", "  let updateLease =") + source.slice(from, to);
    }
    const invoke = runUpdateBody(code);
    // The same caller keeps ordinary ownership vetoes successful.
    for (const homeRefusal of [true, false]) {
      let home: UpdateServiceHomeAuthority = { kind: "same" }, starts = 0, acquiring = false, refusals = 0;
      const exits: number[] = [], warnings: string[] = [];
      const homePolicy = createUpdateServiceHomePolicy(() => home, message => { refusals++; warnings.push(message); });
      const owner = () => {
        if (acquiring && boundary === "owner" && homeRefusal) home = { kind: "unknown" };
        return { ownership: !homeRefusal && acquiring ? { owner: "desktop" } : null, ownershipUnknown: false };
      };
      const acquire = () => { acquiring = true; if (homeRefusal && boundary === "lease") home = { kind: "unknown" }; };
      const result = await invoke({
        deps: { service: async () => ({ serviceReinstallArgs: () => ["service", "repair"] }),
          reclaim: async () => ({ guardedReclaimListenPort: async () => true }) },
        homePolicy, authorityLauncher: "/fixture/launcher", postUpdateLauncher: "/fixture/launcher", postUpdateLauncherUsable: true,
        postInstallPlan: { mayRestoreService: true }, observeSupervision: () => false, planUpdateRuntimeHandling,
        readOwnership: owner, resolvedRuntimeOwnership: async () => owner(), initialOwnership: { ownership: null },
        ownershipIdentity: (value: { ownership: unknown }) => JSON.stringify(value.ownership), sameOwner: () => homeRefusal || !acquiring,
        process: { env: {}, execPath: "/fixture/runtime", platform: "linux", exit: (code: number) => { exits.push(code); throw code; } },
        console: { log() {}, warn: (message: string) => warnings.push(message) }, bakePort: 19001,
        mutationChildEnvironment: () => ({}), serviceRefreshArgs: () => ["service", "repair"],
        spawnSync: () => ({ status: 1 }), readServiceInstalledFromStatus: () => true,
        restartThroughServiceManager: () => "failed", releaseUpdateLease() {}, reacquireUpdateLease: acquire,
        mutation: { release() {}, reacquire: acquire, controlEnvironment: () => ({}) },
        capturedListen: { port: 19001, hostname: "127.0.0.1" }, updateChildStdio: () => "inherit",
        spawn: () => { starts++; throw new Error("unauthorized spawn"); },
      }).catch((error: unknown) => { if (typeof error !== "number") throw error; return error; });
      expect(starts).toBe(0);
      expect(refusals).toBe(homeRefusal ? 1 : 0);
      expect(lane === "Node" ? exits : [result]).toEqual([homeRefusal ? 1 : lane === "Node" ? 0 : undefined]);
      if (homeRefusal) expect(warnings.some(message => message.includes("ocx service status"))).toBe(true);
    }
  });
}

// Execute the production bodies with OS/process I/O injected, as in update-home-recovery.
function extract(file: string, start: string, end: string, invoke: string) {
  const source = readFileSync(repoPath(file), "utf8");
  const from = source.indexOf(start), to = source.indexOf(end, from);
  expect(from).toBeGreaterThan(0); expect(to).toBeGreaterThan(from);
  const code = new Bun.Transpiler({ loader: "ts" }).transformSync(source.slice(from, to));
  return updateSourceFunction("deps", `with (deps) { ${code}; return ${invoke}; }`);
}
const ghost = extract("src/update/job.ts", "async function waitForGhostListenClear(", "function packageLauncherPath(", "waitForGhostListenClear");
const restart = extract("src/update/job.ts", "async function restartAfterUpdate(", "/** Compact listen-holder summary", "restartAfterUpdate");
const prepare = extract("src/update/job.ts", "function preparePortForPinnedStart(", "function spawnDetachedStart(", "preparePortForPinnedStart");

test("worker skips service-wrapper stop when registration disappears during service import", async () => {
  let home: UpdateServiceHomeAuthority = { kind: "same" }, wrappers = 0, waits = 0;
  const job: { status?: string; restarted?: boolean } = {};
  const code = section(readFileSync(repoPath("src/update/job.ts"), "utf8"), "async function restartAfterUpdate(", "/** Compact listen-holder summary");
  const invoke = await runUpdateBody(code + "return restartAfterUpdate;")({
    deps: { service: async () => { home = { kind: "absent" }; return { serviceReinstallArgs: () => ["service", "repair"] }; } },
    createUpdateServiceHomePolicy, inspectUpdateServiceHome: () => home,
    updateJob: (_job: object, state: object) => Object.assign(job, state),
    loadConfig: () => ({}), restartCommand: () => ({}), RESTART_PORT_RECLAIM_MS: 100,
    process: { pid: 100 },
  });
  expect(await invoke(job, { port: 19001, hostname: "127.0.0.1" }, {
    serviceHomeAuthorityFn: () => home, serviceInstalledFn: () => true,
    packageLauncherPathFn: () => "fixture launcher", listListenPidsFn: () => [],
    verifyOcxFn: () => null, isAliveFn: () => false,
    stopServiceWrappersFn: () => { wrappers++; },
    waitForPort: async () => { waits++; home = { kind: "unknown" }; return false; },
  })).toBe(false);
  expect(waits).toBe(1); expect(wrappers).toBe(0);
  expect(job).toMatchObject({ status: "failed", restarted: false });
});

const preparationBoundaries = [
  "entry", "wrappers", "pid read", "pid kill", "pid removal", "empty pid read",
  "empty pid removal", "runtime removal", "holder scan", "holder verification", "holder kill", "final scan",
] as const;
for (const changed of ["foreign", "unknown"] as const) for (const boundary of preparationBoundaries) {
  test(`real pinned preparation refuses ${changed} authority at ${boundary}`, () => {
    let home: UpdateServiceHomeAuthority = { kind: "absent" };
    let flipped = false, scans = 0;
    const unauthorized: string[] = [], actions: string[] = [];
    const flipAt = (at: string) => {
      if (boundary !== at) return;
      flipped = true;
      home = changed === "foreign" ? { kind: changed, subject: "a".repeat(64) } : { kind: changed };
    };
    const mutate = (action: string) => {
      if (flipped) unauthorized.push(action);
      actions.push(action);
      flipAt(action);
    };
    const policy = createUpdateServiceHomePolicy(() => home, () => {}, false);
    let denied = false;
    const gate = () => { denied ||= !policy.check(); return !denied; };
    const run = prepare({
      process: { pid: 100, platform: "win32" }, updateJob: () => {},
      readPid: () => { flipAt(boundary === "empty pid read" ? "empty pid read" : "pid read"); return boundary.startsWith("empty") ? null : 200; },
      killProxy: (pid: number) => mutate(pid === 200 ? "pid kill" : "holder kill"),
      removePid: (pid?: number) => mutate(pid ? "pid removal" : "empty pid removal"),
      removeRuntimePort: () => mutate("runtime removal"),
      dropWindowsTcpRowsForLocalPort: () => mutate("TCP drop"),
    });
    flipAt("entry");
    const result = run({}, 19001,
      () => { flipAt(++scans === 1 ? "holder scan" : "final scan"); return scans === 1 ? [300, 400] : []; },
      () => true,
      (pid: number) => { flipAt("holder verification"); return pid; },
      () => mutate("wrappers"), gate);
    expect(flipped).toBe(true); // Every case must reach its injected authority transition.
    expect(unauthorized).toEqual([]); // Includes kills, shared-state removals, wrappers and TCP drops.
    expect(result).toBe(false);
    expect(actions).not.toContain("TCP drop");
  });
}

test("real pinned preparation still cleans an authorized home", () => {
  const actions: string[] = [];
  const run = prepare({
    process: { pid: 100, platform: "win32" }, updateJob: () => {}, readPid: () => 200,
    killProxy: (pid: number) => actions.push(`kill ${pid}`), removePid: () => actions.push("pid removal"),
    removeRuntimePort: () => actions.push("runtime removal"), dropWindowsTcpRowsForLocalPort: () => actions.push("TCP drop"),
  });
  let scans = 0;
  expect(run({}, 19001, () => ++scans === 1 ? [100, 300, 400, 500] : [],
    (pid: number) => pid !== 500, (pid: number) => pid === 300 ? pid : null,
    () => actions.push("wrappers"), () => true)).not.toBe(false);
  expect(actions).toEqual(["wrappers", "kill 200", "pid removal", "runtime removal", "kill 300", "TCP drop"]);
});

for (const changed of ["foreign", "unknown"] as const) test(`restart propagates real preparation's ${changed} refusal before ghost wait`, async () => {
  let home: UpdateServiceHomeAuthority = { kind: "absent" };
  let preparing = false, scans = 0, kills = 0, drops = 0, waits = 0, starts = 0;
  const job: { status?: string; restarted?: boolean; error?: string } = {};
  const updateJob = (_job: object, state: object) => Object.assign(job, state);
  const preparePortForPinnedStart = prepare({
    process: { pid: 100, platform: "win32" }, updateJob,
    readPid: () => { preparing = true; return null; }, removePid: () => {}, removeRuntimePort: () => {},
    killProxy: () => { kills++; }, dropWindowsTcpRowsForLocalPort: () => { drops++; },
  });
  const run = restart({
    createUpdateServiceHomePolicy, inspectUpdateServiceHome: () => home, updateJob,
    loadConfig: () => ({}), restartCommand: () => ({}), RESTART_PORT_RECLAIM_MS: 100,
    process: { pid: 100 }, preparePortForPinnedStart,
    waitForGhostListenClear: async () => { waits++; return { ok: true, accessDenied: false }; },
  });
  const result = await run(job, { port: 19001, hostname: "127.0.0.1" }, {
    serviceHomeAuthorityFn: () => home, packageLauncherPathFn: () => "fixture launcher", readPidFn: () => null,
    listListenPidsFn: () => {
      if (preparing && ++scans === 1) home = changed === "foreign" ? { kind: changed, subject: "a".repeat(64) } : { kind: changed };
      return preparing && scans === 1 ? [300] : [];
    },
    verifyOcxFn: (pid: number) => pid, isAliveFn: () => true,
    waitForPort: async () => true, probeProxyIdentity: async () => null,
    spawnDetachedStartFn: () => { starts++; throw new Error("unauthorized spawn"); },
  });
  expect(result).toBe(false);
  expect(job).toMatchObject({ status: "failed", restarted: false });
  expect(job.error).toContain("ocx service status");
  expect({ scans, kills, drops, waits, starts }).toEqual({ scans: 1, kills: 0, drops: 0, waits: 0, starts: 0 });
});

for (const reclaimed of [false, true]) for (const changed of ["foreign", "unknown"] as const) {
  test(`ghost wait refuses ${changed} authority before TCP mutation (${reclaimed ? "pinned attempt" : "reclaim timeout"})`, async () => {
    let now = 0, drops = 0, waits = 0, starts = 0, prepares = 0;
    let home: UpdateServiceHomeAuthority = { kind: "absent" };
    const job: { status?: string; restarted?: boolean; error?: string } = {};
    const logs: string[] = [];
    const waitForGhost = ghost({
      process: { pid: 100, platform: "win32" }, Date: { now: () => now },
      isProcessAlive: () => false,
      dropWindowsTcpRowsForLocalPort: () => { drops++; return { accessDenied: 0 }; },
      strictRuntimePortAvailable: async () => false,
    });
    const run = restart({
      createUpdateServiceHomePolicy, inspectUpdateServiceHome: () => home,
      updateJob: (_job: object, state: object, log?: string) => { Object.assign(job, state); if (log) logs.push(log); },
      loadConfig: () => ({}), restartCommand: () => ({}), RESTART_PORT_RECLAIM_MS: 100,
      process: { pid: 100 }, waitForGhostListenClear: waitForGhost,
      formatPortHolders: () => "fixture holders",
    });
    const io = {
      serviceHomeAuthorityFn: () => home,
      packageLauncherPathFn: () => "fixture launcher", readPidFn: () => null,
      listListenPidsFn: () => [9999], verifyOcxFn: () => null, isAliveFn: () => false,
      waitForPort: async () => reclaimed, probeProxyIdentity: async () => null,
      probeProxy: async () => true, preparePortForPinnedStartFn: () => { prepares++; },
      spawnDetachedStartFn: () => { starts++; throw new Error("unauthorized spawn"); },
      sleepMs: async () => {
        waits++; now += waits === 1 ? 500 : 100_000;
        home = changed === "foreign" ? { kind: changed, subject: "a".repeat(64) } : { kind: changed };
      },
    };
    const result = await run(job, { port: 19001, hostname: "127.0.0.1" }, io).catch((error: unknown) => error);
    expect(drops).toBe(1); // The first drop was authorized; the next iteration must refuse.
    expect(result).toBe(false);
    expect(job).toMatchObject({ status: "failed", restarted: false });
    expect(job.error).toContain("ocx service status");
    expect(waits).toBe(1); expect(starts).toBe(0); expect(prepares).toBe(reclaimed ? 1 : 0);
    expect(logs.some(line => /did not clear|not bindable|access denied/.test(line))).toBe(false);
  });
}

for (const reclaimed of [false, true]) test(`ghost denial stays latched after a transient re-match (${reclaimed})`, async () => {
  let denied = false, checks = 0, prepares = 0;
  const job: { status?: string; error?: string } = {};
  const run = restart({
    createUpdateServiceHomePolicy, inspectUpdateServiceHome: () => ({ kind: "absent" }),
    updateJob: (_job: object, state: object) => Object.assign(job, state),
    loadConfig: () => ({}), restartCommand: () => ({}), RESTART_PORT_RECLAIM_MS: 100,
    process: { pid: 100 }, formatPortHolders: () => "fixture holders",
    waitForGhostListenClear: async (...args: unknown[]) => {
      // Re-match before the wait returns: only the gate's latch remembers the denial.
      const gate = args[6] as (() => boolean) | undefined;
      denied = true; const refused = gate?.() === false; denied = false;
      expect(refused).toBe(true);
      return { ok: false, accessDenied: false };
    },
  });
  expect(await run(job, { port: 19001, hostname: "127.0.0.1" }, {
    serviceHomeAuthorityFn: () => { checks++; return { kind: denied ? "unknown" : "absent" }; },
    packageLauncherPathFn: () => "fixture launcher", readPidFn: () => null,
    listListenPidsFn: () => [9999], verifyOcxFn: () => null, isAliveFn: () => false,
    waitForPort: async () => reclaimed, probeProxyIdentity: async () => null,
    spawnDetachedStartFn: () => { throw new Error("unauthorized spawn"); },
    preparePortForPinnedStartFn: () => { prepares++; }, sleepMs: async () => {},
  })).toBe(false);
  expect(job.status).toBe("failed"); expect(job.error).toContain("ocx service status");
  expect(checks).toBeGreaterThan(1); expect(prepares).toBe(reclaimed ? 1 : 0);
});

for (const lane of ["Bun", "Node"] as const) test(`${lane} direct recovery reports a retained lease without throwing or probing/spawning`, async () => {
  const direct = lane === "Bun"
    ? extract("src/update/index.ts", "  const startProxyDirectly = async", "  // #7043:", "startProxyDirectly")
    : extract("bin/ocx.mjs", "  function startProxyDirectly()", "  // #7043:", "startProxyDirectly");
  const warnings: string[] = [];
  let acquisitions = 0, probes = 0, spawns = 0;
  const acquire = () => {
    acquisitions++;
    throw Object.assign(new Error("OWNERSHIP_MUTATION_LEASE_BUSY private fixture details"), { code: "OWNERSHIP_MUTATION_LEASE_BUSY" });
  };
  const result = await direct({
    mutation: { reacquire: acquire }, reacquireUpdateLease: acquire,
    homePolicy: { check: () => { probes++; return true; } },
    readOwnership: () => { probes++; }, resolvedRuntimeOwnership: async () => { probes++; },
    spawn: () => { spawns++; }, console: { warn: (line: string) => warnings.push(line), error: (line: string) => warnings.push(line) },
  })();
  expect(result).toBe(false); expect(acquisitions).toBe(1); expect(probes).toBe(0); expect(spawns).toBe(0);
  expect(warnings).toHaveLength(1);
  expect(warnings[0]).toContain("ocx service repair"); expect(warnings[0]).toContain("ocx start");
  expect(warnings[0]).not.toContain("private fixture details"); expect(warnings[0]).not.toContain("OWNERSHIP_MUTATION_LEASE_BUSY");
});
