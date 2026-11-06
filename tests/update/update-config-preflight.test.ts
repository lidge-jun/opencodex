import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, openSync, readdirSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { runConfigPreflight } from "../../src/update/config-preflight";
import { createTempHome, type TempHome } from "../helpers/temp-home";
import { updateSourceFunction } from "../helpers/update-source-body";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { repoRoot as resolveRepoRoot } from "../helpers/repo-root";

const repoRoot = resolveRepoRoot();
let home: TempHome;

beforeEach(() => {
  home = createTempHome("ocx-update-preflight-");
});

afterEach(() => {
  home.remove();
});

describe("update config pre-flight", () => {
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

  test("passes when config.json does not exist yet (clean install)", () => {
    const cfg = home.path("config.json");
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

  test("accepts a symlink to a readable regular config", () => {
    const target = home.path("target.json");
    writeFileSync(target, "{}", "utf8");
    const link = home.path("config.json");
    symlinkSync(target, link, "file");
    expect(runConfigPreflight(link).ok).toBe(true);
  });

  test("rejects a directory at the config path", () => {
    const path = home.path("config.json");
    mkdirSync(path);
    expect(runConfigPreflight(path)).toMatchObject({ ok: false, reason: "read_error" });
  });

  test("rejects a config replaced by a dangling link just before open", () => {
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
    expect(JSON.stringify(result)).not.toContain("synthetic-value");
    expect(readFileSync(cfg, "utf8")).toBe(raw);
    expect(readdirSync(home.root)).toEqual(before);
  });

  test("fails closed when config.json is an occupied entry that cannot be read (dangling symlink)", () => {
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
  });
});
