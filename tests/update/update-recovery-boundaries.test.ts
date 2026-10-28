import { updateSourceFunction } from "../helpers/update-source-body";
import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { repoPath } from "../helpers/repo-root";
import { createTempHome } from "../helpers/temp-home";
import { createUpdateServiceHomePolicy, parseUpdateWorkerHome, UPDATE_PACKAGE_ONLY_EXIT_CODE, type UpdateServiceHomeAuthority } from "../../src/update/service-home-policy.mjs";
import { inspectPackageRuntimeLiveness, planUpdateRuntimeHandling, planStoppedRuntimeRecovery } from "../../src/update/runtime-ownership.mjs";
import { npmUpdateFailureGuidance } from "../../src/update/update-failure-guidance.mjs";
import { prepareWorkerUpdateHome } from "../../src/update/job-update-home";
import { createSupervisionLatch } from "../../src/service/desktop-supervision.mjs";
import { handoffWindowsTrayForUpdate, planWindowsTrayUpdate } from "../../src/update/tray-update-plan.mjs";
import { transactionalNpmUpdate, transactionalNpmUpdateAsync, launcherUsableAfterNpmUpdate } from "../../src/update/transactional-install.mjs";

const node = readFileSync(repoPath("bin/ocx.mjs"), "utf8");
const bun = readFileSync(repoPath("src/update/index.ts"), "utf8");
const worker = readFileSync(repoPath("src/update/job.ts"), "utf8");
function section(source: string, start: string, end: string) {
  const from = source.indexOf(start), to = source.indexOf(end, from);
  expect(from).toBeGreaterThan(0); expect(to).toBeGreaterThan(from);
  return source.slice(from, to);
}
function execute(code: string, deps: object) {
  code = code.replaceAll('await import("../service")', "await moduleIo.service()")
    .replaceAll('await import("./guarded-port-reclaim")', "await moduleIo.reclaim()");
  const js = new Bun.Transpiler({ loader: "ts" }).transformSync(`async function run() { ${code} }`);
  return updateSourceFunction("deps", `with (deps) { ${js}; return run(); }`)(deps);
}
function tree(path: string, version: string) {
  mkdirSync(join(path, "bin"), { recursive: true });
  mkdirSync(join(path, "node_modules", "zod"), { recursive: true });
  writeFileSync(join(path, "package.json"), JSON.stringify({ version, dependencies: { zod: "1" } }));
  writeFileSync(join(path, "bin", "ocx.mjs"), "// fixture\n".repeat(200));
  writeFileSync(join(path, "node_modules", "zod", "package.json"), "{}");
}

