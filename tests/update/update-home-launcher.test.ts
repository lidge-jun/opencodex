import { updateSourceFunction } from "../helpers/update-source-body";
import { expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { createTempHome } from "../helpers/temp-home";
import { dirname, join } from "node:path";
import { helperPath, repoPath } from "../helpers/repo-root";
import { prepareWorkerUpdateHome } from "../../src/update/job-update-home";
import { createUpdateServiceHomePolicy, type UpdateServiceHomeAuthority } from "../../src/update/service-home-policy.mjs";
import { updateHomeProbeEnvironment } from "../../src/update/service-home-probe.mjs";
import { planUpdateRuntimeHandling } from "../../src/update/runtime-ownership.mjs";
import { UPDATE_PACKAGE_ONLY_PROTOCOL_VERSION } from "../../src/update/service-home-policy.mjs";

const source = readFileSync(repoPath("bin/ocx.mjs"), "utf8");
function extract(start: string, end: string, invoke: string) {
  const from = source.indexOf(start), to = source.indexOf(end, from);
  expect(from).toBeGreaterThan(0); expect(to).toBeGreaterThan(from);
  const code = source.slice(from, to).replaceAll("import.meta.url", JSON.stringify("file:///fixture/ocx.mjs"));
  return updateSourceFunction("deps", `with (deps) { ${code}; return ${invoke}; }`);
}

test("private Node interception precedes handoff/boot restore and uses only the dedicated no-env entry", () => {
  const at = source.indexOf('if (process.argv[2] === "__update-home-probe")');
  for (const boundary of ["const desktopPlan =", "const probe = bootRestoreProbe", "const bunRuntime = resolveBun"]) {
    expect(at).toBeLessThan(source.indexOf(boundary));
  }
  const run = extract("function readNodeUpdateHome(", "function shouldRepairCodexShim(", "readNodeUpdateHome('/fixture/bin/ocx.mjs')");
  let calls = 0;
  const deps = { supportsUpdateHomeProbe: () => true,
    resolveBun: (options: unknown) => { expect(options).toEqual({ allowInstall: false, launcherPath: "/fixture/bin/ocx.mjs", allowMissing: true }); return { path: "/fixture/bun" }; },
    updateHomeProbeEnvironment, process: { env: { CODEX_HOME: "/codex", CODEX_SQLITE_HOME: "/sqlite", OCX_SERVICE: "1" } },
    configDir: () => "/proxy", dirname: () => "/fixture/bin", join: (...parts: string[]) => parts.join("/"), spawnSync() {},
    probeUpdateServiceHome: (_run: unknown, binary: string, prefix: string[], options: { env: object }) => {
      calls++; expect(binary).toBe("/fixture/bun"); expect(prefix[0]).toBe("--no-env-file");
      expect(prefix[1]).toEndWith("src/update/service-home-probe-entry.ts");
      expect(options.env).toEqual({ CODEX_HOME: "/codex", OPENCODEX_HOME: "/proxy", CODEX_SQLITE_HOME: "/sqlite" });
      return { kind: "same" };
    },
  };
  expect(run(deps)).toEqual({ kind: "same" }); expect(calls).toBe(1);
  calls = 0;
  expect(run({ ...deps, supportsUpdateHomeProbe: () => false })).toEqual({ kind: "unknown" }); expect(calls).toBe(0);
  expect(run({ ...deps, resolveBun: () => null })).toEqual({ kind: "unknown" }); expect(calls).toBe(0);
  const entry = readFileSync(repoPath("src/update/service-home-probe-entry.ts"), "utf8");
  expect(entry).not.toContain('from "../cli'); expect(entry).not.toContain("launcherProtocolVersion");
  expect(entry).toContain("...inspectUpdateServiceHome()");
});

test("post-update probe resolves Bun and its compatibility floor from the actual new package", () => {
  const launcherPath = "/new/package/bin/ocx.mjs";
  const resolve = extract("function bunBinDir(", "const BUN_OVERRIDE_ENV", `bunBinDir(${JSON.stringify(launcherPath)})`);
  expect(resolve({ dirname,
    require: { resolve() { throw new Error("old package must not be used"); } },
    createRequire: (path: string) => { expect(path).toBe(launcherPath); return { resolve: () => "/new/package/node_modules/bun/package.json" }; },
  })).toBe(dirname("/new/package/node_modules/bun/package.json"));
  const floor = extract("function pinnedBunVersion(", "function updateTag(", `pinnedBunVersion(${JSON.stringify(launcherPath)})`);
  expect(floor({ dirname, join, here: "/old/package/bin",
    readFileSync: (path: string) => { expect(path).toBe(join(dirname(launcherPath), "..", "package.json")); return '{"dependencies":{"bun":"1.4.3"}}'; },
  })).toBe("1.4.3");
});

test("Node successful cold update stays stopped; a stopped foreground runtime recovers", () => {
  const start = source.indexOf("    } else if (postInstallPlan.mayStopRuntime)");
  const end = source.indexOf("    guardedExit(homePolicy.authorizeMutation, \"publish\", 0);", start);
  const run = updateSourceFunction("deps", `with (deps) { if (false) { ${source.slice(start, end)} }`);
  for (const stopAttempted of [false, true]) {
    let starts = 0;
    run({ stopAttempted, postInstallPlan: { mayStopRuntime: true }, homePolicy: { check: () => true },
      authorityLauncher: "old", postUpdateLauncher: "new", process: { exit() { throw new Error("unexpected exit"); } },
      console: { log() {} }, launcherStartHint: () => "manual start", bakePort: 12345,
      startProxyDirectly: () => { starts++; return true; }, releaseUpdateLease() {} });
    expect(starts).toBe(stopAttempted ? 1 : 0);
  }
});

test("Node foreground recovery releases exactly once before caller exit on veto or failure", () => {
  const start = source.indexOf("    } else if (postInstallPlan.mayStopRuntime)");
  const end = source.indexOf("    guardedExit(homePolicy.authorizeMutation, \"publish\", 0);", start);
  const run = updateSourceFunction("deps", `with (deps) { if (false) { ${source.slice(start, end)} process.exit(0); }`);
  for (const result of ["vetoed", "refused", false, true]) {
    const events: string[] = [];
    let releaseCountAtExit = -1;
    const terminal = new Error("fixture terminal");
    try {
      run({ stopAttempted: true, postInstallPlan: { mayStopRuntime: true }, homePolicy: { check: () => true },
        authorityLauncher: "old", postUpdateLauncher: "new",
        startProxyDirectly: () => { events.push("direct"); return result; },
        releaseUpdateLease: () => events.push("release"),
        process: { exit(code: number) {
          // Snapshot before throwing: a throw can run finally, a real exit cannot.
          releaseCountAtExit = events.filter(event => event === "release").length;
          events.push(`exit:${code}`); throw terminal;
        } },
      });
    } catch (error) { if (error !== terminal) throw error; }
    expect(releaseCountAtExit).toBe(1);
    expect(events).toEqual(["direct", "release", `exit:${result === true || result === "vetoed" ? 0 : 1}`]);
  }
});

test("probe-only missing Bun returns uncertainty without install or abrupt exit and permits cleanup", () => {
  const run = extract("function resolveBun(", "// `ocx update --help`", "resolveBun({ allowInstall: false, allowMissing: true })");
  const events: string[] = [];
  let result;
  const deps = { process: { env: {} }, BUN_OVERRIDE_ENV: "OPENCODEX_BUN_PATH", bunBinDir: () => "/stub",
    findBunBinary: () => null, join, existsSync: () => true,
    spawnSync: () => { events.push("install"); throw new Error("install forbidden"); },
    findPathBun: () => null, pinnedBunVersion: () => "1.4.3", PATH_BUN_PROBE_BUDGET_MS: 5000,
    fail: () => { events.push("exit"); throw new Error("abrupt caller exit"); },
  };
  try {
    result = run(deps);
    const policy = createUpdateServiceHomePolicy(() => ({ kind: "unknown" }), () => events.push("refused"));
    expect(policy.check()).toBe(false);
  } finally { events.push("cleanup"); }
  expect(result).toBeNull(); expect(events).toEqual(["refused", "cleanup"]);
  events.length = 0;
  const ordinary = extract("function resolveBun(", "// `ocx update --help`", "resolveBun({ allowInstall: false })");
  expect(() => ordinary(deps)).toThrow("abrupt caller exit");
  expect(events).toEqual(["exit"]);
});

const foreign = { kind: "foreign", subject: "a".repeat(64) } as const;
test("Node normal and failure recovery share a home-guarded direct helper with owned lease recheck", () => {
  const run = extract("  function startProxyDirectly()", "  // #7043:", "startProxyDirectly()");
  for (const initial of [foreign, { kind: "same" }, { kind: "absent" }] as const) {
    for (const changed of [undefined, { kind: "unknown" }, { kind: "foreign", subject: "b".repeat(64) }] as const) {
      let home: UpdateServiceHomeAuthority = initial;
      const events: string[] = [];
      const homePolicy = createUpdateServiceHomePolicy(() => home, () => {});
      const result = run({ homePolicy, reacquireUpdateLease() { events.push("lease"); if (changed) home = changed; },
        readOwnership: () => ({ ownership: null }), ownershipIdentity: () => "same", initialOwnership: {},
        planUpdateRuntimeHandling, observeSupervision: () => false,
        postUpdateLauncherUsable: true, postUpdateLauncher: "/fixture/launcher", existsSync: () => true,
        mutationChildEnvironment: () => ({ OCX_SERVICE: "1", OCX_SIBLING_OF_PORT: "12345" }),
        console: { log() {}, warn() {}, error() {} }, process: { execPath: "/fixture/node" }, bakePort: 12345, bakeHostname: "127.0.0.1",
        spawn: (_bin: string, _args: string[], options: { env: Record<string, string> }) => {
          events.push("spawn"); expect(options.env.OCX_SERVICE).toBeUndefined(); expect(options.env.OCX_SIBLING_OF_PORT).toBeUndefined();
          return { on() {}, unref() {} };
        },
        UPDATE_RECOVERY_READY_MS: 1000,
        readCurrentRuntimeTarget: () => ({ kind: "target", target: { port: 12345 } }), probeProxyLiveness: () => "live",
      });
      expect(events[0]).toBe("lease"); expect(result).toBe(changed ? "refused" : true);
      expect(events.includes("spawn")).toBe(!changed);
    }
  }
});

test("Node shared refresh skips every global service action for stable foreign/absence and refuses change", () => {
  const run = extract("  function refreshBackgroundServiceOrStartDirect()", "  let updateLease =", "refreshBackgroundServiceOrStartDirect()");
  for (const initial of [foreign, { kind: "absent" }] as const) {
    for (const changed of [false, true]) {
      let home: UpdateServiceHomeAuthority = initial;
      const events: string[] = [];
      const homePolicy = createUpdateServiceHomePolicy(() => home, () => {});
      if (changed) home = { kind: "unknown" };
      const result = run({ homePolicy, authorityLauncher: "old", postUpdateLauncher: "new",
        startProxyDirectly: () => { events.push("direct"); return true; },
        spawnSync: () => { throw new Error("global service action reached"); },
        restartThroughServiceManager: () => { throw new Error("manager reached"); },
      });
      expect(events).toEqual(changed ? [] : ["direct"]); expect(result).toBe(changed ? "refused" : undefined);
    }
  }
});

test("Node manager rechecks after release, and an ordinary same-home failure retains manager-first recovery", () => {
  const run = extract("  function restartThroughServiceManager()", "  /**", "restartThroughServiceManager()");
  for (const changed of [undefined, { kind: "unknown" }, foreign] as const) {
    let home: UpdateServiceHomeAuthority = { kind: "same" };
    const events: string[] = [];
    const result = run({ homePolicy: createUpdateServiceHomePolicy(() => home, () => {}),
      hasRestartableServiceManager: () => true,
      releaseUpdateLease() { events.push("release"); if (changed) home = changed; },
      readOwnership: () => ({ ownership: null }), ownershipIdentity: () => "same", initialOwnership: {},
      observeSupervision: () => false, planUpdateRuntimeHandling,
      console: { log() {}, warn() {} }, readCurrentRuntimeTarget: () => ({ kind: "absent" }),
      restartServiceManagerJob: () => { events.push("manager"); return { ok: false, reason: "ordinary failure" }; },
    });
    expect(events).toEqual(changed ? ["release"] : ["release", "manager"]);
    expect(result).toBe(changed ? "refused" : "failed");
  }
});

test("Node repair changing home authority refuses manager and direct fallback", () => {
  const run = extract("  function refreshBackgroundServiceOrStartDirect()", "  let updateLease =", "refreshBackgroundServiceOrStartDirect()");
  let home: UpdateServiceHomeAuthority = { kind: "same" };
  const events: string[] = [];
  const result = run({ homePolicy: createUpdateServiceHomePolicy(() => home, () => {}),
    authorityLauncher: "old", postUpdateLauncher: "new", observeSupervision: () => false,
    planUpdateRuntimeHandling, readOwnership: () => ({ ownership: null }),
    console: { log() {}, warn() {} }, process: { env: { OCX_BAKE_PORT: "prior" }, execPath: "fixture" }, bakePort: 12345,
    serviceRefreshArgs: () => ["repair"], mutationChildEnvironment: () => ({}),
    spawnSync: () => { events.push("repair"); home = foreign; return { status: 1 }; },
    restartThroughServiceManager: () => events.push("manager"), startProxyDirectly: () => events.push("direct"),
  });
  expect(result).toBe("refused"); expect(events).toEqual(["repair"]);
});

for (const changed of [false, true]) test(`Node absent-service install checks home after backend read (${changed})`, () => {
  const start = source.indexOf("  function serviceInstallArgs()"), end = source.indexOf("  /**", start);
  expect(start).toBeGreaterThan(0); expect(end).toBeGreaterThan(start);
  const refreshStart = source.indexOf("  function refreshBackgroundServiceOrStartDirect()");
  const refreshEnd = source.indexOf("  let updateLease =", refreshStart);
  expect(refreshStart).toBeGreaterThan(0); expect(refreshEnd).toBeGreaterThan(refreshStart);
  const run = updateSourceFunction("deps", `with (deps) { ${source.slice(start, end)}\n${source.slice(refreshStart, refreshEnd)}; return refreshBackgroundServiceOrStartDirect(); }`);
  let home: UpdateServiceHomeAuthority = { kind: "same" };
  const events: string[] = [];
  const result = run({ homePolicy: createUpdateServiceHomePolicy(() => home, () => {}),
    authorityLauncher: "old", postUpdateLauncher: "new", observeSupervision: () => false,
    planUpdateRuntimeHandling, readOwnership: () => ({ ownership: null }),
    console: { log() {}, warn() {} }, process: { env: {}, execPath: "fixture" }, bakePort: 12345,
    serviceRefreshArgs: () => ["repair"], mutationChildEnvironment: () => ({}),
    readServiceInstalledFromStatus: () => false,
    readServiceState: () => { events.push("backend"); if (changed) home = { kind: "unknown" }; return { kind: "state", state: { backend: "native" } }; },
    spawnSync: (_bin: string, args: string[]) => { events.push(args.includes("install") ? `install:${home.kind}` : "repair"); return { status: 1 }; },
    restartThroughServiceManager: () => { events.push("manager"); return "supervised"; },
    startProxyDirectly: () => { throw new Error("unexpected direct fallback"); },
  });
  expect(result).toBe(changed ? "refused" : undefined);
  expect(events).toEqual(changed ? ["repair", "backend"] : ["repair", "backend", "install:same", "manager"]);
});

test("the installed test Bun honors --no-env-file while the control loads the fixture dotenv", () => {
  const box = createTempHome("ocx-update-home-dotenv-");
  try {
    writeFileSync(box.path(".env"), "OCX_UPDATE_PROBE_DOTENV=from-fixture\n");
    writeFileSync(box.path("probe.js"), 'console.log(process.env.OCX_UPDATE_PROBE_DOTENV ?? "absent");');
    const env = { ...process.env, HOME: box.root };
    delete env.OCX_UPDATE_PROBE_DOTENV;
    for (const disabled of [false, true]) {
      const result = Bun.spawnSync([process.execPath, ...(disabled ? ["--no-env-file"] : []), box.path("probe.js")],
        { cwd: box.root, env, stdout: "pipe", stderr: "pipe", timeout: 8000 });
      expect(result.exitCode).toBe(0);
      expect(result.stdout.toString().trim()).toBe(disabled ? "absent" : "from-fixture");
    }
  } finally { box.remove(); }
});

for (const delegated of [false, true]) test(`Node package-only success reports a ${delegated ? "restricted worker" : "CLI"} result before recovery`, () => {
  const start = source.indexOf("    if (homePolicy.packageOnly) {", source.indexOf("  const postInstallPlan"));
  const end = source.indexOf('    if (!homePolicy.authorizeMutation("publish")) {', start);
  expect(start).toBeGreaterThan(0); expect(end).toBeGreaterThan(start);
  const run = updateSourceFunction("deps", `with (deps) { ${source.slice(start, end)} }`);
  const events: string[] = [];
  const terminal = new Error("exit");
  const homePolicy = createUpdateServiceHomePolicy(() => ({ kind: "unknown" }), text => events.push(text));
  expect(() => run({ homePolicy, latest: "2", postUpdateLauncher: "new", bakePort: 42,
    launcherStartHint: () => "manual start", console: { log: (text: string) => events.push(text) },
    UPDATE_PACKAGE_ONLY_EXIT_CODE: 75,
    process: { argv: delegated ? ["--update-worker-result"] : [], exit(code: number) { expect(code).toBe(delegated ? 75 : 0); throw terminal; } },
  })).toThrow("exit");
  expect(events).toHaveLength(3);
  expect(events[0]).toContain("Updated"); expect(events[1]).toContain("ownership could not be verified");
  expect(events[2]).toContain("Restart the proxy:");
});

test("Node package-only refuses an unresolved teardown before package replacement and releases its lease", () => {
  const start = source.indexOf("    if (homePolicy.packageOnly && hasPendingTeardown) {");
  const end = source.indexOf("    const stopNeeded =", start);
  expect(start).toBeGreaterThan(0); expect(end).toBeGreaterThan(start);
  const run = updateSourceFunction("deps", `with (deps) { ${source.slice(start, end)} }`);
  const events: string[] = [];
  const terminal = new Error("exit");
  expect(() => run({ homePolicy: { packageOnly: true }, hasPendingTeardown: true,
    releaseUpdateLease: () => events.push("release"), console: { error: (text: string) => events.push(text) },
    process: { exit(code: number) { expect(code).toBe(1); events.push("exit"); throw terminal; } },
  })).toThrow("exit");
  expect(events[0]).toBe("release"); expect(events[1]).toContain("pending teardown"); expect(events[2]).toBe("exit");
});

test("the new package remains inspectable by an already-running v1 updater", () => {
  const declaration = JSON.parse(readFileSync(repoPath("src/update/service-home-protocol.json"), "utf8"));
  // This is the frozen predicate in the old Node process, which package replacement cannot update.
  const legacyAccepts = (value: typeof declaration) => value?.schemaVersion === 1 && value?.launcherProtocolVersion === 1
    && value?.entry === "__update-home-probe" && Object.keys(value).length === 3;
  expect(legacyAccepts(declaration)).toBe(true);
  const start = source.indexOf('if (process.argv[2] === "__update-home-probe")');
  const end = source.indexOf("const desktopPlan =", start);
  const run = updateSourceFunction("deps", `with (deps) { ${source.slice(start, end).replace("import.meta.url", "\"fixture\"")} }`);
  let response = "";
  const terminal = new Error("exit");
  expect(() => run({ process: { argv: ["node", "ocx", "__update-home-probe"], exit(code: number) { expect(code).toBe(0); throw terminal; } },
    isUpdateHomeProbe: () => true, readNodeUpdateHome: () => ({ kind: "same" }), fileURLToPath: () => "launcher",
    UPDATE_HOME_LAUNCHER_PROTOCOL: declaration.launcherProtocolVersion, console: { log: (text: string) => { response = text; } },
  })).toThrow("exit");
  expect(JSON.parse(response)).toEqual({ schemaVersion: 1, launcherProtocolVersion: 1, kind: "same" });
});

test("package-only capability interception is exact and precedes install-capable bootstrap", () => {
  const start = source.indexOf('if (process.argv[2] === "__update-package-only-probe")');
  const end = source.indexOf('if (process.argv[2] === "__update-home-probe")', start);
  expect(start).toBeGreaterThan(0); expect(end).toBeGreaterThan(start);
  const run = updateSourceFunction("deps", `with (deps) { ${source.slice(start, end)} }`);
  for (const extra of [false, true]) {
    const events: unknown[] = [];
    const terminal = new Error("exit");
    expect(() => run({ process: { argv: ["node", "ocx", "__update-package-only-probe", ...(extra ? ["extra"] : [])],
      exit(code: number) { events.push(code); throw terminal; } }, console: { log: (text: string) => events.push(JSON.parse(text)) },
      UPDATE_PACKAGE_ONLY_PROTOCOL_VERSION,
    })).toThrow("exit");
    expect(events).toEqual(extra ? [2] : [{ schemaVersion: 1, packageOnlyProtocolVersion: 2 }, 0]);
  }
});

for (const [parent, observed, exit] of [
  ["same", "unknown", 1], ["absent", "unknown", 1], ["foreign", "unknown", 1],
  ["unknown", "same", 1], ["unknown", "unknown", 75],
] as const) test(`the real Node child preserves ${parent} parent authority when observing ${observed}`, () => {
  const box = createTempHome("ocx-node-home-child-");
  try {
    const command = { bin: "node", args: [repoPath("bin/ocx.mjs"), "update"], display: "" };
    expect(prepareWorkerUpdateHome(command, "npm", command.args[0]!, "node", "latest", () => {},
      () => ({ kind: parent, ...(parent === "foreign" ? { subject: "a".repeat(64) } : {}) }), () => true)).not.toBeNull();
    const child = Bun.spawnSync(["node", helperPath("update-node-home-child.mjs"), box.root, observed, ...command.args.slice(2)],
      { env: { ...process.env }, stdout: "pipe", stderr: "pipe", timeout: 10_000 });
    const log = child.stdout.toString() + child.stderr.toString();
    expect(child.exitCode, log).toBe(exit);
    const receipt = child.stdout.toString().split("\n").find(line => line.startsWith("NODE_HOME_PROBE:"));
    expect(receipt, log).toBeDefined();
    const trace = JSON.parse(receipt!.slice("NODE_HOME_PROBE:".length)) as string[];
    expect(trace.filter(phase => phase === "replacement")).toHaveLength(exit === 75 ? 1 : 0);
    expect(trace[0]).toBe("home");
    if (exit === 75) { expect(trace).toContain("release"); expect(log).toContain("Restart the proxy:"); }
  } finally { box.remove(); }
});

for (const baseline of [["--update-worker-home"], ["--update-worker-home=same"],
  ["--update-worker-home", "same", "--update-worker-home", "unknown"]]) test(`the real Node child refuses malformed baseline ${baseline.join(" ")}`, () => {
  const box = createTempHome("ocx-node-home-invalid-");
  try {
    const child = Bun.spawnSync(["node", helperPath("update-node-home-child.mjs"), box.root, "unknown", ...baseline],
      { env: { ...process.env }, stdout: "pipe", stderr: "pipe", timeout: 10_000 });
    const log = child.stdout.toString() + child.stderr.toString();
    expect(child.exitCode, log).toBe(1);
    expect(log).toContain('NODE_HOME_PROBE:["home"]');
    expect(log).toContain("Automatic update restart refused");
  } finally { box.remove(); }
});

for (const scenario of ["post-refusal-running", "post-refusal-stopped", "post-refusal-unverified"]) test(`the real Node updater restores only an own stopped tray on ${scenario}`, () => {
  const box = createTempHome("ocx-node-home-tray-refusal-");
  try {
    const child = Bun.spawnSync(["node", helperPath("update-node-home-child.mjs"), box.root, scenario,
      "--update-worker-home", "absent", "--update-worker-result"],
      { env: { ...process.env }, stdout: "pipe", stderr: "pipe", timeout: 10_000 });
    const log = child.stdout.toString() + child.stderr.toString();
    expect(child.exitCode, log).toBe(1);
    const receipt = child.stdout.toString().split("\n").find(line => line.startsWith("NODE_HOME_PROBE:"));
    expect(receipt, log).toBeDefined();
    const trace = JSON.parse(receipt!.slice("NODE_HOME_PROBE:".length)) as string[];
    expect(trace.filter(event => event === "replacement")).toEqual(["replacement"]);
    expect(trace.filter(event => event.startsWith("tray:"))).toEqual(scenario === "post-refusal-running"
      ? ["tray:stop", "tray:start"] : scenario === "post-refusal-stopped" ? [] : ["tray:stop"]);
    expect(log).toContain("Automatic update restart refused");
  } finally { box.remove(); }
});
