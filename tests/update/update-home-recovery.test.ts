import { updateSourceFunction } from "../helpers/update-source-body";
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { repoPath } from "../helpers/repo-root";
import { createUpdateServiceHomePolicy, type UpdateServiceHomeAuthority } from "../../src/update/service-home-policy.mjs";
import { planUpdateRuntimeHandling } from "../../src/update/runtime-ownership.mjs";

const source = readFileSync(repoPath("src/update/index.ts"), "utf8");
function extracted(start: string, end: string, result: string, afterStart = false) {
  const marker = source.indexOf(start);
  expect(marker).toBeGreaterThan(0);
  const from = marker + (afterStart ? start.length : 0), to = source.indexOf(end, from);
  expect(to).toBeGreaterThan(from);
  const code = new Bun.Transpiler({ loader: "ts" }).transformSync(`async function run() {
    ${source.slice(from, to)}
    return ${result};
  }`);
  return updateSourceFunction("deps", `with (deps) { ${code}; return run(); }`);
}
const direct = extracted("  const startProxyDirectly = async", "  // #7043:", "await startProxyDirectly()");
const manager = extracted("  const restartThroughServiceManager = async", "  /** Direct start as", "await restartThroughServiceManager()");
const foreign = { kind: "foreign", subject: "a".repeat(64) } as const;

for (const changed of [false, true]) test(`Bun direct recovery checks home after runtime provenance I/O (${changed})`, async () => {
  let home: UpdateServiceHomeAuthority = { kind: "same" };
  const events: string[] = [];
  const result = await direct({
    homePolicy: createUpdateServiceHomePolicy(() => home, () => {}),
    mutation: { reacquire() {}, controlEnvironment: () => ({}) },
    resolvedRuntimeOwnership: async () => ({ ownership: null }), sameOwner: () => true,
    observeSupervision: () => false, planUpdateRuntimeHandling,
    postUpdateLauncherUsable: true, postUpdateLauncher: "/fixture/launcher", existsSync: () => true,
    withoutSiblingMarker: () => ({}), process: { env: {}, execPath: "/fixture/bun" },
    capturedListen: { port: 12345, hostname: "127.0.0.1" },
    withProcessRuntimeProvenance: (env: object) => { events.push("provenance"); if (changed) home = { kind: "unknown" }; return env; },
    spawn: () => { events.push(`spawn:${home.kind}`); return { once() {}, unref() {} }; },
    readUpdateRuntimeTarget: () => ({ kind: "target", target: { pid: 91, port: 12345, hostname: "127.0.0.1" } }),
    getRuntimePortPath: () => "/fixture/runtime", proxyIdentityAt: async () => true, console: { warn() {} },
  });
  expect(result).toBe(changed ? "refused" : true);
  expect(events).toEqual(changed ? ["provenance"] : ["provenance", "spawn:same"]);
});

test("Bun successful cold update stays stopped; a stopped foreground runtime recovers", async () => {
  const start = source.indexOf("    if (!homePolicy.serviceAllowed && postInstallPlan.mayStopRuntime)");
  const end = source.indexOf("    if (postInstallPlan.mayRestoreService)", start);
  const code = new Bun.Transpiler({ loader: "ts" }).transformSync(`async function run() { ${source.slice(start, end)} }`);
  const run = updateSourceFunction("deps", `with (deps) { ${code}; return run(); }`);
  for (const stopAttempted of [false, true]) {
    let starts = 0;
    await run({ stopAttempted, homePolicy: { serviceAllowed: false }, postInstallPlan: { mayStopRuntime: true },
      console: { log() {} }, launcherStartHint: () => "manual start", postUpdateLauncher: "fixture", capturedListen: { port: 12345 },
      startProxyDirectly: async () => { starts++; return true; } });
    expect(starts).toBe(stopAttempted ? 1 : 0);
  }
});

