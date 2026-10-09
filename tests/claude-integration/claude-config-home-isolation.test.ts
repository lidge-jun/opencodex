/**
 * #6775: a bare `bun test` pruned the developer's real ~/.claude/agents/ocx-*.md.
 *
 * The preload rewrites HOME after Bun has started, and Bun's os.homedir() keeps the home it
 * read at startup, so `claudeConfigDir()` resolved the real directory whenever
 * CLAUDE_CONFIG_DIR was unset. Three layers close that: the sandbox pins the client homes,
 * `claudeConfigDir()` follows the current platform home variable, and the armed guard
 * refuses Claude writes into the real directory. Each layer has its own case here so one
 * cannot silently stand in for another.
 */
import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, relative } from "node:path";
import { createIsolatedTestEnvironment } from "../../scripts/test";
import { claudeConfigDir, currentUserHome } from "../../src/claude/gateway-cache";
import { protectedClaudeConfigDirsForTests } from "../../src/lib/test-home-guard";
import { repoPath, repoRoot } from "../helpers/repo-root";

const HOME_ENV = ["HOME", "USERPROFILE", "CLAUDE_CONFIG_DIR"] as const;

function isWithin(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !rel.startsWith("/") && !/^[A-Za-z]:/.test(rel));
}

test("the sandbox pins client homes and hands the real Claude directory to the guard", () => {
  const isolated = createIsolatedTestEnvironment({
    OCX_REAL_HOME: join(tmpdir(), "real-home-sentinel"),
    CLAUDE_CONFIG_DIR: join(tmpdir(), "inherited-claude"),
    GROK_HOME: join(tmpdir(), "inherited-grok"),
  });
  try {
    expect(isolated.env.CLAUDE_CONFIG_DIR).toBe(join(isolated.root, ".claude"));
    expect(isolated.env.GROK_HOME).toBe(join(isolated.root, ".grok"));
    expect(isolated.env.OCX_REAL_CLAUDE_CONFIG_DIR).toBe(join(tmpdir(), "inherited-claude"));
  } finally {
    isolated.cleanup();
  }
});

test("without an inherited override the guard is handed the real home's .claude", () => {
  const isolated = createIsolatedTestEnvironment({ OCX_REAL_HOME: join(tmpdir(), "real-home-sentinel") });
  try {
    expect(isolated.env.OCX_REAL_CLAUDE_CONFIG_DIR).toBe(join(tmpdir(), "real-home-sentinel", ".claude"));
  } finally {
    isolated.cleanup();
  }
});

test("a nested sandbox keeps the outer hand-off instead of the outer sandbox", () => {
  const outer = createIsolatedTestEnvironment({
    OCX_REAL_HOME: join(tmpdir(), "real-home-sentinel"),
    CLAUDE_CONFIG_DIR: join(tmpdir(), "developer-claude"),
  });
  try {
    const inner = createIsolatedTestEnvironment(outer.env);
    try {
      expect(inner.env.OCX_REAL_CLAUDE_CONFIG_DIR).toBe(join(tmpdir(), "developer-claude"));
      expect(inner.env.CLAUDE_CONFIG_DIR).toBe(join(inner.root, ".claude"));
    } finally {
      inner.cleanup();
    }
  } finally {
    outer.cleanup();
  }
});

test("this test process runs with a sandboxed Claude config directory", () => {
  const configured = process.env.CLAUDE_CONFIG_DIR;
  expect(configured).toBeTruthy();
  const resolved = existsSync(configured!) ? realpathSync.native(configured!) : configured!;
  for (const protectedDir of protectedClaudeConfigDirsForTests()) {
    expect(isWithin(protectedDir, resolved)).toBe(false);
  }
});

test("claudeConfigDir follows a HOME rewritten after startup", () => {
  const previous = Object.fromEntries(HOME_ENV.map(name => [name, process.env[name]]));
  const sandbox = mkdtempSync(join(tmpdir(), "ocx-claude-calltime-"));
  try {
    delete process.env.CLAUDE_CONFIG_DIR;
    process.env.HOME = sandbox;
    process.env.USERPROFILE = sandbox;
    expect(claudeConfigDir()).toBe(join(sandbox, ".claude"));
  } finally {
    for (const name of HOME_ENV) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
  }
});

test("currentUserHome reads the variable the platform's Node runtime reads", () => {
  const env = { HOME: "/posix-home", USERPROFILE: "C:\\Users\\windows-home" };
  expect(currentUserHome(env, "linux")).toBe("/posix-home");
  expect(currentUserHome(env, "darwin")).toBe("/posix-home");
  expect(currentUserHome(env, "win32")).toBe("C:\\Users\\windows-home");
  expect(currentUserHome({ HOME: "" }, "linux")).toBe(homedir());
  expect(currentUserHome({}, "win32")).toBe(homedir());
});

test("an armed guard refuses Claude agent sync and cache writes into the real directory", () => {
  // The "real home" here is a disposable sentinel handed to a child at startup, the same way
  // scripts/test.ts hands over the developer's home. Nothing outside the sandbox is touched.
  const isolated = createIsolatedTestEnvironment();
  const sentinelHome = join(isolated.root, "sentinel-home");
  const realClaude = join(sentinelHome, ".claude");
  const probe = join(realClaude, "agents", "ocx-guard-probe.md");
  const otherClaude = join(isolated.root, "fixture-claude");
  mkdirSync(join(realClaude, "agents"), { recursive: true });
  writeFileSync(probe, "---\nname: \"ocx-guard-probe\"\nmodel: \"x\"\n---\n\n<!-- generated-by: opencodex -->\n");
  const code = `
    const { syncClaudeAgentDefs } = await import(${JSON.stringify(repoPath("src", "claude", "agents-inject.ts"))});
    const { writeGatewayModelCache } = await import(${JSON.stringify(repoPath("src", "claude", "gateway-cache.ts"))});
    const refusals = [];
    for (const attempt of [
      () => syncClaudeAgentDefs([], ${JSON.stringify(realClaude)}),
      () => writeGatewayModelCache("http://127.0.0.1:1", [{ id: "claude-x" }], ${JSON.stringify(realClaude)}),
    ]) {
      try { attempt(); refusals.push(false); }
      catch (error) { refusals.push(/real Claude config directory/.test(String(error))); }
    }
    const fixtureWrite = writeGatewayModelCache("http://127.0.0.1:1", [{ id: "claude-x" }], ${JSON.stringify(otherClaude)});
    console.log(JSON.stringify({ refusals, fixtureWrite: fixtureWrite !== null }));
  `;
  try {
    const child = Bun.spawnSync([process.execPath, "-e", code], {
      cwd: repoRoot(),
      env: {
        ...isolated.env,
        OCX_TEST_HOME_GUARD: "1",
        OCX_REAL_HOME: sentinelHome,
        OCX_REAL_CLAUDE_CONFIG_DIR: realClaude,
        CLAUDE_CONFIG_DIR: realClaude,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const stderr = new TextDecoder().decode(child.stderr);
    expect({ exitCode: child.exitCode, stderr: child.exitCode === 0 ? "" : stderr }).toEqual({ exitCode: 0, stderr: "" });
    const lines = new TextDecoder().decode(child.stdout).trim().split("\n");
    expect(JSON.parse(lines.at(-1)!)).toEqual({ refusals: [true, true], fixtureWrite: true });
    expect(existsSync(probe)).toBe(true);
    expect(existsSync(join(realClaude, "cache", "gateway-models.json"))).toBe(false);
  } finally {
    isolated.cleanup();
  }
});

