import { expect, test } from "bun:test";
import { chmodSync, closeSync, mkdirSync, mkdtempSync, openSync, realpathSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { classifyOrchestratedOutcome, type OutcomeInput } from "../../src/update/orchestrated-outcome.mjs";
import { verifyOrchestratedInstall } from "../../src/update/orchestrated-tree.mjs";
import { canonicalOrchestratedPnpmOwner, matchesOrchestratedPnpmOwner, verifyOrchestratedPnpmInstall } from "../../src/update/orchestrated-pnpm.mjs";
import { waitForOrchestratedChild } from "../../src/update/orchestrated-child.mjs";

const base: OutcomeInput = {
  fromVersion: "2.0.0", toVersion: "2.1.0", installer: "npm", childExited: true,
  childExitCode: 1, outcome: { phase: "preflight" }, previousVerified: true,
  targetVerified: false, runtimeHealthy: true, restarted: false,
};

test.skipIf(process.platform === "win32")("pnpm parent identity binds the lexical store path as well as its canonical target", () => {
  const root = mkdtempSync(join(tmpdir(), "ocx-pnpm-identity-"));
  try {
    const store = join(root, "store", "v11"), alias = join(root, "alias", "v11");
    mkdirSync(store, { recursive: true }); mkdirSync(join(root, "alias"));
    symlinkSync(store, alias, "dir");
    const legacy = { commandPath: root, packagePath: root, globalDir: root, globalRoot: root, globalBinDir: root };
    const owner = { ...legacy, globalStore: true, store: realpathSync(store), storePath: store, virtualStoreDirs: [] };
    const expected = canonicalOrchestratedPnpmOwner(owner);
    expect(matchesOrchestratedPnpmOwner(expected, owner)).toBe(true);
    expect(matchesOrchestratedPnpmOwner(expected, { ...owner, storePath: alias })).toBe(false);
    // A legacy group carries no store, and neither shape can stand in for the other.
    const legacyExpected = canonicalOrchestratedPnpmOwner(legacy);
    expect(Object.keys(legacyExpected).sort()).toEqual(["commandPath", "globalBinDir", "globalDir", "globalRoot", "packagePath"]);
    expect(matchesOrchestratedPnpmOwner(legacyExpected, legacy)).toBe(true);
    expect(matchesOrchestratedPnpmOwner(legacyExpected, owner)).toBe(false);
    expect(matchesOrchestratedPnpmOwner(expected, legacy)).toBe(false);
    expect(() => canonicalOrchestratedPnpmOwner({ ...legacy, store: realpathSync(store) })).toThrow();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("the parent watchdog reports overrun without signalling a still-running child", async () => {
  const signals = new EventEmitter(), child = new EventEmitter();
  const forwarded: string[] = [];
  Object.assign(child, { kill: (signal: string) => { forwarded.push(signal); return true; } });
  const timers: Array<{ callback: () => void; ms: number }> = [];
  const cleared: number[] = [];
  const waiting = waitForOrchestratedChild(child as never, {
    signals, overrunMs: 900_000,
    setTimer: (callback: () => void, ms: number) => { timers.push({ callback, ms }); return timers.length; },
    clearTimer: (id: unknown) => { cleared.push(id as number); },
  });
  expect(timers.map(timer => timer.ms)).toEqual([900_000]);
  timers[0]!.callback();
  expect(await waiting).toEqual({ confirmed: false, code: null, signal: null, reason: "overrun" });
  expect(forwarded).toEqual([]);
  expect(signals.listenerCount("SIGTERM")).toBe(0);
  expect(cleared).toContain(1);
  child.emit("close", 0, null);

  const completed = new EventEmitter();
  Object.assign(completed, { kill: () => true });
  const normal = waitForOrchestratedChild(completed as never, {
    signals, overrunMs: 900_000,
    setTimer: (callback: () => void, ms: number) => { timers.push({ callback, ms }); return timers.length; },
    clearTimer: (id: unknown) => { cleared.push(id as number); },
  });
  completed.emit("close", 0, null);
  expect(await normal).toEqual({ confirmed: true, code: 0, signal: null });
  expect(cleared).toContain(2);
});

test("a distant watchdog deadline is not shortened by the platform timer limit", async () => {
  const signals = new EventEmitter(), child = new EventEmitter();
  Object.assign(child, { kill: () => true });
  const timers: Array<{ callback: () => void; ms: number }> = [];
  const waiting = waitForOrchestratedChild(child as never, {
    signals, overrunMs: 2_147_483_647 + 42,
    setTimer: (callback: () => void, ms: number) => { timers.push({ callback, ms }); return timers.length; },
    clearTimer: () => {},
  });
  expect(timers[0]!.ms).toBe(2_147_483_647);
  timers[0]!.callback();
  expect(timers[1]!.ms).toBe(42);
  timers[1]!.callback();
  expect(await waiting).toMatchObject({ confirmed: false, reason: "overrun" });
});

test("a signal is forwarded and completion waits for close or the bounded timer", async () => {
  const signals = new EventEmitter(), child = new EventEmitter();
  const forwarded: string[] = [];
  Object.assign(child, { kill: (signal: string) => { forwarded.push(signal); return true; } });
  let deadline: (() => void) | undefined;
  const deps = { signals, setTimer: (callback: () => void) => { deadline = callback; return 1; }, clearTimer: () => {} };
  const waiting = waitForOrchestratedChild(child as never, deps);
  signals.emit("SIGTERM");
  expect(forwarded).toEqual(["SIGTERM"]);
  expect(deadline).toBeDefined();
  child.emit("close", 1, null);
  expect(await waiting).toEqual({ confirmed: true, code: 1, signal: null });

  const stillRunning = new EventEmitter();
  Object.assign(stillRunning, { kill: () => true });
  const uncertain = waitForOrchestratedChild(stillRunning as never, deps);
  signals.emit("SIGINT");
  deadline!();
  expect(await uncertain).toEqual({ confirmed: false, code: null, signal: null });
  expect(signals.listenerCount("SIGINT")).toBe(0);
});

test("a signal-killed worker cannot prove its installer stopped", () => {
  for (const outcome of [{ phase: "refused" as const, error: "plan-changed" }, { phase: "failed" as const }]) {
    expect(classifyOrchestratedOutcome({ ...base, childExitCode: null, outcome }))
      .toMatchObject({ exitCode: 12, result: { error: "outcome-unverified" } });
  }
});

test("an unconfirmed installer termination is never classified as a safe rollback", () => {
  expect(classifyOrchestratedOutcome({ ...base, outcome: { phase: "failed", error: "installer-termination-unconfirmed" } }))
    .toMatchObject({ exitCode: 12, result: { error: "installer-termination-unconfirmed", applied: false } });
});

test("explicitly unconfirmed termination overrides previous-state proof for every outcome", () => {
  for (const outcome of [
    { phase: "failed", error: "installer-timeout", terminationConfirmed: false },
    { phase: "refused", error: "plan-changed", terminationConfirmed: false },
    { phase: "installed", activeRoot: join(tmpdir(), "fixture"), terminationConfirmed: false },
  ]) {
    expect(classifyOrchestratedOutcome({ ...base, outcome: outcome as OutcomeInput["outcome"], targetVerified: true })).toMatchObject({ exitCode: 12 });
  }
});

test("exit classification requires confirmed termination and independently verified active state", () => {
  expect(classifyOrchestratedOutcome({ ...base, outcome: { phase: "refused", error: "plan-changed" } })).toMatchObject({ exitCode: 10, result: { applied: false, error: "plan-changed", rolledBack: false } });
  expect(classifyOrchestratedOutcome(base)).toMatchObject({ exitCode: 11, result: { applied: false, rolledBack: false } });
  expect(classifyOrchestratedOutcome({ ...base, outcome: { phase: "failed", rollbackPerformed: true } })).toMatchObject({ exitCode: 11, result: { rolledBack: true } });
  expect(classifyOrchestratedOutcome({ ...base, outcome: { phase: "failed", rollbackPerformed: false } })).toMatchObject({ exitCode: 11, result: { rolledBack: false } });
  expect(classifyOrchestratedOutcome({ ...base, previousVerified: false })).toMatchObject({ exitCode: 12 });
  expect(classifyOrchestratedOutcome({ ...base, childExited: false })).toMatchObject({ exitCode: 12 });
  expect(classifyOrchestratedOutcome({ ...base, outcome: null })).toMatchObject({ exitCode: 12 });
  expect(classifyOrchestratedOutcome({ ...base, outcome: { phase: "overrun" } })).toMatchObject({ exitCode: 12 });
  const installed = { phase: "installed" as const, activeRoot: join(tmpdir(), "fixture", "install") };
  expect(classifyOrchestratedOutcome({ ...base, childExitCode: 0, outcome: installed, targetVerified: true })).toMatchObject({ exitCode: 0, result: { applied: true, healthy: true } });
  expect(classifyOrchestratedOutcome({ ...base, childExitCode: 0, outcome: installed, targetVerified: true, runtimeHealthy: false })).toMatchObject({ exitCode: 12, result: { applied: true, healthy: false, error: "runtime-unhealthy" } });
  expect(classifyOrchestratedOutcome({ ...base, childExitCode: 0, outcome: installed, targetVerified: false })).toMatchObject({ exitCode: 12, result: { applied: false, error: "install-unverified" } });
  for (const malformed of [{ phase: "installed" }, { phase: "installed", activeRoot: "" }, { phase: "refused", error: 42 }, { phase: "failed", rollbackPerformed: "yes" }, { phase: "failed", terminationConfirmed: "yes" }]) {
    expect(classifyOrchestratedOutcome({ ...base, childExitCode: malformed.phase === "installed" ? 0 : 1, outcome: malformed as OutcomeInput["outcome"], targetVerified: true })).toMatchObject({ exitCode: 12 });
  }
});

test.each(["npm", "pnpm", "bun"] as const)("%s verified install remains applied when recovery fails", installer => {
  const outcome = { phase: "installed" as const, activeRoot: join(tmpdir(), "fixture", "install") };
  expect(classifyOrchestratedOutcome({ ...base, installer, outcome, childExitCode: 1, targetVerified: true, runtimeHealthy: true }))
    .toMatchObject({ exitCode: 12, result: { applied: true, healthy: false, error: "runtime-unhealthy" } });
  expect(classifyOrchestratedOutcome({ ...base, installer, outcome, childExitCode: 1, targetVerified: false }))
    .toMatchObject({ exitCode: 12, result: { applied: false, healthy: false, error: "install-unverified" } });
});

test("passive install verification rejects a damaged tree and permits a retained backup", () => {
  const parent = mkdtempSync(join(tmpdir(), "ocx-update-tree-")), root = join(parent, "package");
  try {
    for (const dir of ["bin", "src/cli", "node_modules/bun/bin", "node_modules/zod"]) mkdirSync(join(root, dir), { recursive: true });
    writeFileSync(join(root, "package.json"), JSON.stringify({ version: "2.1.0", dependencies: { bun: "1", zod: "1" } }));
    writeFileSync(join(root, "bin/ocx.mjs"), "x".repeat(1024));
    writeFileSync(join(root, "src/cli/index.ts"), "export {};\n");
    writeFileSync(join(root, "node_modules/bun/package.json"), "{}");
    writeFileSync(join(root, "node_modules/zod/package.json"), "{}");
    const bun = join(root, "node_modules/bun/bin/bun");
    closeSync(openSync(bun, "w")); truncateSync(bun, 10 * 1024 * 1024);
    mkdirSync(join(parent, ".ocx-backup-retained"));
    expect(verifyOrchestratedInstall(root, "2.1.0", "npm")).toBe(true);
    truncateSync(bun, 10);
    expect(verifyOrchestratedInstall(root, "2.1.0", "npm")).toBe(false);
    truncateSync(bun, 10 * 1024 * 1024);
    rmSync(join(root, "src/cli/index.ts"));
    expect(verifyOrchestratedInstall(root, "2.1.0", "npm")).toBe(false);
    writeFileSync(join(root, "src/cli/index.ts"), "export {};\n");
    rmSync(join(root, "node_modules/zod/package.json"));
    expect(verifyOrchestratedInstall(root, "2.1.0", "npm")).toBe(false);
  } finally { rmSync(parent, { recursive: true, force: true }); }
});

test("pnpm verification re-resolves the pinned owner and checks the active tree and shims", () => {
  const home = mkdtempSync(join(tmpdir(), "ocx-orchestrated-pnpm-"));
  const globalDir = join(home, "global"), globalRoot = join(globalDir, "v11"), globalBinDir = join(home, "bin");
  const root = join(globalRoot, "node_modules", "@bitkyc08", "opencodex"), commandPath = join(home, "pnpm");
  const storePath = join(home, "store", "v11"); mkdirSync(storePath, { recursive: true });
  const owner = { commandPath, packagePath: root, globalDir, globalRoot, globalBinDir, store: realpathSync(storePath), storePath, virtualStoreDirs: [] };
  try {
    for (const dir of [globalBinDir, join(root, "bin"), join(root, "src/cli"), join(root, "node_modules/bun/bin"), join(root, "node_modules/zod")]) mkdirSync(dir, { recursive: true });
    writeFileSync(join(root, "package.json"), JSON.stringify({ version: "2.1.0", dependencies: { bun: "1", zod: "1" } }));
    writeFileSync(join(root, "bin/ocx.mjs"), "x".repeat(1024));
    writeFileSync(join(root, "src/cli/index.ts"), "export {};\n");
    writeFileSync(join(root, "node_modules/bun/package.json"), "{}");
    writeFileSync(join(root, "node_modules/zod/package.json"), "{}");
    const bun = join(root, "node_modules/bun/bin/bun");
    closeSync(openSync(bun, "w")); truncateSync(bun, 10 * 1024 * 1024);
    const names = process.platform === "win32" ? ["ocx.cmd", "ocx.ps1", "opencodex.cmd", "opencodex.ps1"] : ["ocx", "opencodex"];
    for (const name of names) { const shim = join(globalBinDir, name); writeFileSync(shim, `#!/bin/sh\nexec node '${join(root, "bin/ocx.mjs")}' "$@"\n`); chmodSync(shim, 0o755); }
    let listedVersion = "2.1.0", listedGroup = globalRoot;
    const runPnpm = (_command: string, args: readonly string[]) => {
      if (args[0] === "store") return { status: 0, stdout: storePath };
      if (args[0] === "config" && args[2] === "store-dir") return { status: 0, stdout: storePath };
      if (args[0] === "config" && ["virtual-store-dir", "global-virtual-store-dir"].includes(args[2] ?? "")) return { status: 0, stdout: "undefined" };
      if (args[0] === "list") return { status: 0, stdout: JSON.stringify([{ path: listedGroup, dependencies: { "@bitkyc08/opencodex": { path: root, version: listedVersion } } }]) };
      if (args[0] === "root") return { status: 0, stdout: `${listedGroup}\n` };
      if (args[0] === "config" && args[2] === "global-dir") return { status: 0, stdout: `${globalDir}\n` };
      if (args[0] === "config" && args[2] === "global-bin-dir") return { status: 0, stdout: `${globalBinDir}\n` };
      return { status: 1 };
    };
    const options = { owner, activeRoot: root, version: "2.1.0", runPnpm };
    expect(verifyOrchestratedPnpmInstall(options)).toBe(true);
    listedVersion = "2.0.0"; expect(verifyOrchestratedPnpmInstall(options)).toBe(false); listedVersion = "2.1.0";
    listedGroup = join(globalDir, "v99"); expect(verifyOrchestratedPnpmInstall(options)).toBe(false); listedGroup = globalRoot;
    rmSync(join(root, "src/cli/index.ts")); expect(verifyOrchestratedPnpmInstall(options)).toBe(false);
    writeFileSync(join(root, "src/cli/index.ts"), "export {};\n");
    writeFileSync(join(globalBinDir, names[0]!), "#!/bin/sh\nexit 0\n"); expect(verifyOrchestratedPnpmInstall(options)).toBe(false);
  } finally { rmSync(home, { recursive: true, force: true }); }
});
