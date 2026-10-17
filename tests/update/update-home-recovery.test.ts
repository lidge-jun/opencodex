import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { repoPath } from "../helpers/repo-root";
import { createUpdateServiceHomePolicy, type UpdateServiceHomeAuthority } from "../../src/update/service-home-policy.mjs";
import { planUpdateRuntimeHandling } from "../../src/update/runtime-ownership.mjs";

const source = readFileSync(repoPath("src/update/index.ts"), "utf8");
function extracted(start: string, end: string, result: string) {
  const from = source.indexOf(start), to = source.indexOf(end, from);
  expect(from).toBeGreaterThan(0); expect(to).toBeGreaterThan(from);
  const code = new Bun.Transpiler({ loader: "ts" }).transformSync(`async function run() {
    ${source.slice(from, to)}
    return ${result};
  }`);
  return new Function("deps", `with (deps) { ${code}; return run(); }`);
}
const direct = extracted("  const startProxyDirectly = async", "  // #7043:", "await startProxyDirectly()");
const manager = extracted("  const restartThroughServiceManager = async", "  /** Direct start as", "await restartThroughServiceManager()");
const foreign = { kind: "foreign", subject: "a".repeat(64) } as const;

test("Bun successful cold update stays stopped; a stopped foreground runtime recovers", async () => {
  const start = source.indexOf("    if (!homePolicy.serviceAllowed && postInstallPlan.mayStopRuntime)");
  const end = source.indexOf("    if (postInstallPlan.mayRestoreService)", start);
  const code = new Bun.Transpiler({ loader: "ts" }).transformSync(`async function run() { ${source.slice(start, end)} }`);
  const run = new Function("deps", `with (deps) { ${code}; return run(); }`);
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
    const homePolicy = createUpdateServiceHomePolicy(() => { events.push("home"); return home; }, () => {});
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
    expect(await run({ kind: "unknown" })).toBe("vetoed");
    expect(events).not.toContain("spawn"); expect(events).not.toContain("owner");
    home = initial; events.length = 0;
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
