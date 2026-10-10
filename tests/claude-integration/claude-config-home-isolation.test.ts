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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
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

test("an armed guard refuses every Claude writer that resolves into the real directory", () => {
  // The "real home" here is a disposable sentinel handed to a child at startup, the same way
  // scripts/test.ts hands over the developer's home. Nothing outside the sandbox is touched.
  const isolated = createIsolatedTestEnvironment();
  const sentinelHome = join(isolated.root, "sentinel-home");
  const realClaude = join(sentinelHome, ".claude");
  const probe = join(realClaude, "agents", "ocx-guard-probe.md");
  const catalog = join(realClaude, "cache", "model-catalog", "probe-cc.json");
  const fixtureClaude = join(isolated.root, "fixture-claude");
  // A sandbox directory whose agents/cache children are links into the real directory.
  const linkedClaude = join(isolated.root, "linked-claude");
  mkdirSync(join(realClaude, "agents"), { recursive: true });
  mkdirSync(join(realClaude, "cache", "model-catalog"), { recursive: true });
  mkdirSync(linkedClaude, { recursive: true });
  writeFileSync(probe, "---\nname: \"ocx-guard-probe\"\nmodel: \"x\"\n---\n\n<!-- generated-by: opencodex -->\n");
  writeFileSync(catalog, "{}");
  const linkType = process.platform === "win32" ? "junction" : "dir";
  symlinkSync(join(realClaude, "agents"), join(linkedClaude, "agents"), linkType);
  symlinkSync(join(realClaude, "cache"), join(linkedClaude, "cache"), linkType);
  // On case-insensitive platforms another spelling names the same directory, including a
  // developer override that does not exist yet when the guard loads.
  const foldsCase = process.platform === "darwin" || process.platform === "win32";
  const caseAlias = foldsCase ? join(sentinelHome, ".CLAUDE") : realClaude;
  const absentOverride = join(sentinelHome, "Custom-Claude");
  const absentAlias = foldsCase ? join(sentinelHome, "custom-claude") : absentOverride;
  // A fixture directory whose cache FILE links to the real cache file.
  const fileLinkedClaude = join(isolated.root, "file-linked-claude");
  const realCacheFile = join(realClaude, "cache", "gateway-models.json");
  mkdirSync(join(fileLinkedClaude, "cache"), { recursive: true });
  writeFileSync(realCacheFile, "original");
  // A Windows account without the symlink privilege cannot build this case; it then expects
  // the ordinary unrefused write into the fixture.
  let fileLinkBuilt = true;
  try {
    symlinkSync(realCacheFile, join(fileLinkedClaude, "cache", "gateway-models.json"), "file");
  } catch (error) {
    if (process.platform !== "win32") throw error;
    fileLinkBuilt = false;
  }
  const modules = {
    agents: repoPath("src", "claude", "agents-inject.ts"),
    cache: repoPath("src", "claude", "gateway-cache.ts"),
    catalog: repoPath("src", "claude", "intercept", "cli-catalog.ts"),
    settings: repoPath("src", "claude", "intercept", "settings.ts"),
    guard: repoPath("src", "lib", "test-home-guard.ts"),
  };
  const code = `
    const m = ${JSON.stringify(modules)};
    const { syncClaudeAgentDefs } = await import(m.agents);
    const { writeGatewayModelCache } = await import(m.cache);
    const { invalidateClaudeCodeServedCatalog } = await import(m.catalog);
    const { applyClaudeInterceptSettings, buildClaudeInterceptEnv } = await import(m.settings);
    const { protectedRemovalReason } = await import(m.guard);
    const real = ${JSON.stringify(realClaude)}, linked = ${JSON.stringify(linkedClaude)};
    const alias = ${JSON.stringify(caseAlias)}, fixture = ${JSON.stringify(fixtureClaude)};
    const absentAlias = ${JSON.stringify(absentAlias)};
    const fileLinked = ${JSON.stringify(fileLinkedClaude)};
    const env = buildClaudeInterceptEnv(1, "/tmp/ca.pem", "token");
    const attempts = {
      agents: () => syncClaudeAgentDefs([], real),
      agentsThroughLink: () => syncClaudeAgentDefs([], linked),
      cache: () => writeGatewayModelCache("http://127.0.0.1:1", [{ id: "claude-x" }], real),
      cacheThroughLink: () => writeGatewayModelCache("http://127.0.0.1:1", [{ id: "claude-x" }], linked),
      cacheThroughCaseAlias: () => writeGatewayModelCache("http://127.0.0.1:1", [{ id: "claude-x" }], alias),
      cacheThroughAbsentOverrideAlias: () => writeGatewayModelCache("http://127.0.0.1:1", [{ id: "claude-x" }], absentAlias),
      cacheThroughFileLink: () => writeGatewayModelCache("http://127.0.0.1:1", [{ id: "claude-x" }], fileLinked),
      cacheUnderDotDotNamedChild: () => writeGatewayModelCache("http://127.0.0.1:1", [{ id: "claude-x" }], real + "/..fixture"),
      // On POSIX a backslash is an ordinary filename character, so this is still a child.
      cacheUnderBackslashNamedChild: () => writeGatewayModelCache("http://127.0.0.1:1", [{ id: "claude-x" }], real + "/..\\\\fixture"),
      catalog: () => invalidateClaudeCodeServedCatalog(real),
      settings: () => applyClaudeInterceptSettings(env, real),
    };
    const refused = {};
    for (const [name, attempt] of Object.entries(attempts)) {
      try { attempt(); refused[name] = false; }
      catch (error) { refused[name] = /real Claude config directory/.test(String(error)); }
    }
    const fixtureWrite = writeGatewayModelCache("http://127.0.0.1:1", [{ id: "claude-x" }], fixture) !== null;
    // Windows reads the backslash as a separator, so there the same spelling leaves the root.
    const backslashChildRefused = process.platform === "win32" || protectedRemovalReason(real + "/..\\\\fixture") !== null;
    const removalRefused = protectedRemovalReason(absentAlias) !== null && protectedRemovalReason(real) !== null
      && backslashChildRefused;
    console.log(JSON.stringify({ refused, fixtureWrite, removalRefused }));
  `;
  try {
    const child = Bun.spawnSync([process.execPath, "-e", code], {
      cwd: repoRoot(),
      env: {
        ...isolated.env,
        OCX_TEST_HOME_GUARD: "1",
        OCX_REAL_HOME: sentinelHome,
        OCX_REAL_CLAUDE_CONFIG_DIR: absentOverride,
        CLAUDE_CONFIG_DIR: realClaude,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const stderr = new TextDecoder().decode(child.stderr);
    expect({ exitCode: child.exitCode, stderr: child.exitCode === 0 ? "" : stderr }).toEqual({ exitCode: 0, stderr: "" });
    const lines = new TextDecoder().decode(child.stdout).trim().split("\n");
    expect(JSON.parse(lines.at(-1)!)).toEqual({
      refused: {
        agents: true,
        agentsThroughLink: true,
        cache: true,
        cacheThroughLink: true,
        cacheThroughCaseAlias: true,
        cacheThroughAbsentOverrideAlias: true,
        cacheThroughFileLink: fileLinkBuilt,
        cacheUnderDotDotNamedChild: true,
        cacheUnderBackslashNamedChild: process.platform !== "win32",
        catalog: true,
        settings: true,
      },
      fixtureWrite: true,
      removalRefused: true,
    });
    expect(existsSync(probe)).toBe(true);
    expect(existsSync(catalog)).toBe(true);
    expect(readFileSync(realCacheFile, "utf8")).toBe("original");
    expect(existsSync(join(realClaude, "..fixture"))).toBe(false);
    expect(existsSync(join(realClaude, "settings.json"))).toBe(false);
    expect(existsSync(absentAlias)).toBe(false);
  } finally {
    isolated.cleanup();
  }
});

test("removal protection keeps the running checkout's own content removable when it sits inside the Claude directory", () => {
  const checkout = repoRoot();
  const code = `
    const { protectedRemovalReason } = await import(${JSON.stringify(repoPath("src", "lib", "test-home-guard.ts"))});
    const checkout = ${JSON.stringify(checkout)};
    console.log(JSON.stringify({
      content: protectedRemovalReason(checkout + "/tests/fixtures/n3-removal-probe") === null,
      checkoutRoot: protectedRemovalReason(checkout) !== null,
      protectedRoot: protectedRemovalReason(${JSON.stringify(dirname(checkout))}) !== null,
    }));
  `;
  const isolated = createIsolatedTestEnvironment();
  try {
    const child = Bun.spawnSync([process.execPath, "-e", code], {
      cwd: checkout,
      env: {
        ...isolated.env,
        OCX_TEST_HOME_GUARD: "1",
        OCX_REAL_HOME: join(isolated.root, "sentinel-home"),
        // The checkout's parent stands in for a Claude directory that contains the checkout.
        OCX_REAL_CLAUDE_CONFIG_DIR: dirname(checkout),
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(child.exitCode).toBe(0);
    const lines = new TextDecoder().decode(child.stdout).trim().split("\n");
    expect(JSON.parse(lines.at(-1)!)).toEqual({ content: true, checkoutRoot: true, protectedRoot: true });
  } finally {
    isolated.cleanup();
  }
});

