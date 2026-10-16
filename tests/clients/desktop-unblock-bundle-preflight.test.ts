import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chatgptWatcherBundleProblem, type WatcherBundlePreflightDeps } from "../../src/chatgpt/desktop-unblock/bundle-preflight";
import { buildChatgptUnblockWatcherScript } from "../../src/chatgpt/desktop-unblock/launch-watcher";
import { helperPath, repoPath } from "../helpers/repo-root";
import { maybeAutoRestoreCodexShim } from "../../src/cli/codex-shim-autorestore";

const ROOT = "/Applications/Other installs/ChatGPT.app";
const deps: WatcherBundlePreflightDeps = { platform: "darwin", trustReason: () => null, bundleIdentifier: () => "com.openai.codex" };

describe("watcher bundle preflight", () => {
  test("hidden preflight never reads config or repairs the Codex shim", () => {
    const unexpected = () => { throw new Error("read-only preflight reached automatic repair"); };
    expect(() => maybeAutoRestoreCodexShim("internal", ["internal", "chatgpt-bundle-preflight", ROOT], {
      env: {}, warn: unexpected, restore: unexpected, readConfig: unexpected,
    })).not.toThrow();
  });
  test("reuses the shared bundle trust policy on the exact recorded path", () => {
    const paths: string[] = [];
    expect(chatgptWatcherBundleProblem(ROOT, { ...deps, trustReason(path) { paths.push(path); return null; } })).toBeNull();
    expect(paths).toEqual([ROOT]);
  });
  for (const reason of ["is missing", "is writable by group or others", "failed code-signature verification", "is not signed by OpenAI"]) {
    test(`refuses a changed bundle: ${reason}`, () => {
      expect(chatgptWatcherBundleProblem(ROOT, { ...deps, trustReason: () => reason })).toBe(reason);
    });
  }
  for (const path of ["ChatGPT.app", "/Applications/../tmp/ChatGPT.app", "/Applications//ChatGPT.app"]) {
    test(`refuses a noncanonical path: ${path}`, () => {
      expect(chatgptWatcherBundleProblem(path, { ...deps, trustReason() { throw new Error("must not inspect"); } })).toContain("absolute and normalized");
    });
  }
  for (const id of [null, "com.openai.chat", "com.example.codex"]) {
    test(`refuses missing or substituted identity: ${id}`, () => {
      expect(chatgptWatcherBundleProblem(ROOT, { ...deps, bundleIdentifier: () => id })).toContain("not com.openai.codex");
    });
  }
  test("unsupported platforms fail before inspecting a bundle", () => {
    expect(chatgptWatcherBundleProblem(ROOT, { ...deps, platform: "linux", trustReason() { throw new Error("must not inspect"); } })).toContain("only supported on macOS");
  });
  test("source-mode watcher re-enters the canonical CLI instead of the caller's script", () => {
    const script = buildChatgptUnblockWatcherScript(10300, "/tmp/ocx-preflight");
    expect(script).toContain(repoPath("src/cli/index.ts"));
    expect(script).toContain("'internal' 'chatgpt-bundle-preflight'");
    expect(script).not.toContain("open -a ChatGPT");
    expect(script).not.toContain("quit app \"ChatGPT\"");
  });
});

describe("CLI passes the discovered bundle to the intercept", () => {
  for (const sub of ["launch", "install-watcher"]) {
    test(`${sub} binds the exact discovered path`, () => {
      const dir = mkdtempSync(join(tmpdir(), "ocx-watcher-bundle-"));
      try {
        const child = spawnSync(process.execPath, [helperPath("desktop-app-server-shim-command-child.ts"), dir, JSON.stringify({ sub, intercept: true })], {
          encoding: "utf8", timeout: 15000, env: { ...process.env, OPENCODEX_HOME: dir },
        });
        expect({ status: child.status, stderr: child.stderr }).toEqual({ status: 0, stderr: "" });
        const result = JSON.parse(child.stdout.trim().split("\n").at(-1)!);
        expect(result.code).toBe(0);
        expect(result.calls.find((call: { command: string }) => call.command === (sub === "launch" ? "intercept-launch" : "watcher-install"))?.args).toEqual([result.root]);
      } finally { rmSync(dir, { recursive: true, force: true }); }
    });
  }
});