// Entire launcher + real transaction. Only registry, installer, home and process I/O change.
for (const platform of ["win32", "linux"] as const) {
  for (const changed of ["stable", "home", "owner", "supervision", "liveness", "liveness-home", "package-only-stable", "package-only-changed"] as const) {
    test(`production ${platform} npm swap rechecks ${changed} after installer completion`, async () => {
      const temp = createTempHome("ocx-swap-authority-");
      try {
        const live = temp.path("scope", "opencodex"); tree(live, "1.0.0");
        const packageOnly = changed.startsWith("package-only");
        const success = changed === "stable" || changed === "package-only-stable";
        let installed = false, home: UpdateServiceHomeAuthority = { kind: packageOnly ? "unknown" : "absent" };
        const exits: number[] = [], logs: string[] = [];
        const launcher = repoPath("bin/ocx.mjs");
        const command = { bin: "fixture-bun", args: ["add", "-g", "@bitkyc08/opencodex@2.0.0"], display: "fixture" };
        if (packageOnly) {
          // The Bun worker's real caller delegates restricted installs to the guarded launcher.
          expect(prepareWorkerUpdateHome(command, "bun", launcher, "fixture-node", "latest", () => {}, () => home, () => true)).not.toBeNull();
          expect(command.args).toContain("--update-package-only");
          expect(command.args).toContain("--update-worker-home");
        }
        const body = section(node, "async function runPackageManagerSelfUpdate(manager) {", "function bunBinDir(")
          .replaceAll("import.meta.url", JSON.stringify(new URL("../../bin/ocx.mjs", import.meta.url).href));
        const stage = (args: string[]) => {
          tree(join(args[args.indexOf("--prefix") + 1]!, "node_modules", "@bitkyc08", "opencodex"), "2.0.0");
          installed = true;
          if (changed === "home") home = { kind: "unknown" };
          if (changed === "package-only-changed") home = { kind: "same" };
          return { status: 0, processTreeExited: true };
        };
        await execute(body + 'return runPackageManagerSelfUpdate("npm");', {
          process: { argv: packageOnly ? [process.execPath, ...command.args] : [process.execPath, launcher, "update"], env: {}, execPath: process.execPath, platform,
            exit: (code: number) => { exits.push(code); throw code; } },
          console: { log: (line: string) => logs.push(line), warn: (line: string) => logs.push(line), error: (line: string) => logs.push(line) },
          PKG: "@bitkyc08/opencodex", here: join(live, "bin"), dirname, join, resolve, fileURLToPath,
          currentPackageVersion: () => "1.0.0", updateTag: () => "latest",
          npmInvocation: (args: string[]) => ({ file: "fixture-npm", args }),
          spawnSync: (_bin: string, args: string[]) => args[0] === "view" ? { status: 0, stdout: "2.0.0\n" } : stage(args),
          checkRegistryPackageIntegrity: () => ({ ok: true, integrity: "sha512-fixture" }),
          resolveNpmCachePath: () => ({ ok: true, path: temp.root }), runNpmCachePreflight: () => ({ ok: true }),
          unprivilegedOwnershipMutationEnvironment: (env: object) => env,
          serviceStateFilesFor: () => [], configDir: () => temp.root, homedir: () => temp.root,
          createUpdateServiceHomePolicy, parseUpdateWorkerHome, UPDATE_PACKAGE_ONLY_EXIT_CODE,
          readNodeUpdateHome: () => home, existsSync, readFileSync, readdirSync,
          selectAuthoritativeServiceState: () => installed && changed === "owner"
            ? { kind: "state", revision: 1, state: { ownership: { owner: "desktop", installId: "other" } } }
            : { kind: "none", revision: 0 },
          inspectInstallStateBytes: () => ({ kind: "absent" }),
          createSupervisionLatch: () => ({ observe: (value: boolean) => value }),
          inspectDesktopSupervision: () => installed && changed === "supervision",
          planUpdateRuntimeHandling, planStoppedRuntimeRecovery, inspectPackageRuntimeLiveness, handoffWindowsTrayForUpdate, planWindowsTrayUpdate,
          trayInstallState: () => ({ installed: false, running: false }),
          probeProxyLiveness: () => {
            if (installed && changed === "liveness-home") home = { kind: "unknown" };
            return installed && changed === "liveness" ? "live" : "dead";
          }, hasPendingTeardownIn: () => false,
          acquireOwnershipMutationLease: () => ({ token: "fixture", release() {} }),
          transactionalNpmUpdateAsync, transactionalNpmUpdateSync: transactionalNpmUpdate,
          runNpmInstall: async (invocation: { args: string[] }) => { await Promise.resolve(); return stage(invocation.args); },
          launcherUsableAfterNpmUpdate, npmUpdateFailureGuidance, repairCodexShimIfNeeded() {}, launcherStartHint: () => "fixture start",
        }).catch((error: unknown) => { if (typeof error !== "number") throw error; });
        expect(installed).toBe(true);
        expect(exits).toEqual([success ? packageOnly ? UPDATE_PACKAGE_ONLY_EXIT_CODE : 0 : 1]);
        expect(JSON.parse(readFileSync(join(live, "package.json"), "utf8")).version).toBe(success ? "2.0.0" : "1.0.0");
        expect(readdirSync(dirname(live)).filter(name => name.startsWith(".ocx-staging-"))).toEqual([]);
        if (!success) expect(readdirSync(dirname(live)).filter(name => name.startsWith(".ocx-backup-"))).toEqual([]);
      } finally { temp.remove(); }
    });
  }
}