test("Bun direct recovery reacquires its own lease and checks homes again before spawning", async () => {
  for (const initial of [foreign, { kind: "absent" }, { kind: "same" }] as const) {
    const events: string[] = [];
    let home: UpdateServiceHomeAuthority = initial;
    let homePolicy = createUpdateServiceHomePolicy(() => { events.push("home"); return home; }, () => {});
    events.length = 0;
    const run = (changed?: UpdateServiceHomeAuthority, ownerSame = true) => direct({
      homePolicy, mutation: { reacquire() { events.push("lease"); if (changed) home = changed; }, controlEnvironment: () => ({}) },
      resolvedRuntimeOwnership: async () => { events.push("owner"); return { ownership: null }; },
      sameOwner: () => ownerSame, observeSupervision: () => false, planUpdateRuntimeHandling,
      postUpdateLauncherUsable: true, postUpdateLauncher: "/fixture/launcher", existsSync: () => true,
      withoutSiblingMarker: () => ({}), process: { env: {}, execPath: "/fixture/bun" },
      capturedListen: { port: 12345, hostname: "127.0.0.1" }, withProcessRuntimeProvenance: (env: object) => env,
      spawn: () => { events.push("spawn"); return { once() {}, unref() {} }; },
      readUpdateRuntimeTarget: () => ({ kind: "target", target: { pid: 91, port: 12345, hostname: "127.0.0.1" } }),
      getRuntimePortPath: () => "/fixture/runtime", proxyIdentityAt: async () => true, console: { warn() {} },
    });
    expect(await run()).toBe(true);
    expect(events[0]).toBe("lease"); expect(events.indexOf("home")).toBeLessThan(events.indexOf("spawn"));
    events.length = 0;
    expect(await run({ kind: "unknown" })).toBe("refused");
    expect(events).not.toContain("spawn"); expect(events).not.toContain("owner");
    home = initial; events.length = 0;
    homePolicy = createUpdateServiceHomePolicy(() => { events.push("home"); return home; }, () => {});
    expect(await run(undefined, false)).toBe("vetoed"); expect(events).not.toContain("spawn");
  }
});

test("Bun manager boundary releases first, refuses changed homes, and skips stable foreign jobs", async () => {
  for (const initial of [{ kind: "same" }, foreign, { kind: "absent" }] as const) {
    for (const changed of [undefined, { kind: "unknown" }, { kind: "foreign", subject: "b".repeat(64) }] as const) {
      let home: UpdateServiceHomeAuthority = initial;
      const events: string[] = [];
      const homePolicy = createUpdateServiceHomePolicy(() => home, () => events.push("refuse"));
      const result = await manager({ homePolicy, hasRestartableServiceManager: () => true,
        resolvedRuntimeOwnership: async () => ({ ownership: null }), sameOwner: () => true,
        planUpdateRuntimeHandling, observeSupervision: () => false,
        mutation: { release() { events.push("release"); if (changed) home = changed; } },
        console: { log() {}, warn() {} },
        readUpdateRuntimeTarget: () => ({ kind: "absent" }), getRuntimePortPath: () => "fixture",
        capturedListen: { port: 12345 },
        restartServiceManagerJob: () => { events.push("manager"); return { ok: false, reason: "ordinary failure" }; },
      });
      expect(events[0]).toBe("release");
      expect(events.filter(event => event === "manager").length).toBe(!changed && initial.kind === "same" ? 1 : 0);
      expect(result).toBe(changed ? "refused" : "failed");
    }
  }
});

const postReplacementRefusal = extracted("    // Authority gates every post-replacement control action", "    if (!postInstallPlan.mayStopRuntime)", '"continued"');
for (const running of [false, true]) for (const verified of [false, true]) test(`Bun home refusal restores only a running own tray through a verified launcher (${running}/${verified})`, async () => {
  const commands: string[][] = [];
  const result = await postReplacementRefusal({
    homePolicy: { check: () => false }, trayWasRunning: running, postUpdateLauncherUsable: verified,
    postUpdateLauncher: "/verified/launcher", existsSync: () => true, process: { execPath: "/fixture/bun" },
    mutation: { unprivilegedEnvironment: () => ({ fixture: "unprivileged" }) },
    spawnSync: (_bin: string, args: string[], options: { timeout: number; env: object }) => {
      commands.push(args); expect(options.timeout).toBe(15_000); expect(options.env).toEqual({ fixture: "unprivileged" });
      return { status: 0 };
    },
  });
  expect(result).toBe(1);
  expect(commands).toEqual(running && verified ? [["/verified/launcher", "tray", "start"]] : []);
});

