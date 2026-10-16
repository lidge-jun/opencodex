import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gentleShellPaths } from "../../src/clients/gentle-shell-path";
import { piConfigPath } from "../../src/clients/config-export";
import { removeTreeWithRetry } from "../helpers/remove-tree";

function fixture(run: (home: string, save: (value: unknown) => void) => void): void {
  const home = mkdtempSync(join(tmpdir(), "ocx-gentle-shell-"));
  mkdirSync(join(home, ".gentle-shell"));
  try {
    run(home, value => writeFileSync(join(home, ".gentle-shell", "config.json"), JSON.stringify(value)));
  } finally { removeTreeWithRetry(home); }
}

describe("Gentle Shell persistent home", () => {
  test("defaults to a separate catalog without moving Pi", () => fixture(home => {
    expect(gentleShellPaths({}, home)).toEqual({
      configPath: join(home, ".gentle-shell", "agent", "models.json"),
      detectDir: join(home, ".gentle-shell", "agent"),
    });
    expect(piConfigPath({}, home)).toBe(join(home, ".pi", "agent", "models.json"));
  }));

  test("saved path wins over isolated override; saved isolated honors it", () => fixture((home, save) => {
    const env = { GENTLE_SHELL_HOME: join(home, "isolated") };
    save({ home: join(home, "custom") });
    expect(gentleShellPaths(env, home).detectDir).toBe(join(home, "custom"));
    save({ home: "isolated" });
    expect(gentleShellPaths(env, home).detectDir).toBe(env.GENTLE_SHELL_HOME);
  }));

  test("honors the launcher config override and malformed-config fallback", () => fixture(home => {
    const config = join(home, "launcher.json");
    const env = { GENTLE_SHELL_CONFIG: config };
    writeFileSync(config, JSON.stringify({ home: join(home, "selected") }));
    expect(gentleShellPaths(env, home).detectDir).toBe(join(home, "selected"));
    writeFileSync(config, "{broken");
    expect(gentleShellPaths(env, home).detectDir).toBe(join(home, ".gentle-shell", "agent"));
  }));

  test("refuses link mode, Pi destinations, and cwd-dependent selectors", () => fixture((home, save) => {
    save({ home: "link" });
    expect(() => gentleShellPaths({}, home)).toThrow("Pi integration");
    save({ home: join(home, ".pi", "agent") });
    expect(() => gentleShellPaths({}, home)).toThrow("Pi integration");
    save({ home: "relative" });
    expect(() => gentleShellPaths({}, home)).toThrow("absolute path");
    save({ home: "isolated" });
    expect(() => gentleShellPaths({ GENTLE_SHELL_HOME: "~/agent" }, home)).toThrow("absolute path");
    expect(() => gentleShellPaths({ GENTLE_SHELL_CONFIG: "relative.json" }, home)).toThrow("absolute path");
    expect(() => gentleShellPaths({ GENTLE_SHELL_HOME: join(home, "pi"), GENTLE_SHELL_USER_PI_HOME: join(home, "pi") }, home)).toThrow("Pi integration");
    expect(() => gentleShellPaths({ GENTLE_SHELL_HOME: join(home, "pi"), PI_CODING_AGENT_DIR: join(home, "pi") }, home)).toThrow("Pi integration");
  }));

  test("refuses a directory alias of Pi even before models.json exists", () => fixture(home => {
    const pi = join(home, ".pi", "agent");
    mkdirSync(pi, { recursive: true });
    const alias = join(home, "alias");
    symlinkSync(pi, alias, process.platform === "win32" ? "junction" : "dir");
    expect(() => gentleShellPaths({ GENTLE_SHELL_HOME: alias }, home)).toThrow("Pi integration");
  }));

  test("unreadable bootstrap is uncertainty, never missing", () => fixture(home => {
    expect(() => gentleShellPaths({}, home, { readText: () => ({ kind: "failed" }) })).toThrow("Cannot read");
    expect(gentleShellPaths({}, home, { readText: () => ({ kind: "missing" }) }).detectDir)
      .toBe(join(home, ".gentle-shell", "agent"));
  }));
});