test("npm authorization refusal preserves the usable launcher and previous-version guidance", () => {
  const failure = { ok: false, phase: "authorize" };
  expect(launcherUsableAfterNpmUpdate(failure)).toBe(true);
  expect(npmUpdateFailureGuidance({ ...failure, pkgName: "@fixture/opencodex", tag: "latest" }).previousVersionKept).toBe(true);
});

for (const outcome of ["false", "throw", "promise"] as const) test(`async transaction fails closed on ${outcome} authorization`, async () => {
  const temp = createTempHome("ocx-swap-refusal-");
  try {
    const live = temp.path("scope", "opencodex"); tree(live, "1.0.0");
    const result = await transactionalNpmUpdateAsync({ packageDir: live, pkgName: "@fixture/opencodex", tag: "latest",
      mayReplacePackage: (() => {
        if (outcome === "throw") throw new Error("private authority detail");
        return outcome === "promise" ? Promise.resolve(true) : false;
      }) as () => boolean,
      runNpm: async args => {
        tree(join(args[args.indexOf("--prefix") + 1]!, "node_modules", "@fixture", "opencodex"), "2.0.0");
        return { status: 0, processTreeExited: true };
      },
    });
    expect(result).toMatchObject({ ok: false, phase: "authorize" });
    expect(JSON.stringify(result)).not.toContain("private authority detail");
    expect(JSON.parse(readFileSync(join(live, "package.json"), "utf8")).version).toBe("1.0.0");
    expect(readdirSync(dirname(live))).toEqual(["opencodex"]);
  } finally { temp.remove(); }
});

test("production pinned caller checks current service permission inside its wrapper callback", async () => {
  const prepare = section(worker, "function preparePortForPinnedStart(", "function spawnDetachedStart(");
  const caller = section(worker, '    if (!homePolicy.authorizeMutation("runtime")) return false;\n    if (preparePort(', "    const ready = await waitForGhost(");
  for (const changed of ["same", "absent", "unknown"] as const) {
    let reads = 0, wrappers = 0, cleanup = 0;
    const homePolicy = createUpdateServiceHomePolicy(() => ({ kind: ++reads < 3 ? "same" : changed }), () => {});
    const result = await execute(prepare + "const preparePort = preparePortForPinnedStart;" + caller, {
      homePolicy, reclaimGate: () => homePolicy.authorizeMutation("runtime"), job: {}, port: 19001,
      listPids: () => [], aliveFn: () => false, verifyOcx: () => null, serviceInstalled: true,
      io: { stopServiceWrappersFn: () => { wrappers++; } },
      process: { pid: 1, platform: "linux" }, readPid: () => null,
      removePid: () => { cleanup++; }, removeRuntimePort: () => { cleanup++; },
    });
    expect(wrappers).toBe(changed === "same" ? 1 : 0);
    expect(cleanup).toBe(changed === "unknown" ? 0 : 2);
    expect(result).toBe(changed === "unknown" ? false : undefined);
  }
});

