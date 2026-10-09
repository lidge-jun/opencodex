import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as childProcess from "node:child_process";
import { SUBPROCESS_KILL_GRACE_MS } from "../../src/lib/bounded-subprocess";
import * as runtime from "../../src/codex/runtime";
import * as bundled from "../../src/codex/catalog/bundled";
import { clampCatalogModelsToCodexSupport } from "../../src/codex/catalog/effort";
import { repoPath } from "../helpers/repo-root";

const catalog = { models: [{ slug: "gpt-5.5", base_instructions: "fixture", supported_reasoning_levels: [{ effort: "medium", description: "fixture" }] }] };
let root: string;
let selected: { command: string; version: string; source: "environment" };
let saved: Record<string, string | undefined>;
let exec: ReturnType<typeof spyOn<typeof runtime, "execCodexFileAsync">>;

beforeEach(() => {
  mkdirSync(repoPath(".tmp"), { recursive: true });
  root = mkdtempSync(repoPath(".tmp/catalog-async-"));
  selected = { command: join(root, "codex.exe"), version: "0.160.0", source: "environment" };
  writeFileSync(selected.command, "synthetic executable");
  saved = Object.fromEntries(["OPENCODEX_HOME", "CODEX_HOME", "CODEX_CLI_PATH"].map(key => [key, process.env[key]]));
  process.env.OPENCODEX_HOME = root;
  process.env.CODEX_HOME = join(root, "codex-home");
  process.env.CODEX_CLI_PATH = selected.command;
  runtime.clearCodexRuntimeResolveCache();
  bundled.resetBundledCatalogCacheForTests();
  if (runtime.execCodexFileAsync) exec = spyOn(runtime, "execCodexFileAsync").mockImplementation(async (_file, args) =>
    args.includes("--version") ? "codex-cli 0.160.0" : JSON.stringify(catalog));
});

afterEach(() => {
  bundled.resetBundledCatalogCacheForTests();
  runtime.clearCodexRuntimeResolveCache();
  exec?.mockRestore();
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  rmSync(root, { recursive: true, force: true });
});

function hold<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(settle => { resolve = settle; });
  return { promise, resolve };
}

function warmRuntime() {
  runtime.setCodexRuntimeResolveCacheForTests({ runtime: selected, failures: [] }, { discoverAlternatives: false });
}

test("concurrent async loads share one version/model flight and warm reload runs no child", async () => {
  const results = await Promise.all(Array.from({ length: 12 }, () => bundled.loadBundledCodexCatalogAsync()));
  expect(results.every(value => value?.models[0]?.slug === "gpt-5.5")).toBe(true);
  expect(exec.mock.calls.filter(call => call[1].includes("--version"))).toHaveLength(1);
  expect(exec.mock.calls.filter(call => call[1].includes("debug"))).toHaveLength(1);
  await bundled.loadBundledCodexCatalogAsync(); // stabilize post-persistence input signature
  const count = exec.mock.calls.length;
  await bundled.loadBundledCodexCatalogAsync();
  expect(exec.mock.calls).toHaveLength(count);
});

test("same-selection snapshot is detached and retains stale rows while refresh settles", async () => {
  await bundled.loadBundledCodexCatalogAsync();
  bundled.setBundledCatalogCacheForTests(selected, catalog, { expiresAt: 0 });
  const held = hold<string>();
  exec.mockImplementation(() => held.promise);
  const first = bundled.bundledCodexCatalogSnapshot();
  const pending = bundled.loadBundledCodexCatalogAsync();
  expect(first?.models[0]?.slug).toBe("gpt-5.5");
  expect(Reflect.set(first!.models[0]!, "slug", "mutated")).toBe(false);
  expect(bundled.bundledCodexCatalogSnapshot()?.models[0]?.slug).toBe("gpt-5.5");
  held.resolve(JSON.stringify(catalog));
  await pending;
  process.env.CODEX_CLI_PATH = join(root, "missing.exe");
  expect(bundled.bundledCodexCatalogSnapshot()).toBeNull();
  await bundled.loadBundledCodexCatalogAsync();
});

