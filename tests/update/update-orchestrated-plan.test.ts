import { expect, test } from "bun:test";
import { buildOrchestratedPlan, type PlanInputs } from "../../src/update/orchestrated-plan";
import { classifyPlanRuntimeOwner, decideOrchestratedApply, observeOrchestratedPlan, type OrchestratedPlanDeps } from "../../src/update/orchestrated-entry";
import { applyOrchestratedBun } from "../../src/update/orchestrated-entry";
import { EventEmitter } from "node:events";
import { mkdtempSync, mkdirSync, writeFileSync, openSync, closeSync, truncateSync, rmSync, cpSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createOrchestratedChildSession, decodeOrchestratedExpect } from "../../src/update/orchestrated-session.mjs";
import { isUpdateInFlight } from "../../src/update/sync-update-mutex";

test("Bun apply runs a pinned child and verifies the installed tree", async () => {
  const home = mkdtempSync(join(tmpdir(), "ocx-bun-apply-"));
  const root = join(home, "bun", "install", "global", "node_modules", "@bitkyc08", "opencodex");
  try {
    for (const dir of ["bin", "src/cli", "node_modules/bun/bin", "node_modules/zod"]) mkdirSync(join(root, dir), { recursive: true });
    writeFileSync(join(root, "package.json"), JSON.stringify({ version: "2.1.0", dependencies: { bun: "1", zod: "1" } }));
    writeFileSync(join(root, "bin/ocx.mjs"), "x".repeat(1024));
    writeFileSync(join(root, "src/cli/index.ts"), "export {};\n");
    writeFileSync(join(root, "node_modules/bun/package.json"), "{}");
    writeFileSync(join(root, "node_modules/zod/package.json"), "{}");
    const bun = join(root, "node_modules/bun/bin/bun"); closeSync(openSync(bun, "w")); truncateSync(bun, 10 * 1024 * 1024);
    const plan = buildOrchestratedPlan({ ...base, installer: "bun", cliRoot: root });
    const child = new EventEmitter();
    Object.assign(child, { kill: () => true, unref: () => {} });
    const spawn = (_exe: string, args: string[], options: { env: Record<string, string> }) => {
      expect(args.slice(args.indexOf("update") + 1, args.indexOf("update") + 3)).toEqual(["--version", "2.1.0"]);
      expect(options.env.OCX_UPDATE_ORCHESTRATED_CHILD).toBe("1");
      writeFileSync(args[args.indexOf("--orchestrated-result") + 1]!, JSON.stringify({ phase: "installed", activeRoot: root }));
      queueMicrotask(() => child.emit("close", 0, null));
      return child;
    };
    const result = await applyOrchestratedBun(plan, { ok: true, mode: "apply" }, { home, identity: async () => ({ kind: "absent" }), spawn, now: () => 100 });
    expect(result).toMatchObject({ exitCode: 0, result: { applied: true, healthy: true } });
    const manifest = join(root, "package.json");
    const setVersion = (version: string) => writeFileSync(manifest, JSON.stringify({ version, dependencies: { bun: "1", zod: "1" } }));
    setVersion("2.0.0");
    const run = async (outcome: string | null, code: number) => {
      const fake = new EventEmitter(); Object.assign(fake, { kill: () => true, unref: () => {} });
      return applyOrchestratedBun(plan, { ok: true, mode: "apply" }, { home, identity: async () => ({ kind: "absent" }), now: () => 100,
        spawn: (_exe, args) => {
          if (outcome !== null) writeFileSync(args[args.indexOf("--orchestrated-result") + 1]!, outcome);
          queueMicrotask(() => fake.emit("close", code, null)); return fake as never;
        } });
    };
    expect(await run(JSON.stringify({ phase: "refused", error: "plan-changed" }), 10)).toMatchObject({ exitCode: 10, result: { error: "plan-changed" } });
    expect(await run(JSON.stringify({ phase: "preflight" }), 1)).toMatchObject({ exitCode: 11, result: { applied: false } });
    expect(await run(JSON.stringify({ phase: "failed", error: "install-failed" }), 1)).toMatchObject({ exitCode: 11 });
    const other = join(home, "other"); cpSync(root, other, { recursive: true });
    writeFileSync(join(other, "package.json"), JSON.stringify({ version: "2.1.0", dependencies: { bun: "1", zod: "1" } }));
    expect(await run(JSON.stringify({ phase: "installed", activeRoot: other }), 0)).toMatchObject({ exitCode: 12 });
    expect(await run(null, 1)).toMatchObject({ exitCode: 12 });
    expect(await run("{", 1)).toMatchObject({ exitCode: 12 });
    truncateSync(bun, 1);
    expect(await run(JSON.stringify({ phase: "failed" }), 1)).toMatchObject({ exitCode: 12 });

    let killed = false, session: ReturnType<typeof createOrchestratedChildSession> | undefined, resultDir = "";
    const running = new EventEmitter(); Object.assign(running, { kill: () => { killed = true; return true; }, unref: () => {} });
    const overrun = await applyOrchestratedBun(plan, { ok: true, mode: "apply", notAfter: 1 }, { home, identity: async () => ({ kind: "absent" }), now: () => 900_002,
      spawn: (_exe, args, options) => {
        resultDir = dirname(args[args.indexOf("--orchestrated-result") + 1]!);
        session = createOrchestratedChildSession({ home, resultPath: args[args.indexOf("--orchestrated-result") + 1]!, resultCapability: options.env.OCX_UPDATE_RESULT_CAPABILITY!,
          expect: decodeOrchestratedExpect(args[args.indexOf("--orchestrated-expect") + 1]!), verifyIdentity: () => true });
        session.start(); return running as never;
      } });
    expect(overrun).toMatchObject({ exitCode: 12, result: { error: "overrun" } });
    expect(killed).toBe(false); expect(isUpdateInFlight(home)).toBe(true);
    session!.finishPreflight(); running.emit("close", 1, null);
    rmSync(resultDir, { recursive: true, force: true });
  } finally { rmSync(home, { recursive: true, force: true }); }
});