for (const mutation of ["shim", "tray"] as const) test(`production Node foreground fails on home refusal during ${mutation}`, async () => {
  let kind: "absent" | "unknown" = "absent", mutations = 0;
  const exits: number[] = [], warnings: string[] = [];
  const change = () => { mutations++; kind = "unknown"; };
  const code = section(node, "  const postInstallPlan =", "\n  if (trayBeforeUpdate.restoreOnFailure && postUpdateLauncherUsable");
  await execute(code, {
    planUpdateRuntimeHandling, readOwnership: () => ({ ownership: null }), serviceWasInstalled: false, observeSupervision: () => false,
    res: { status: 0 }, latest: "2.0.0", authorityLauncher: "old", postUpdateLauncher: "new",
    homePolicy: createUpdateServiceHomePolicy(() => ({ kind }), line => warnings.push(line)),
    trayBeforeUpdate: { refreshAfterReplacement: mutation === "tray", installArgs: ["tray", "install"] }, postUpdateLauncherUsable: true,
    stopAttempted: true, existsSync: () => true, bakePort: 19001,
    console: { log() {}, warn() {} }, process: { argv: [], exit: (code: number) => { exits.push(code); throw code; } },
    repairCodexShimIfNeeded: mutation === "shim" ? change : () => {},
    spawnSync: () => { change(); return { status: 0 }; }, mutationChildEnvironment: () => ({}),
    releaseUpdateLease() {},
  }).catch((error: unknown) => { if (typeof error !== "number") throw error; });
  expect(mutations).toBe(1); expect(warnings).toHaveLength(1); expect(exits).toEqual([1]);
});

const callers = ["Node foreground", "Node absent entry", "Node absent after repair", "Bun foreground",
  "Bun absent after reclaim", "Bun absent before repair", "Bun absent after repair"] as const;
for (const caller of callers) for (const outcome of ["vetoed", "refused", true] as const) {
  test(`production ${caller} direct recovery ${outcome} -> ${outcome === "refused" ? 1 : 0}`, async () => {
    const isNode = caller.startsWith("Node");
    let acquiring = false, ownerReads = 0, starts = 0, repairs = 0;
    let home: UpdateServiceHomeAuthority = { kind: caller.includes("foreground") || caller.endsWith("entry") ? "absent" : "same" };
    const warnings: string[] = [];
    const homePolicy = createUpdateServiceHomePolicy(() => home, line => warnings.push(line));
    const acquire = () => { acquiring = true; if (outcome === "refused") home = { kind: "unknown" }; };
    const ownership = () => {
      ownerReads++;
      if (caller === "Bun absent before repair" && ownerReads === 2) home = { kind: "absent" };
      return { ownership: acquiring && outcome === "vetoed" ? { owner: "desktop", installId: "other" } : null, ownershipUnknown: false };
    };
    let code: string;
    if (isNode) {
      code = section(node, "  const ownershipIdentity =", "  const supervisionLatch =")
        + section(node, "  function startProxyDirectly()", "  // #7043:");
      if (caller === "Node foreground") {
        const from = node.indexOf("    } else if (postInstallPlan.mayStopRuntime");
        const end = node.indexOf("    guardedExit(homePolicy.authorizeMutation, \"publish\", 0);", from) + "    guardedExit(homePolicy.authorizeMutation, \"publish\", 0);".length;
        code += "if (false) {" + node.slice(from, end);
      } else code += section(node, "  function refreshBackgroundServiceOrStartDirect()", "  let updateLease =")
        + 'const result = refreshBackgroundServiceOrStartDirect(); return result === undefined ? 0 : 1;';
    } else {
      code = section(bun, "  const sameOwner =", "  // #7043:");
      code += caller === "Bun foreground"
        ? section(bun, "    if (!homePolicy.serviceAllowed && postInstallPlan.mayStopRuntime)", "    if (postInstallPlan.mayRestoreService)")
        : section(bun, "    if (postInstallPlan.mayRestoreService) {", "    } else if (postInstallPlan.mayStopRuntime) {") + "}";
    }
    const result = await execute(code, {
      homePolicy, initialOwnership: { ownership: null }, readOwnership: ownership, resolvedRuntimeOwnership: async () => ownership(),
      observeSupervision: () => false, planUpdateRuntimeHandling,
      postInstallPlan: { mayStopRuntime: true, mayRestoreService: true }, stopAttempted: true,
      authorityLauncher: "old", postUpdateLauncher: "new", postUpdateLauncherUsable: true,
      existsSync: () => true, launcherStartHint: () => "fixture start", bakePort: 19001,
      mutation: { reacquire: acquire, release() {}, controlEnvironment: () => ({}) },
      reacquireUpdateLease: acquire, releaseUpdateLease() {}, mutationChildEnvironment: () => ({}),
      process: { env: {}, execPath: "fixture-runtime", exit: (code: number) => { throw code; } },
      console: { log() {}, warn: (line: string) => warnings.push(line), error() {} },
      capturedListen: { port: 19001, hostname: "127.0.0.1" },
      spawn: () => { starts++; return { on() {}, once() {}, unref() {} }; },
      withoutSiblingMarker: (env: object) => env, withProcessRuntimeProvenance: (env: object) => env,
      readCurrentRuntimeTarget: () => ({ kind: "target", target: { port: 19001, hostname: "127.0.0.1" } }),
      probeProxyLiveness: () => "live", UPDATE_RECOVERY_READY_MS: 1000,
      readUpdateRuntimeTarget: () => ({ kind: "target", target: { port: 19001, hostname: "127.0.0.1", pid: 200 } }),
      getRuntimePortPath: () => "fixture", proxyIdentityAt: async () => ({}),
      moduleIo: {
        service: async () => ({ serviceReinstallArgs: () => ["service", "repair"] }),
        reclaim: async () => ({ guardedReclaimListenPort: async () => {
          if (caller === "Bun absent after reclaim") home = { kind: "absent" };
          return true;
        } }),
      },
      updateChildStdio: () => "inherit", serviceRefreshArgs: () => ["service", "repair"],
      spawnSync: () => { repairs++; home = { kind: "absent" }; return { status: 0 }; },
    }).catch((error: unknown) => { if (typeof error !== "number") throw error; return error; });
    expect(acquiring).toBe(true);
    expect(result ?? 0).toBe(outcome === "refused" ? 1 : 0);
    expect(starts).toBe(outcome === true ? 1 : 0);
    expect(repairs).toBe(caller.endsWith("after repair") ? 1 : 0);
    expect(warnings.some(line => typeof line === "string" && line.includes("ocx service status"))).toBe(outcome === "refused");
  });
}

