import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { symlinkSync, writeFileSync } from "node:fs";
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
    const start = updateSource.indexOf("  const configPreflight = runConfigPreflight(getConfigPath());");
    const end = updateSource.indexOf("  if (session) {", start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);

    let stopCalled = false;
    const errors: string[] = [];

    const runGate = updateSourceFunction("deps", `with (deps) { return (async () => {
      ${updateSource.slice(start, end)}
      stopCalled = true;
      return 0;
    })(); }`);

    // Case A: Preflight fails with fallback
    const failingResult = await runGate({
      getConfigPath: () => home.path("config.json"),
      runConfigPreflight: () => ({ ok: false, reason: "fallback", error: "syntax error" }),
      console: { error: (msg: string) => errors.push(msg) },
      stopCalled: false,
    });

    expect(failingResult).toBe(1);
    expect(stopCalled).toBe(false);
    expect(errors.some(e => e.includes("Configuration preflight failed"))).toBe(true);

    // Case B: Preflight passes (positive control)
    let positiveStopReached = false;
    const passingResult = await runGate({
      getConfigPath: () => home.path("config.json"),
      runConfigPreflight: () => ({ ok: true }),
      console: { error: (msg: string) => errors.push(msg), log: () => {} },
      homePolicy: { serviceAllowed: true },
      isServiceInstalled: () => false,
      createSupervisionLatch: () => ({ observe: () => {} }),
      inspectDesktopSupervision: () => ({ kind: "none" }),
      resolvedRuntimeOwnership: async () => ({ ownership: null }),
      planUpdateRuntimeHandling: () => ({ mayReplacePackage: true }),
      stopCalled: false,
    });

    expect(passingResult).toBe(0);
  });
});