test("Bun home refusal preserves the refusal if the verified tray restore throws or its launcher is absent", async () => {
  for (const present of [false, true]) {
    let starts = 0;
    expect(await postReplacementRefusal({ homePolicy: { check: () => false }, trayWasRunning: true,
      postUpdateLauncherUsable: true, postUpdateLauncher: "/verified/launcher", existsSync: () => present,
      process: { execPath: "/fixture/bun" }, mutation: { unprivilegedEnvironment: () => ({}) },
      spawnSync: () => { starts++; throw new Error("fixture tray failure"); },
    })).toBe(1);
    expect(starts).toBe(present ? 1 : 0);
  }
});

const postShimImport = extracted("    // Re-enter through the verified active package launcher.", "    // The stop above unloaded any managed service", '"continued"');
const shimGateDeps = (check: () => boolean, events: { checks: number; restored: number; commands: string[][] }) => ({
  homePolicy: { check: () => { events.checks++; return check(); } },
  restoreOwnStoppedTray: () => { events.restored++; },
  trayWasInstalled: true, trayWasRunning: true, postUpdateLauncher: "/verified/launcher",
  existsSync: () => true, process: { execPath: "/fixture/bun" },
  mutation: { unprivilegedEnvironment: () => ({ fixture: "unprivileged" }) },
  planWindowsTrayUpdate: () => ({ installArgs: ["tray", "install"] }),
  spawnSync: (_bin: string, args: string[]) => { events.commands.push(args); return { status: 0 }; },
  console: { warn() {}, log() {} },
});

test("a home change during the shim import vetoes the shim rewrite and the tray refresh", async () => {
  const events = { checks: 0, restored: 0, commands: [] as string[][] };
  expect(await postShimImport(shimGateDeps(() => false, events))).toBe(1);
  // Authority was re-read after the import await: the refusal restores only the own tray
  // and no control command (shim rewrite, tray refresh) may run.
  expect(events.checks).toBe(1);
  expect(events.restored).toBe(1);
  expect(events.commands).toEqual([]);
});

test("a stable home still runs the shim gate and the tray refresh in order", async () => {
  const events = { checks: 0, restored: 0, commands: [] as string[][] };
  expect(await postShimImport(shimGateDeps(() => true, events))).toBe("continued");
  expect(events.checks).toBe(4);
  expect(events.restored).toBe(0);
  // The shim spawn is conditional on a real installation; the tray refresh is the always-on
  // control action and must be the last command the gate released.
  expect(events.commands[events.commands.length - 1]).toEqual(["/verified/launcher", "tray", "install"]);
});

// Extracted after the shim-module import so the probe itself is injectable: filesystem
// failures inside it must degrade inside the guarded block, not escape the update.
const postShimGate = extracted("    // The module load above is the last await", "    // The stop above unloaded any managed service", '"continued"');
const shimProbeDeps = (probe: () => boolean, events: { checks: number; restored: number; commands: string[][]; warnings: number }) => ({
  homePolicy: { check: () => { events.checks++; return true; } },
  restoreOwnStoppedTray: () => { events.restored++; },
  isCodexShimInstalled: probe,
  trayWasInstalled: true, trayWasRunning: true, postUpdateLauncher: "/verified/launcher",
  process: { execPath: "/fixture/bun" },
  mutation: { unprivilegedEnvironment: () => ({ fixture: "unprivileged" }) },
  planWindowsTrayUpdate: () => ({ installArgs: ["tray", "install"] }),
  spawnSync: (_bin: string, args: string[]) => { events.commands.push(args); return { status: 0 }; },
  console: { warn: () => { events.warnings++; }, log() {} },
});