test("production Node full stop refuses lost service permission before Windows wrapper cleanup", async () => {
  const stop = section(node, "    const stopNeeded =", "    const replacementOwnership =");
  const childStop = section(readFileSync(repoPath("src/service/orchestration.ts"), "utf8"),
    "export function stopServiceIfInstalledDetailed()", "/** Delete install-state files").replace("export ", "");
  const guard = section(readFileSync(repoPath("src/service/guards.ts"), "utf8"),
    "export function assertServiceEnvironmentMatchesInstall(", "/**\n * Refuse a management").replace("export ", "");
  for (const [captured, changed] of [[true, "same"], [true, "absent"], [true, "unknown"], [false, "absent"]] as const) {
    let home: UpdateServiceHomeAuthority = { kind: captured ? "same" : "absent" }, stops = 0, wrappers = 0;
    const allowed = changed === "same" || !captured;
    const warnings: string[] = [], exits: number[] = [];
    const homePolicy = createUpdateServiceHomePolicy(() => home, line => warnings.push(line));
    home = { kind: changed };
    const deps = {
      homePolicy, serviceWasInstalled: captured, hasRuntimeState: !captured, hasPendingTeardown: false,
      runtimePlan: { mayStopRuntime: true }, readOwnership: () => ({ ownership: null, ownershipUnknown: false }),
      observeSupervision: () => false, planUpdateRuntimeHandling, stopAttempted: false,
      releaseUpdateLease() {}, console: { log() {}, warn: (line: string) => warnings.push(line), error() {} },
      process: { platform: "win32", execPath: "fixture", exit: (code: number) => { exits.push(code); throw code; } },
      launcher: "fixture", mutationChildEnvironment: () => ({}),
      resolveServiceState: () => ({ kind: changed === "same" ? "state" : "none", state: {} }),
      currentCodexHome: () => "", serviceCodexHomeMatchesInstall: () => true,
      currentOpenCodexHome: () => "", servicePathMatchesInstall: () => true,
      probeWindowsSchedulerTask: () => ({ status: "absent" }), statusWinswRaw: () => "nonexistent",
      killWindowsServiceWrapperProcesses: () => { wrappers++; }, classifyWindowsServiceStop: () => "absent",
      spawnSync: () => {
        stops++;
        const js = new Bun.Transpiler({ loader: "ts" }).transformSync(guard + childStop);
        updateSourceFunction("deps", `with (deps) { ${js}; return stopServiceIfInstalledDetailed(); }`)(deps);
        throw "stop-observed"; // End at the real child service-stop boundary, before package I/O.
      },
    };
    await execute(stop, deps).catch((error: unknown) => { if (error !== "stop-observed" && error !== 1) throw error; });
    expect(stops).toBe(allowed ? 1 : 0);
    expect(wrappers).toBe(allowed ? 1 : 0);
    expect(exits).toEqual(allowed ? [] : [1]);
    expect(warnings.some(line => line.includes("ocx service status"))).toBe(!allowed);
  }
});