for (const change of ["epoch", "runtime epoch", "input", "stop"] as const) {
  test(`late catalog result rejected after ${change} invalidation`, async () => {
    const held = hold<string>();
    let current = true;
    const pending = bundled.loadBundledCodexCatalogAsync({ commandCandidates: () => [selected.command], execFile: () => held.promise }, () => current);
    if (change === "epoch") bundled.invalidateBundledCatalogCache();
    if (change === "runtime epoch") runtime.clearCodexRuntimeResolveCache();
    if (change === "input") process.env.CODEX_CLI_PATH = "changed-selection";
    if (change === "stop") current = false;
    held.resolve(JSON.stringify(catalog));
    expect(await pending).toBeNull();
    expect(bundled.bundledCatalogCacheState().valueIdentity).toBeNull();
  });
}

for (const change of ["pin", "clear", "stop", "abort", "valid"] as const) {
  test(`async runtime persistence guards ${change} and returns detached frozen selection`, async () => {
    const held = hold<string>();
    const dir = join(root, change);
    mkdirSync(dir);
    const initial = { version: 1, command: selected.command, source: "environment", selectedVersion: "0.159.0", origin: "discovered", updatedAt: "2026-10-08T00:00:00Z" };
    let bytes = JSON.stringify(initial);
    let current = true;
    const controller = new AbortController();
    const deps: runtime.ResolveCodexRuntimeDeps = {
      configDir: dir, env: { CODEX_CLI_PATH: selected.command, PATH: "" }, platform: "win32",
      discoverAlternatives: false, existsSync: () => true, readdirSync: () => [],
      readFileSync: path => { if (path.endsWith("codex-runtime.json")) return bytes; throw new Error("absent"); },
      execFile: () => held.promise, signal: controller.signal,
    };
    const pending = runtime.resolveAndPersistCodexRuntimeAsync(deps, () => current);
    if (change === "pin") bytes = JSON.stringify({ ...initial, origin: "pinned" });
    if (change === "clear") runtime.clearCodexRuntimeResolveCache();
    if (change === "stop") current = false;
    if (change === "abort") controller.abort();
    held.resolve("codex-cli 0.160.0");
    const resolved = await pending;
    const file = join(dir, "codex-runtime.json");
    expect(resolved !== null).toBe(change === "valid");
    expect(existsSync(file)).toBe(change === "valid");
    if (resolved) {
      expect(JSON.parse(readFileSync(file, "utf8")).selectedVersion).toBe("0.160.0");
      expect(Object.isFrozen(resolved.runtime)).toBe(true);
    }
  });
}

test("a scoped source abort does not cancel an independent shared model flight", async () => {
  warmRuntime();
  const held = hold<string>();
  exec.mockImplementation(async (_file, args) => args.includes("--version") ? "codex-cli 0.160.0" : held.promise);
  const independent = bundled.loadBundledCodexCatalogAsync();
  const controller = new AbortController();
  const scoped = bundled.loadBundledCodexCatalogAsync({}, () => true, controller.signal);
  controller.abort();
  expect(await scoped).toBeNull();
  held.resolve(JSON.stringify(catalog));
  expect((await independent)?.models[0]?.slug).toBe("gpt-5.5");
  expect(bundled.bundledCodexCatalogSnapshot()?.models[0]?.slug).toBe("gpt-5.5");
});

test("scoped flight abort propagates to its executor and cannot publish late output", async () => {
  const held = hold<string>();
  const controller = new AbortController();
  let signal: AbortSignal | undefined;
  const pending = bundled.loadBundledCodexCatalogAsync({ commandCandidates: () => [selected.command], execFile: (_file, _args, options) => { signal = options.signal; return held.promise; } }, () => true, controller.signal);
  controller.abort();
  expect(await pending).toBeNull();
  expect(signal?.aborted).toBe(true);
  held.resolve(JSON.stringify(catalog));
  await Promise.resolve();
  expect(bundled.bundledCatalogCacheState().valueIdentity).toBeNull();
});