const base: PlanInputs = {
  currentVersion: "2.0.0", targetVersion: "2.1.0", installer: "npm", runtimeOwner: "none",
  cliRoot: "/fixture/ocx", identity: { kind: "absent" }, ownershipPermits: true, updateInFlight: false,
};

test.each(["bun", "npm"] as const)("%s driver retains verified install when its post-install identity probe throws", async installer => {
  const home = realpathSync.native(mkdtempSync(join(tmpdir(), "ocx-probe-throw-"))), root = join(home, "package");
  try {
    for (const dir of ["bin", "src/cli", "node_modules/bun/bin", "node_modules/zod"]) mkdirSync(join(root, dir), { recursive: true });
    writeFileSync(join(root, "package.json"), JSON.stringify({ version: "2.1.0", dependencies: { bun: "1", zod: "1" } }));
    writeFileSync(join(root, "bin/ocx.mjs"), "x".repeat(1024)); writeFileSync(join(root, "src/cli/index.ts"), "export {};\n");
    for (const dep of ["bun", "zod"]) writeFileSync(join(root, `node_modules/${dep}/package.json`), "{}");
    const bun = join(root, "node_modules/bun/bin/bun"); closeSync(openSync(bun, "w")); truncateSync(bun, 10 * 1024 * 1024);
    const identity = { kind: "live" as const, servingRoot: root, runtime: { pid: 123, port: 1234, hostname: "127.0.0.1", command: ["/bun", "/fixture"] } };
    const plan = buildOrchestratedPlan({ ...base, installer, cliRoot: root, identity, runtimeOwner: "unmanaged" });
    let calls = 0;
    const probe = () => { if (++calls > 1) throw new Error("identity unavailable"); return identity; };
    const spawn = (_exe: string, args: string[]) => {
      const child = new EventEmitter(); Object.assign(child, { kill: () => true, unref: () => {} });
      writeFileSync(args[args.indexOf("--orchestrated-result") + 1]!, JSON.stringify({ phase: "installed", activeRoot: root }));
      queueMicrotask(() => child.emit("close", 0, null)); return child as never;
    };
    const result = installer === "bun"
      ? await applyOrchestratedBun(plan, { ok: true, mode: "apply" }, { home, identity: async () => probe(), now: () => 100, spawn })
      : await (await import("../../src/update/" + "orchestrated-node-driver.mjs")).applyNodeOrchestratedUpdate({ ok: true, mode: "apply" }, {
        installer, currentVersion: "2.0.0", cliRoot: root, home, launcher: join(root, "bin/ocx.mjs"), resolveBun: () => ({ path: bun }),
        plan: () => ({ status: 0, stdout: JSON.stringify(plan) }), identity: probe, spawn,
      });
    expect(result).toMatchObject({ exitCode: 12, result: { applied: true, healthy: false, error: "runtime-unverified" } });
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("apply admission binds the observed plan and deadline before any update driver runs", () => {
  const plan = buildOrchestratedPlan(base);
  const request = { ok: true, mode: "apply" } as const;
  expect(decideOrchestratedApply(plan, request, 100)).toEqual({ kind: "proceed" });
  expect(decideOrchestratedApply({ ...plan, updateInFlight: true }, request, 100)).toMatchObject({ exitCode: 10, result: { error: "update-in-flight" } });
  expect(decideOrchestratedApply(plan, { ...request, expectPlan: "different-plan-token" }, 100)).toMatchObject({ exitCode: 10, result: { error: "plan-changed", applied: false } });
  expect(decideOrchestratedApply(plan, { ...request, notAfter: 99 }, 100)).toMatchObject({ exitCode: 10, result: { error: "deadline-passed", applied: false } });
  expect(decideOrchestratedApply(plan, { ...request, notAfter: 100, expectPlan: plan.planToken }, 100)).toEqual({ kind: "proceed" });
  expect(decideOrchestratedApply(buildOrchestratedPlan({ ...base, identity: { kind: "unknown" } }), request, 100)).toMatchObject({ exitCode: 10, result: { error: "serving-install-unknown" } });
  expect(decideOrchestratedApply(buildOrchestratedPlan({ ...base, targetVersion: "2.0.0" }), request, 100)).toMatchObject({ exitCode: 0, result: { applied: false, fromVersion: "2.0.0", toVersion: "2.0.0" } });
});

test("plan decision matrix refuses unsafe installs, unknown identity and unsafe versions", () => {
  const live = { kind: "live", servingRoot: "/fixture/ocx", runtime: { pid: 3, port: 10101, hostname: "127.0.0.1", command: ["/fixture/bun", "/fixture/ocx/src/cli/index.ts"] } } as const;
  const cases: [Partial<PlanInputs>, string][] = [
    [{ installer: "desktop-app" }, "desktop-app-owned"],
    [{ installer: "source" }, "source-checkout"],
    [{ installer: "mise" }, "mise-managed"],
    [{ installer: "unknown" }, "installer-unknown"],
    [{ identity: { kind: "unknown" } }, "serving-install-unknown"],
    [{ identity: { kind: "mismatch" } }, "cli-not-serving-install"],
    [{ identity: { ...live, servingRoot: "/fixture/other" } }, "cli-not-serving-install"],
    [{ ownershipPermits: false }, "runtime-ownership-refused"],
    [{ runtimeOwner: "unknown" }, "runtime-ownership-refused"],
    [{ targetVersion: null }, "target-unresolved"],
    [{ targetVersion: "1.9.0" }, "downgrade-refused"],
    [{ targetVersion: "2.0.0" }, "up-to-date"],
  ];
  for (const [change, reason] of cases) {
    expect(buildOrchestratedPlan({ ...base, ...change })).toMatchObject({ canApply: false, reason });
  }
  const plan = buildOrchestratedPlan({ ...base, identity: live, runtimeOwner: "service" });
  expect(plan).toMatchObject({ schema: "ocx.update.plan/1", canApply: true, restartRequired: true, servingPath: "/fixture/ocx", updateInFlight: false, mutationBoundMs: 900000 });
  expect(plan.planToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect("reason" in plan).toBe(false);
});

test("observed plans bind the selected registry target, serving identity, owner and in-flight status", async () => {
  const live = { kind: "live" as const, servingRoot: "/fixture/ocx", runtime: { pid: 3, port: 10101, hostname: "127.0.0.1", command: ["/fixture/bun", "/fixture/ocx/src/cli/index.ts"] } };
  let requested = "";
  const deps: OrchestratedPlanDeps = {
    install: () => ({ installer: "npm", cliRoot: "/fixture/ocx", desktopPath: false }),
    currentVersion: () => "2.0.0",
    identity: async () => live,
    ownership: () => ({ runtimeOwner: "service", permits: true }),
    target: (selector) => { requested = selector; return selector === "2.2.0" ? selector : "2.1.0"; },
    inFlight: () => false,
  };
  const first = await observeOrchestratedPlan({ ok: true, mode: "plan", tag: "preview" }, deps);
  expect(requested).toBe("preview");
  expect(first).toMatchObject({ canApply: true, targetVersion: "2.1.0", runtimeOwner: "service", restartRequired: true, updateInFlight: false });
  expect((await observeOrchestratedPlan({ ok: true, mode: "plan", tag: "preview" }, deps)).planToken).toBe(first.planToken);
  const pinned = await observeOrchestratedPlan({ ok: true, mode: "plan", version: "2.2.0" }, deps);
  expect(requested).toBe("2.2.0");
  expect(pinned.targetVersion).toBe("2.2.0");
  expect(pinned.planToken).not.toBe(first.planToken);
  expect((await observeOrchestratedPlan({ ok: true, mode: "plan", version: "2.2.0" }, { ...deps, target: () => "2.3.0" })).reason).toBe("target-unresolved");
  expect((await observeOrchestratedPlan({ ok: true, mode: "plan" }, { ...deps, identity: async () => ({ kind: "unknown" }), inFlight: () => { throw Error("unknown"); } })).updateInFlight).toBe(true);
  expect((await observeOrchestratedPlan({ ok: true, mode: "plan" }, { ...deps, identity: async () => ({ kind: "live", ...live, servingRoot: "/fixture/other" }) })).reason).toBe("cli-not-serving-install");
  expect((await observeOrchestratedPlan({ ok: true, mode: "plan" }, { ...deps, ownership: () => ({ runtimeOwner: "unknown", permits: false }) })).reason).toBe("runtime-ownership-refused");
  expect((await observeOrchestratedPlan({ ok: true, mode: "plan" }, { ...deps, install: () => ({ installer: "standalone", cliRoot: "/fixture/ocx", desktopPath: true }) })).reason).toBe("desktop-app-owned");
  expect((await observeOrchestratedPlan({ ok: true, mode: "plan" }, { ...deps, identity: async () => { throw Error("unavailable"); } })).reason).toBe("plan-unavailable");
});

test("a recorded CLI claim is service ownership only when a service is installed", () => {
  const identity = { kind: "live" as const, servingRoot: "/fixture/ocx", runtime: { pid: 3, port: 10101, hostname: "127.0.0.1", command: ["/fixture/bun", "/fixture/ocx/src/cli/index.ts"] } };
  const owner = { kind: "owned" as const, revision: 1, ownership: { owner: "cli" as const, installId: "fixture", consentGeneration: 1 } };
  expect(classifyPlanRuntimeOwner(identity, owner, { kind: "none" }, false)).toMatchObject({ runtimeOwner: "unmanaged", permits: true });
  expect(classifyPlanRuntimeOwner(identity, owner, { kind: "none" }, true)).toMatchObject({ runtimeOwner: "service", permits: true });
  expect(classifyPlanRuntimeOwner(identity, owner, { kind: "unknown", reason: "fixture", desktopSeen: false }, true)).toMatchObject({ runtimeOwner: "unknown", permits: false });
  expect(classifyPlanRuntimeOwner({ kind: "unknown" }, { kind: "none", revision: 1 }, { kind: "none" }, false)).toMatchObject({ runtimeOwner: "unknown", permits: false });
});
