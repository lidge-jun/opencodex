import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeCodeCliInstalled, reconcileShellHook } from "../src/server/system-env";

const originalPlatform = process.platform;
let originalHome: string | undefined;
let originalPath: string | undefined;
let root = "";
let binDir = "";
let zshrcPath = "";

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", { configurable: true, value: platform });
}

function installClaudeCli(): void {
  const executable = join(binDir, "claude");
  writeFileSync(executable, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  chmodSync(executable, 0o755);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ocx-claude-hook-"));
  binDir = join(root, "bin");
  zshrcPath = join(root, ".zshrc");
  mkdirSync(binDir);
  originalHome = process.env.HOME;
  originalPath = process.env.PATH;
  process.env.HOME = root;
  process.env.PATH = binDir;
  setPlatform("darwin");
});

afterEach(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalPath === undefined) delete process.env.PATH;
  else process.env.PATH = originalPath;
  setPlatform(originalPlatform);
  rmSync(root, { recursive: true, force: true });
});

describe("Claude Code shell-hook reconciliation", () => {
  test("does not create .zshrc when Claude Code is absent", () => {
    expect(claudeCodeCliInstalled()).toBe(false);
    expect(reconcileShellHook(true)).toMatchObject({ changed: false, state: "absent" });
    expect(existsSync(zshrcPath)).toBe(false);
  });

  test("removes only the stale OpenCodex hook when Claude Code is absent", () => {
    writeFileSync(zshrcPath, [
      "export USER_SETTING=1",
      "# opencodex claude-env hook",
      "[ -f ~/.opencodex/claude-env.sh ] && source ~/.opencodex/claude-env.sh",
      "alias keep-me='yes'",
      "",
    ].join("\n"));

    expect(reconcileShellHook(true)).toEqual({
      changed: true,
      state: "absent",
      reason: "Claude Code not installed",
    });
    const content = readFileSync(zshrcPath, "utf8");
    expect(content).toContain("export USER_SETTING=1");
    expect(content).toContain("alias keep-me='yes'");
    expect(content).not.toContain("opencodex claude-env hook");
    expect(content).not.toContain("claude-env.sh");
  });

  test("installs the hook only for an executable Claude Code CLI and stays idempotent", () => {
    installClaudeCli();
    expect(claudeCodeCliInstalled()).toBe(true);
    expect(reconcileShellHook(true)).toEqual({ changed: true, state: "installed" });
    expect(reconcileShellHook(true)).toEqual({
      changed: false,
      state: "installed",
      reason: "already installed",
    });
    expect(readFileSync(zshrcPath, "utf8").match(/opencodex claude-env hook/g)).toHaveLength(1);
  });

  test("does not treat a non-executable claude file as an installed CLI", () => {
    writeFileSync(join(binDir, "claude"), "#!/bin/sh\nexit 0\n", { mode: 0o644 });

    expect(claudeCodeCliInstalled()).toBe(false);
    expect(reconcileShellHook(true)).toMatchObject({ changed: false, state: "absent" });
    expect(existsSync(zshrcPath)).toBe(false);
  });

  test("removes the hook when system environment integration is inactive", () => {
    installClaudeCli();
    reconcileShellHook(true);

    expect(reconcileShellHook(false)).toEqual({
      changed: true,
      state: "absent",
      reason: "system environment inactive",
    });
    expect(readFileSync(zshrcPath, "utf8")).not.toContain("opencodex claude-env hook");
  });

  test("ignores empty PATH segments instead of trusting a workspace-local claude file", () => {
    writeFileSync(join(root, "claude"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    process.env.PATH = `:${binDir}`;

    expect(claudeCodeCliInstalled()).toBe(false);
  });

  test("start and ensure reconcile the hook from the actual injection result", async () => {
    const source = await Bun.file(new URL("../src/cli/index.ts", import.meta.url)).text();

    expect(source).not.toMatch(/\n\s*installShellHook\(\);/);
    expect(source.match(/reconcileShellHook\(systemEnv\.injected\)/g)).toHaveLength(2);
  });
});