test("failed refresh retains matching confirmed rows and bounds snapshot retries to cooldown", async () => {
  await bundled.loadBundledCodexCatalogAsync();
  bundled.setBundledCatalogCacheForTests(selected, catalog, { expiresAt: 0 });
  exec.mockImplementation(async (_file, args) => args.includes("--version") ? "codex-cli 0.160.0" : "invalid catalog");
  expect(bundled.bundledCodexCatalogSnapshot()?.models[0]?.slug).toBe("gpt-5.5");
  await bundled.loadBundledCodexCatalogAsync();
  const count = exec.mock.calls.length;
  for (let i = 0; i < 20; i++) expect(bundled.bundledCodexCatalogSnapshot()?.models[0]?.slug).toBe("gpt-5.5");
  await Promise.resolve();
  expect(exec.mock.calls).toHaveLength(count);
  const now = Date.now();
  const clock = spyOn(Date, "now").mockReturnValue(now + bundled.BUNDLED_CATALOG_CACHE_MS + 1);
  try {
    bundled.bundledCodexCatalogSnapshot();
    await bundled.loadBundledCodexCatalogAsync();
    expect(exec.mock.calls.length).toBeGreaterThan(count);
  } finally { clock.mockRestore(); }
});

test("failed different-version refresh drops old capability evidence", async () => {
  await bundled.loadBundledCodexCatalogAsync();
  await bundled.loadBundledCodexCatalogAsync();
  bundled.setBundledCatalogCacheForTests({ ...selected, version: "0.159.0" }, catalog);
  exec.mockImplementation(async (_file, args) => args.includes("--version") ? "codex-cli 0.160.0" : "invalid catalog");
  await bundled.loadBundledCodexCatalogAsync();
  expect(bundled.bundledCodexCatalogSnapshot()).toBeNull();
});

test("45-second flight deadline bounds an uncooperative executor and next load succeeds", async () => {
  const set = globalThis.setTimeout;
  let deadline: number | undefined;
  const timer = spyOn(globalThis, "setTimeout").mockImplementation(((fn, delay, ...args) => {
    if (delay === 45_000) deadline = delay;
    return set(fn, delay === 45_000 ? 10 : delay, ...args);
  }) as typeof setTimeout);
  try {
    const expired = await bundled.loadBundledCodexCatalogAsync({ commandCandidates: () => [selected.command], execFile: () => new Promise(() => {}) });
    expect(deadline).toBe(45_000);
    expect(expired).toBeNull();
  } finally { timer.mockRestore(); }
  expect((await bundled.loadBundledCodexCatalogAsync({ commandCandidates: () => [selected.command], execFile: async () => JSON.stringify(catalog) }))?.models[0]?.slug).toBe("gpt-5.5");
});

test("observed effort clamp never invokes synchronous runtime/model probes", () => {
  warmRuntime();
  let syncCalls = 0;
  const rows = [{ ...catalog.models[0]!, supported_reasoning_levels: [{ effort: "high", description: "fixture" }], default_reasoning_level: "high" }];
  clampCatalogModelsToCodexSupport(rows, { observedCatalog: catalog, execFileSync: () => { syncCalls++; return "codex-cli 0.160.0"; } });
  expect(syncCalls).toBe(0);
});