for (const lane of ["Bun entry", "Bun before repair", "Bun before manager", "Node entry", "Node before install"] as const) {
  test(`production ${lane} refresh preserves home refusal over ownership veto`, async () => {
    for (const changed of ["same", "unknown", "foreign"] as const) {
      let home: UpdateServiceHomeAuthority = { kind: "same" }, reads = 0, repairs = 0, imports = 0;
      const warnings: string[] = [];
      const homePolicy = createUpdateServiceHomePolicy(() => home, line => warnings.push(line));
      const isNode = lane.startsWith("Node");
      const vetoAt = lane.endsWith("entry") ? 1 : lane.endsWith("manager") ? 3 : 2;
      const ownership = () => {
        if (++reads !== vetoAt) return { ownership: null, ownershipUnknown: false };
        home = changed === "foreign" ? { kind: "foreign", subject: "a".repeat(64) } : { kind: changed };
        return { ownership: { owner: "desktop", installId: "other" }, ownershipUnknown: false };
      };
      const code = isNode
        ? section(node, "  function refreshBackgroundServiceOrStartDirect()", "  let updateLease =")
          + "return refreshBackgroundServiceOrStartDirect();"
        : section(bun, "    if (postInstallPlan.mayRestoreService) {", "    } else if (postInstallPlan.mayStopRuntime) {") + "}";
      const result = await execute(code, {
        homePolicy, readOwnership: ownership, resolvedRuntimeOwnership: async () => { await Promise.resolve(); return ownership(); },
        observeSupervision: () => false, planUpdateRuntimeHandling, postInstallPlan: { mayRestoreService: true },
        console: { log() {}, warn: (line: string) => warnings.push(line), error() {} },
        process: { env: {}, execPath: "fixture" }, postUpdateLauncher: "fixture", authorityLauncher: "fixture", bakePort: 19001,
        mutation: { release() {}, controlEnvironment: () => ({}) }, mutationChildEnvironment: () => ({}),
        capturedListen: { port: 19001, hostname: "127.0.0.1" }, releaseUpdateLease() {},
        serviceRefreshArgs: () => ["service", "repair"], readServiceInstalledFromStatus: () => false,
        moduleIo: {
          service: async () => { imports++; return { serviceReinstallArgs: () => ["service", "repair"] }; },
          reclaim: async () => ({ guardedReclaimListenPort: async () => true }),
        },
        updateChildStdio: () => "inherit", spawnSync: () => { repairs++; return { status: 1 }; },
      });
      expect(reads).toBe(vetoAt);
      expect(repairs).toBe(lane.endsWith("manager") || lane.endsWith("install") ? 1 : 0);
      expect(imports).toBe(isNode || lane.endsWith("entry") ? 0 : 1);
      expect(result).toBe(changed === "same" ? undefined : isNode ? "refused" : 1);
      expect(warnings.some(line => line.includes("ocx service status"))).toBe(changed !== "same");
    }
  });
}

