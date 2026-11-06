import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { closeSync, mkdirSync, openSync, readdirSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { runConfigPreflight } from "../../src/update/config-preflight";
import { configDiagnosticsFromRaw, readConfigDiagnostics } from "../../src/config/diagnostics";
import { readCliConfigForMutation } from "../../src/cli/config-mutation";
import { createTempHome, type TempHome } from "../helpers/temp-home";
import { updateSourceFunction } from "../helpers/update-source-body";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { repoRoot as resolveRepoRoot } from "../helpers/repo-root";

const repoRoot = resolveRepoRoot();
let home: TempHome;
const canSymlink = (() => {
  const probe = createTempHome("ocx-preflight-link-probe-");
  try {
    writeFileSync(probe.path("target"), "{}");
    symlinkSync(probe.path("target"), probe.path("link"), "file");
    return true;
  } catch (error: unknown) {
    if (process.platform === "win32" && (error as NodeJS.ErrnoException).code === "EPERM") return false;
    throw error;
  } finally { probe.remove(); }
})();

beforeEach(() => {
  home = createTempHome("ocx-update-preflight-");
});

afterEach(() => {
  home.remove();
});

describe("update config pre-flight", () => {
  test("refuses an alias that passive diagnostics reports as fallback", () => {
    const cfg = home.path("config.json");
    writeFileSync(cfg, JSON.stringify({ providers: { mock: { adapter: "openai-chat", baseUrl: "https://example.test/v1", alias: 42 } } }));
    expect(readConfigDiagnostics({ passive: true }).source).toBe("fallback");
    expect(runConfigPreflight(cfg)).toMatchObject({ ok: false, reason: "fallback" });
  });
  test("passes when config.json is valid", () => {
    const cfg = home.path("config.json");
    writeFileSync(cfg, JSON.stringify({
      port: 10100,
      defaultProvider: "mock",
      providers: { mock: { adapter: "openai-chat", baseUrl: "https://api.example.com/v1" } },
    }), "utf8");

    const result = runConfigPreflight(cfg);
    expect(result.ok).toBe(true);
  });

  test("refuses the runtime's degraded provider alias without exposing it or writing backups", () => {
    const cfg = home.path("config.json");
    const raw = JSON.stringify({ providers: { mock: { adapter: "openai-chat", baseUrl: "https://example.test/v1", alias: 42 } } });
    writeFileSync(cfg, raw, "utf8");
    const before = readdirSync(home.root);
    expect(readConfigDiagnostics({ passive: true }).source).toBe("fallback");
    expect(() => readCliConfigForMutation({ passive: true })).toThrow();
    expect(runConfigPreflight(cfg)).toMatchObject({ ok: false, reason: "fallback" });
    expect(readFileSync(cfg, "utf8")).toBe(raw);
    expect(readdirSync(home.root)).toEqual(before);
  });

  test("uses runtime sanitizers without logging configuration values", () => {
    const cfg = home.path("config.json");
    const raw = JSON.stringify({ providers: { mock: { adapter: "openai-chat", baseUrl: "https://example.test/v1",
      modelCosts: { "synthetic-secret-model": 42 } } } });
    writeFileSync(cfg, raw, "utf8");
    const before = readdirSync(home.root);
    const warnings = spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(readConfigDiagnostics({ passive: true }).source).toBe("file");
      expect(warnings.mock.calls.flat().join("\n")).toContain("synthetic-secret-model");
      warnings.mockClear();
      expect(runConfigPreflight(cfg)).toEqual({ ok: true });
      expect(warnings).not.toHaveBeenCalled();
      expect(readFileSync(cfg, "utf8")).toBe(raw);
      expect(readdirSync(home.root)).toEqual(before);
    } finally { warnings.mockRestore(); }
  });

  test.each([
    { label: "invalid alias", config: { providers: { mock: { adapter: "openai-chat", baseUrl: "https://example.test/v1", alias: 42 } } }, source: "fallback" },
    { label: "invalid schema", config: { port: -1 }, source: "fallback" },
    { label: "salvageable routing profile", config: { routingProfiles: { bad: { candidates: [] } } }, source: "fallback" },
    { label: "repaired defaults", config: { providers: { mock: { adapter: "openai-chat", baseUrl: "https://example.test/v1" } } }, source: "file" },
    { label: "degraded hostname", config: { hostname: "" }, source: "file" },
    { label: "invalid sidecar instance", config: { webSearchSidecar: { backend: "anthropic", anthropicInstance: "bad-instance" } }, source: "file" },
    { label: "empty defaults", config: {}, source: "file" },
  ])("matches passive diagnostics for $label", ({ config, source }) => {
    const cfg = home.path("config.json");
    const raw = JSON.stringify(config);
    writeFileSync(cfg, raw);
    const before = readdirSync(home.root);
    expect(readConfigDiagnostics({ passive: true }).source).toBe(source);
    expect(runConfigPreflight(cfg).ok).toBe(source === "file");
    expect(readFileSync(cfg, "utf8")).toBe(raw);
    expect(readdirSync(home.root)).toEqual(before);
  });

  test.each(["null", "[]", '"text"', "42"])("rejects non-object config %s", raw => {
    const cfg = home.path("config.json");
    writeFileSync(cfg, raw);
    expect(runConfigPreflight(cfg)).toMatchObject({ ok: false, reason: "fallback" });
  });

  test("reports a descriptor close failure without throwing", () => {
    const cfg = home.path("config.json");
    writeFileSync(cfg, "{}");
    expect(runConfigPreflight(cfg, openSync, fd => { closeSync(fd); throw new Error("synthetic close failure"); }))
      .toMatchObject({ ok: false, reason: "read_error" });
  });

  test("rejects an occupied path when open reports missing", () => {
    const cfg = home.path("config.json");
    writeFileSync(cfg, "{}");
    const missing: typeof openSync = () => { throw Object.assign(new Error("synthetic missing"), { code: "ENOENT" }); };
    expect(runConfigPreflight(cfg, missing)).toMatchObject({ ok: false, reason: "read_error" });
  });

  test("refuses an occupied config when access is denied", () => {
    const cfg = home.path("config.json");
    writeFileSync(cfg, "{}");
    const denied: typeof openSync = () => { throw Object.assign(new Error("synthetic denial"), { code: "EACCES" }); };
    expect(runConfigPreflight(cfg, denied)).toMatchObject({ ok: false, reason: "read_error" });
    expect(readFileSync(cfg, "utf8")).toBe("{}");
  });

  test("uses the opened target descriptor when open resolves a simulated link", () => {
    const cfg = home.path("config.json");
    const target = home.path("target.json");
    writeFileSync(cfg, "not a config");
    writeFileSync(target, "{}");
    const open: typeof openSync = (path, flags, mode) => {
      expect(path).toBe(cfg);
      return openSync(target, flags, mode);
    };
    expect(runConfigPreflight(cfg, open)).toEqual({ ok: true });
    expect(readFileSync(cfg, "utf8")).toBe("not a config");
  });

  test("refuses an entry that becomes occupied before a simulated missing-target error", () => {
    const cfg = home.path("config.json");
    const open: typeof openSync = () => {
      writeFileSync(cfg, "occupied");
      throw Object.assign(new Error("simulated missing target"), { code: "ENOENT" });
    };
    expect(runConfigPreflight(cfg, open)).toMatchObject({ ok: false, reason: "read_error" });
    expect(readFileSync(cfg, "utf8")).toBe("occupied");
  });

  test("passes when config.json does not exist yet (clean install)", () => {
    const cfg = home.path("config.json");
    expect(readConfigDiagnostics({ passive: true }).source).toBe("default");
    const result = runConfigPreflight(cfg);
    expect(result.ok).toBe(true);
  });

  test("passes and does not abort for reparable configs (omitted defaultProvider)", () => {
    const cfg = home.path("config.json");
    writeFileSync(cfg, JSON.stringify({
      providers: { mock: { adapter: "openai-chat", baseUrl: "https://api.example.com/v1" } },
    }), "utf8");

    const result = runConfigPreflight(cfg);
    expect(result.ok).toBe(true);
  });

  test("passes and does not abort for reparable configs (empty hostname degraded)", () => {
    const cfg = home.path("config.json");
    writeFileSync(cfg, JSON.stringify({
      hostname: "",
      defaultProvider: "mock",
      providers: { mock: { adapter: "openai-chat", baseUrl: "https://api.example.com/v1" } },
    }), "utf8");

    const result = runConfigPreflight(cfg);
    expect(result.ok).toBe(true);
  });

  test("fails closed when config.json has invalid JSON syntax", () => {
    const cfg = home.path("config.json");
    writeFileSync(cfg, "{ port: 10100, invalid json", "utf8");

    const result = runConfigPreflight(cfg);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("fallback");
  });

  test("reads the specified config rather than the current home config", () => {
    writeFileSync(home.path("config.json"), "{}", "utf8");
    const other = home.path("other.json");
    writeFileSync(other, "not json", "utf8");
    expect(runConfigPreflight(other)).toMatchObject({ ok: false, reason: "fallback" });
  });

  test.skipIf(!canSymlink)("accepts a symlink to a readable regular config", () => {
    const target = home.path("target.json");
    writeFileSync(target, "{}", "utf8");
    const link = home.path("config.json");
    symlinkSync(target, link, "file");
    expect(readConfigDiagnostics({ passive: true }).source).toBe("file");
    expect(runConfigPreflight(link).ok).toBe(true);
  });

  test("rejects a directory at the config path", () => {
    const path = home.path("config.json");
    mkdirSync(path);
    expect(runConfigPreflight(path)).toMatchObject({ ok: false, reason: "read_error" });
  });

  test.skipIf(!canSymlink)("rejects a config replaced by a dangling link just before open", () => {
    const cfg = home.path("config.json");
    writeFileSync(cfg, "{}", "utf8");
    const run = runConfigPreflight as (path: string, open: typeof openSync) => ReturnType<typeof runConfigPreflight>;
    const open: typeof openSync = (path, flags, mode) => {
      unlinkSync(cfg);
      symlinkSync(home.path("missing-target.json"), cfg, "file");
      return openSync(path, flags, mode);
    };
    expect(run(cfg, open)).toMatchObject({ ok: false, reason: "read_error" });
  });

  test("passively projects a retired provider without writing a backup", () => {
    const cfg = home.path("config.json");
    const raw = JSON.stringify({ providers: { "opencode-free": { apiKey: "synthetic-value", baseUrl: "https://example.test/v1" } } });
    writeFileSync(cfg, raw, "utf8");
    const before = readdirSync(home.root);
    const result = runConfigPreflight(cfg);
    expect(result.ok).toBe(true);
    expect(JSON.stringify(result)).not.toContain("synthetic-value");
    expect(readFileSync(cfg, "utf8")).toBe(raw);
    expect(readdirSync(home.root)).toEqual(before);
  });

  test.skipIf(!canSymlink)("fails closed when config.json is an occupied entry that cannot be read (dangling symlink)", () => {
    const target = home.path("target-does-not-exist.json");
    const cfg = home.path("config.json");
    symlinkSync(target, cfg);

    const result = runConfigPreflight(cfg);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("read_error");
  });

  test("update entry aborts with exit code 1 before stop when config preflight fails", async () => {
    const updateSource = readFileSync(join(repoRoot, "src", "update", "index.ts"), "utf8");
    const start = updateSource.indexOf("  const configPath = getConfigPath(), configPreflight = runConfigPreflight(configPath);");
    const end = updateSource.indexOf("  if (session) {", start);
    const stopStart = updateSource.indexOf("    const stop = guardedSpawnSync(", end);
    const stopEnd = updateSource.indexOf("    if (stopStdio ===", stopStart);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    expect(stopStart).toBeGreaterThan(end);
    expect(stopEnd).toBeGreaterThan(stopStart);

    const stops: string[] = [];
    const errors: string[] = [];

    const runGate = updateSourceFunction("deps", `with (deps) { return (async () => {
      ${updateSource.slice(start, end)}
      const stopStdio = "ignore";
      ${updateSource.slice(stopStart, stopEnd)}
      return 0;
    })(); }`);

    // Case A: Preflight fails with fallback
    writeFileSync(home.path("config.json"), "synthetic-value not json", "utf8");
    const failingResult = await runGate({
      getConfigPath: () => home.path("config.json"),
      runConfigPreflight: (path: string) => { expect(path).toBe(home.path("config.json")); return runConfigPreflight(path); },
      console: { error: (msg: string) => errors.push(msg) },
      spawnSync: () => stops.push("stop"),
    });

    expect(failingResult).toBe(1);
    expect(stops).toEqual([]);
    expect(errors.some(e => e.includes("Configuration preflight failed"))).toBe(true);
    expect(errors.join("\n")).not.toContain("synthetic-value");
    expect(errors.join("\n")).toContain("Run 'ocx config validate' to diagnose");
    expect(errors.join("\n")).toContain("does not change the file");

    // A schema-invalid routing profile is salvageable at runtime but must not reach stop.
    const raw = JSON.stringify({ providers: { mock: { adapter: "openai-chat", baseUrl: "https://example.test/v1" } },
      routingProfiles: { bad: { candidates: [] } }, secretMarker: "synthetic-profile-secret" });
    expect(configDiagnosticsFromRaw(raw).source).toBe("fallback");
    writeFileSync(home.path("config.json"), raw, "utf8");
    expect(readConfigDiagnostics({ passive: true }).source).toBe("fallback");
    expect(() => readCliConfigForMutation({ passive: true })).toThrow();
    const before = readdirSync(home.root);
    const salvageResult = await runGate({
      getConfigPath: () => home.path("config.json"), runConfigPreflight,
      console: { error: (msg: string) => errors.push(msg), log: () => {} },
      homePolicy: { serviceAllowed: true, authorizeMutation: () => true },
      isServiceInstalled: () => false,
      createSupervisionLatch: () => ({ observe: () => {} }),
      inspectDesktopSupervision: () => ({ kind: "none" }),
      resolvedRuntimeOwnership: async () => ({ ownership: null }),
      planUpdateRuntimeHandling: () => ({ mayReplacePackage: true }),
      spawnSync: () => { stops.push("stop"); return { status: 0 }; },
      selfLaunchArgv: (args: string[]) => args,
      mutation: { controlEnvironment: () => ({}) },
    });
    expect(salvageResult).toBe(1);
    expect(stops).toEqual([]);
    expect(errors.join("\n")).not.toContain("synthetic-profile-secret");
    expect(readFileSync(home.path("config.json"), "utf8")).toBe(raw);
    expect(readdirSync(home.root)).toEqual(before);

    // The runtime loader repairs this alias, but passive diagnostics and mutation refuse it.
    writeFileSync(home.path("config.json"), JSON.stringify({ providers: { mock: { adapter: "openai-chat", baseUrl: "https://example.test/v1", alias: 42 } } }));
    expect(readConfigDiagnostics({ passive: true }).source).toBe("fallback");
    expect(() => readCliConfigForMutation({ passive: true })).toThrow();
    const aliasResult = await runGate({ getConfigPath: () => home.path("config.json"), runConfigPreflight,
      console: { error: (msg: string) => errors.push(msg), log: () => {} },
      homePolicy: { serviceAllowed: true, authorizeMutation: () => true },
      isServiceInstalled: () => false, createSupervisionLatch: () => ({ observe: () => {} }),
      inspectDesktopSupervision: () => ({ kind: "none" }),
      resolvedRuntimeOwnership: async () => ({ ownership: null }),
      planUpdateRuntimeHandling: () => ({ mayReplacePackage: true }),
      spawnSync: () => { stops.push("stop"); return { status: 0 }; },
      selfLaunchArgv: (args: string[]) => args, mutation: { controlEnvironment: () => ({}) } });
    expect(aliasResult).toBe(1);
    expect(stops).toEqual([]);

    // Case B: Preflight passes (positive control)
    writeFileSync(home.path("config.json"), "{}", "utf8");
    const passingResult = await runGate({
      getConfigPath: () => home.path("config.json"),
      runConfigPreflight,
      console: { error: (msg: string) => errors.push(msg), log: () => {} },
      homePolicy: { serviceAllowed: true, authorizeMutation: () => true },
      isServiceInstalled: () => false,
      createSupervisionLatch: () => ({ observe: () => {} }),
      inspectDesktopSupervision: () => ({ kind: "none" }),
      resolvedRuntimeOwnership: async () => ({ ownership: null }),
      planUpdateRuntimeHandling: () => ({ mayReplacePackage: true }),
      spawnSync: (_exe: string, args: string[]) => { stops.push(args.join(" ")); return { status: 0 }; },
      selfLaunchArgv: (args: string[]) => args,
      mutation: { controlEnvironment: () => ({}) },
    });

    expect(passingResult).toBe(0);
    expect(stops).toEqual(["stop"]);

    const cases = [
      { raw: JSON.stringify({ port: -1 }), source: "fallback", stop: false },
      { raw: JSON.stringify({ providers: { mock: { adapter: "openai-chat", baseUrl: "https://example.test/v1" } } }), source: "file", stop: true },
      { raw: JSON.stringify({ hostname: "" }), source: "file", stop: true },
      { raw: null, source: "default", stop: true },
    ];
    for (const item of cases) {
      const path = home.path("config.json");
      if (item.raw === null) unlinkSync(path); else writeFileSync(path, item.raw);
      expect(readConfigDiagnostics({ passive: true }).source).toBe(item.source);
      stops.length = 0;
      const code = await runGate({ getConfigPath: () => path, runConfigPreflight,
        console: { error: (msg: string) => errors.push(msg), log: () => {} },
        homePolicy: { serviceAllowed: true, authorizeMutation: () => true },
        isServiceInstalled: () => false, createSupervisionLatch: () => ({ observe: () => {} }),
        inspectDesktopSupervision: () => ({ kind: "none" }),
        resolvedRuntimeOwnership: async () => ({ ownership: null }),
        planUpdateRuntimeHandling: () => ({ mayReplacePackage: true }),
        spawnSync: () => { stops.push("stop"); return { status: 0 }; },
        selfLaunchArgv: (args: string[]) => args, mutation: { controlEnvironment: () => ({}) } });
      expect(code).toBe(item.stop ? 0 : 1);
      expect(stops).toEqual(item.stop ? ["stop"] : []);
    }
    if (canSymlink) {
      const target = home.path("target.json");
      writeFileSync(target, "{}");
      symlinkSync(target, home.path("config.json"), "file");
      expect(readConfigDiagnostics({ passive: true }).source).toBe("file");
      stops.length = 0;
      const code = await runGate({ getConfigPath: () => home.path("config.json"), runConfigPreflight,
        console: { error: (msg: string) => errors.push(msg), log: () => {} },
        homePolicy: { serviceAllowed: true, authorizeMutation: () => true },
        isServiceInstalled: () => false, createSupervisionLatch: () => ({ observe: () => {} }),
        inspectDesktopSupervision: () => ({ kind: "none" }),
        resolvedRuntimeOwnership: async () => ({ ownership: null }),
        planUpdateRuntimeHandling: () => ({ mayReplacePackage: true }),
        spawnSync: () => { stops.push("stop"); return { status: 0 }; },
        selfLaunchArgv: (args: string[]) => args, mutation: { controlEnvironment: () => ({}) } });
      expect(code).toBe(0);
      expect(stops).toEqual(["stop"]);
    }
  });

  test("update refusal gives recovery guidance for an occupied unreadable path", async () => {
    const source = readFileSync(join(repoRoot, "src", "update", "index.ts"), "utf8");
    const start = source.indexOf("  const configPath = getConfigPath(), configPreflight = runConfigPreflight(configPath);");
    const end = source.indexOf("  // Remember whether a background service", start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const runGate = updateSourceFunction("deps", `with (deps) { return (async () => {
      ${source.slice(start, end)}
      throw new Error("preflight did not refuse");
    })(); }`);
    const paths: string[] = [];
    if (canSymlink) {
      const link = home.path("dangling-config");
      symlinkSync(home.path("missing-target.json"), link, "file");
      paths.push(link);
    }
    const directory = home.path("directory-config");
    mkdirSync(directory);
    paths.push(directory);
    for (const path of paths) {
      const errors: string[] = [];
      expect(await runGate({ getConfigPath: () => path, runConfigPreflight,
        console: { error: (message: string) => errors.push(message) } })).toBe(1);
      const guidance = errors.join("\n");
      expect(guidance).toContain(path);
      expect(guidance).toContain("symlink");
      expect(guidance).toContain("permissions");
      expect(guidance).toContain("restore");
      expect(guidance).toContain("ocx config validate");
      expect(guidance).toContain("may report defaults");
      expect(guidance).not.toContain("inspect and repair configuration issues");
    }
  });
});
