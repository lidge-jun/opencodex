import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
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

/** Create the smallest executable that represents a Claude Code CLI on PATH. */
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

  // Windows has no execute permission bit: `accessSync(path, X_OK)` succeeds for any
  // readable file, so a 0o644 fixture cannot express "present but not executable" there.
  // The case asserts a POSIX permission semantic, and skipping it on a platform that
  // cannot represent the precondition is honest; asserting it anyway measured the
  // fixture, not the product (#2152).
  test.skipIf(originalPlatform === "win32")(
    "does not treat a non-executable claude file as an installed CLI",
    () => {
      writeFileSync(join(binDir, "claude"), "#!/bin/sh\nexit 0\n", { mode: 0o644 });

      expect(claudeCodeCliInstalled()).toBe(false);
      expect(reconcileShellHook(true)).toMatchObject({ changed: false, state: "absent" });
      expect(existsSync(zshrcPath)).toBe(false);
    },
  );

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

  // A .zshrc with CRLF endings is ordinary on a home directory an editor or another OS has
  // touched. The removal pattern matched LF only, so the file was rewritten unchanged while
  // the caller was told the hook was gone — the worse outcome, because the hook keeps
  // sourcing on every new shell and the reported state says it does not.
  test("removes a CRLF-terminated hook block instead of reporting a false success", () => {
    installClaudeCli();
    reconcileShellHook(true);
    const installed = readFileSync(zshrcPath, "utf8");
    writeFileSync(zshrcPath, installed.replace(/\n/g, "\r\n"), "utf8");

    const result = reconcileShellHook(false);

    expect(readFileSync(zshrcPath, "utf8")).not.toContain("opencodex claude-env hook");
    expect(result.state).toBe("absent");
  });

  test("unrelated CRLF lines survive the removal", () => {
    installClaudeCli();
    writeFileSync(zshrcPath, "export FOO=1\n", "utf8");
    reconcileShellHook(true);
    const installed = readFileSync(zshrcPath, "utf8");
    writeFileSync(zshrcPath, installed.replace(/\n/g, "\r\n"), "utf8");

    reconcileShellHook(false);
    const after = readFileSync(zshrcPath, "utf8");

    expect(after).toContain("export FOO=1");
    expect(after).not.toContain("claude-env.sh");
  });

  test("a marker block this pattern does not own is reported failed, not removed", () => {
    installClaudeCli();
    // The marker is there but the next line is not the block we wrote, so it is not ours to
    // delete. Answering "removed" here would be a claim the user acts on and it would be false.
    writeFileSync(zshrcPath, "# opencodex claude-env hook\n# hand-edited by the user\n", "utf8");

    const result = reconcileShellHook(false);

    expect(result.state).toBe("failed");
    expect(readFileSync(zshrcPath, "utf8")).toContain("hand-edited by the user");
  });

  test("ignores empty PATH segments instead of trusting a workspace-local claude file", () => {
    writeFileSync(join(root, "claude"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    const previousCwd = process.cwd();
    process.chdir(root);
    process.env.PATH = `${delimiter}${binDir}`;

    try {
      expect(claudeCodeCliInstalled()).toBe(false);
    } finally {
      process.chdir(previousCwd);
    }
  });

  test("reports hook-removal failures instead of claiming the hook is absent", () => {
    mkdirSync(zshrcPath);

    expect(reconcileShellHook(false)).toEqual({
      changed: false,
      state: "failed",
      reason: "read/write failed",
    });
  });

  test("start and ensure reconcile the hook from the actual injection result", async () => {
    const source = await Bun.file(new URL("../src/cli/index.ts", import.meta.url)).text();

    expect(source).not.toMatch(/\n\s*installShellHook\(\);/);
    expect(source.match(/reconcileShellHook\(systemEnv\.injected\)/g)).toHaveLength(2);
  });
});