test("a throwing shim probe degrades to a warning and authorized recovery continues", async () => {
  const events = { checks: 0, restored: 0, commands: [] as string[][], warnings: 0 };
  const result = await postShimGate(shimProbeDeps(() => { throw new Error("fixture probe failure"); }, events));
  expect(result).toBe("continued");
  expect(events.checks).toBe(4);
  expect(events.restored).toBe(0);
  expect(events.warnings).toBeGreaterThanOrEqual(1);
  // No shim rewrite ran; the authorized tray refresh still runs afterwards.
  expect(events.commands).toEqual([["/verified/launcher", "tray", "install"]]);
});

test("an installed shim is repaired inside the same guarded block before the tray refresh", async () => {
  const events = { checks: 0, restored: 0, commands: [] as string[][], warnings: 0 };
  const result = await postShimGate(shimProbeDeps(() => true, events));
  expect(result).toBe("continued");
  expect(events.warnings).toBe(0);
  expect(events.commands).toEqual([
    ["/verified/launcher", "codex-shim", "install"],
    ["/verified/launcher", "tray", "install"],
  ]);
});

// The CLI's reclaim wait gets its own latched gate: a mid-wait denial must stay
// recorded even if the registration re-matches before the wait returns false.
const reclaimLatchSlice = extracted(
  '      const { guardedReclaimListenPort: reclaimListenPort } = await import("./guarded-port-reclaim");',
  "      // \x60service repair\x60 re-activates",
  '"continued"',
  true,
);

test("a latched reclaim denial outranks a transient re-match before the wait ends", async () => {
  const warnings: string[] = [];
  let home: "same" | "foreign" = "same";
  let deniedInWait = false;
  const result = await reclaimLatchSlice({
    capturedListen: { port: 12345, hostname: "127.0.0.1", oldPid: 4242 },
    homePolicy: { check: () => home === "same" },
    reclaimListenPort: async (_port: number, _host: string, opts: { mayMutateFn?: () => boolean }) => {
      home = "foreign";
      deniedInWait = opts?.mayMutateFn?.() === false;
      home = "same"; // a transient re-match must not reopen the recorded denial
      return false;
    },
    console: { warn: (line: string) => warnings.push(line) },
  });
  expect(result).toBe(1);
  expect(deniedInWait).toBe(true);
  expect(warnings.some(line => line.includes("still busy"))).toBe(false);
});

test("an ordinary reclaim timeout under stable authority still warns and continues", async () => {
  const warnings: string[] = [];
  const result = await reclaimLatchSlice({
    capturedListen: { port: 12345, hostname: "127.0.0.1", oldPid: null },
    homePolicy: { check: () => true },
    reclaimListenPort: async () => false,
    console: { warn: (line: string) => warnings.push(line) },
  });
  expect(result).toBe("continued");
  expect(warnings.some(line => line.includes("still busy"))).toBe(true);
});

test("a throwing reclaim authority gate stays denied after the probe recovers", async () => {
  const warnings: string[] = [];
  let throwProbe = false, deniedInWait = false;
  const result = await reclaimLatchSlice({
    capturedListen: { port: 12345, hostname: "127.0.0.1", oldPid: 4242 },
    homePolicy: { check: () => { if (throwProbe) throw new Error("fixture authority unavailable"); return true; } },
    reclaimListenPort: async (_port: number, _host: string, opts: { mayMutateFn?: () => boolean }) => {
      throwProbe = true;
      try { deniedInWait = opts?.mayMutateFn?.() === false; }
      catch { deniedInWait = false; }
      throwProbe = false;
      return false;
    },
    console: { warn: (line: string) => warnings.push(line) },
  });
  expect(result).toBe(1);
  expect(deniedInWait).toBe(true);
  expect(warnings.some(line => line.includes("still busy"))).toBe(false);
});