for (const mode of ["abort", "deadline"] as const) {
  test(`native async executor reaps a READY child ignoring SIGTERM after ${mode}`, async () => {
    exec.mockRestore();
    const ready = hold<void>();
    const exited = hold<void>();
    const controller = new AbortController();
    let child: childProcess.ChildProcess | undefined;
    const actualExec = childProcess.execFile;
    const spawn = spyOn(childProcess, "execFile").mockImplementation(((...args: Parameters<typeof actualExec>) => {
      child = actualExec(...args);
      let output = "";
      child.stdout?.on("data", chunk => { output += String(chunk); if (output.includes("READY")) ready.resolve(); });
      child.once("exit", () => exited.resolve());
      return child;
    }) as typeof actualExec);
    const set = globalThis.setTimeout;
    // Arm the deadline only after the child has installed its signal handler.
    const timer = spyOn(globalThis, "setTimeout").mockImplementation(((fn, delay, ...args) => {
      if (mode === "deadline" && delay === 1234) {
        const scheduled = set(() => { void ready.promise.then(() => fn(...args)); }, 0);
        return scheduled;
      }
      return set(fn, delay, ...args);
    }) as typeof setTimeout);
    const script = "if (process.platform !== 'win32') process.on('SIGTERM', () => {}); console.log('READY'); setInterval(() => {}, 20);";
    const pending = runtime.execCodexFileAsync(process.execPath, ["-e", script], {
      encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: mode === "deadline" ? 1234 : 10_000,
      windowsHide: true, signal: controller.signal,
    });
    // Observe rejection before a fast Windows kill can settle it.
    const rejected = pending.then(() => { throw new Error("held child unexpectedly completed"); }, error => error);
    try {
      await Promise.race([ready.promise, Bun.sleep(3000).then(() => { throw new Error("child never became READY"); })]);
      const started = Date.now();
      if (mode === "abort") controller.abort();
      const error = await rejected;
      expect(String(error)).toMatch(mode === "abort" ? /abort/i : /deadline|timed out|kill/i);
      expect(Date.now() - started).toBeLessThan(1000);
      const didExit = await Promise.race([
        exited.promise.then(() => true), Bun.sleep(SUBPROCESS_KILL_GRACE_MS + 1000).then(() => false),
      ]);
      expect(didExit).toBe(true);
      expect(child!.exitCode !== null || child!.signalCode !== null).toBe(true);
      if (process.platform !== "win32") expect(child!.signalCode).toBe("SIGKILL");
      expect(() => process.kill(child!.pid!, 0)).toThrow();
    } finally {
      timer.mockRestore();
      spawn.mockRestore();
      controller.abort();
      if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await Promise.race([exited.promise, Bun.sleep(3000)]);
      await rejected;
    }
  }, 10_000);
}

test("model probes allow the bounded large catalog buffer and retain all rows", async () => {
  let limit: number | undefined;
  const large = { models: [catalog.models[0], { slug: "gpt-5.6-sol", base_instructions: "x".repeat(2 * 1024 * 1024) }] };
  const result = await bundled.loadBundledCodexCatalogAsync({ commandCandidates: () => [selected.command], execFile: async (_file, _args, options) => { limit = options.maxBuffer; return JSON.stringify(large); } });
  expect(limit).toBe(64 * 1024 * 1024);
  expect(result?.models).toHaveLength(2);
  expect(result?.models[1]?.base_instructions).toBe(large.models[1]!.base_instructions);
});

test("a new shared selection aborts obsolete model work and refuses its late publication", async () => {
  expect(typeof bundled.loadBundledCodexCatalogAsync).toBe("function");
  const held = hold<string>();
  const started = hold<void>();
  let oldSignal: AbortSignal | undefined;
  exec.mockImplementation(async (_file, args, options) => {
    if (args.includes("--version")) return "codex-cli 0.160.0";
    if (!oldSignal) { oldSignal = options.signal; started.resolve(); return held.promise; }
    return JSON.stringify(catalog);
  });
  const obsolete = bundled.loadBundledCodexCatalogAsync();
  await started.promise;
  process.env.CODEX_CLI_PATH = join(root, "next.exe");
  writeFileSync(process.env.CODEX_CLI_PATH, "synthetic executable");
  const next = bundled.loadBundledCodexCatalogAsync();
  expect(oldSignal?.aborted).toBe(true);
  held.resolve(JSON.stringify(catalog));
  expect(await obsolete).toBeNull();
  expect((await next)?.models[0]?.slug).toBe("gpt-5.5");
  expect(bundled.bundledCodexCatalogSnapshot()?.models[0]?.slug).toBe("gpt-5.5");
});