for (const lane of ["Bun", "Node"] as const) test(`production ${lane} final ownership veto preserves home refusal`, async () => {
  for (const changed of ["same", "unknown", "foreign"] as const) {
    let home: UpdateServiceHomeAuthority = { kind: "same" };
    const warnings: string[] = [];
    const homePolicy = createUpdateServiceHomePolicy(() => home, line => warnings.push(line));
    const ownership = () => {
      home = changed === "foreign" ? { kind: "foreign", subject: "a".repeat(64) } : { kind: changed };
      return { ownership: { owner: "desktop" }, ownershipUnknown: false };
    };
    const code = lane === "Bun"
      ? section(bun, "            const fallbackOwnership =", "            console.warn(\n              serviceRefreshed")
      : section(node, "        const supervision = observeSupervision();\n        const nowOwned =", "        // #7043: the manager first.");
    const result = await execute(code + 'return "continued";', {
      homePolicy, readOwnership: ownership, resolvedRuntimeOwnership: async () => { await Promise.resolve(); return ownership(); },
      observeSupervision: () => false, planUpdateRuntimeHandling, console: { warn: (line: string) => warnings.push(line) },
    });
    expect(result).toBe(changed === "same" ? undefined : lane === "Bun" ? 1 : "refused");
    expect(warnings.some(line => line.includes("ocx service status"))).toBe(changed !== "same");
  }
});

for (const site of ["entry", "reacquire"] as const) test(`production worker ${site} ownership veto preserves home refusal`, async () => {
  const leaseSource = readFileSync(repoPath("src/update/restart-ownership.ts"), "utf8");
  const helpers = section(leaseSource, "export function updateRestartVeto(", "/**\n * The lease boundary").replace("export ", "")
    + "const REACQUIRE_WAIT_MS = 10000;"
    + leaseSource.slice(leaseSource.indexOf("export async function runUpdateRestartWithOwnershipLease<")).replace("export ", "");
  const refuse = section(worker, "    const refuseWorkerHome = () => {", "    if (!homePolicy.packageOnly &&");
  const gate = site === "entry"
    ? section(worker, '      if (outcome.kind === "veto")', "      if (!outcome.value)")
    : section(worker, "  const restartVeto = io.reacquireForDirectStartFn?.();", "  const pid = (io.readPidFn");
  for (const changed of ["same", "unknown", "foreign"] as const) {
    let home: UpdateServiceHomeAuthority = { kind: "same" }, reads = 0, status = "running", refused = false;
    const homePolicy = createUpdateServiceHomePolicy(() => home, () => { refused = true; status = "failed"; });
    const resolveOwnership = () => {
      if (site === "reacquire" && ++reads === 1) return { kind: "none" };
      home = changed === "foreign" ? { kind: "foreign", subject: "a".repeat(64) } : { kind: changed };
      return { kind: "owned", ownership: { owner: "desktop" } };
    };
    const code = site === "entry"
      ? helpers + refuse + 'const outcome = await runUpdateRestartWithOwnershipLease(resolveOwnership, async () => { throw Error("unexpected restart"); });'
        + gate
      : helpers + "return runUpdateRestartWithOwnershipLease(resolveOwnership, async lease => { const io = { reacquireForDirectStartFn: lease.reacquireForDirectStart };"
        + gate + "});";
    await execute(code, {
      homePolicy, resolveOwnership, createSupervisionLatch, planUpdateRuntimeHandling,
      inspectDesktopSupervision: () => ({ kind: "none" }),
      acquireOwnershipMutationLease: () => ({ token: "fixture", release() {} }), serviceStatePaths: () => [],
      process: { env: {} }, OWNERSHIP_MUTATION_LEASE_TOKEN_ENV: "fixtureLease", job: {},
      updateJob: (_job: object, patch: { status?: string }) => { if (patch.status) status = patch.status; },
      trayWasRunning: false, activeLauncherVerified: true, homeRefusal: "fixture refusal",
    });
    expect(refused).toBe(changed !== "same");
    expect(status).toBe(changed === "same" ? "succeeded" : "failed");
  }
});
