import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import * as childProcess from "node:child_process";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { injectSystemEnv } from "../src/server/system-env";
import { PROXY_MARKER } from "../src/claude/auth-detect";
import type { OcxConfig } from "../src/types";

/**
 * Auto must reach PLAIN `claude` launches, not just `ocx claude`. Before this, the
 * shell-env file and launchctl keyed on a stored "proxy", so an auto+absent user got
 * nothing from auto-connect (devlog 260726_claude_auth_auto/035).
 *
 * The detector reads HOME-relative files and probes the macOS keychain, so these
 * tests point HOME and CLAUDE_CONFIG_DIR at an empty temp dir AND stub `spawnSync`
 * with the keychain's real "item not found" exit code. Without the spawn stub the
 * suite reads the developer's own keychain and every assertion inverts.
 */

const originalPlatform = process.platform;
let execSpy: ReturnType<typeof spyOn>;
let spawnSpy: ReturnType<typeof spyOn>;
let readSpy: ReturnType<typeof spyOn>;
let writeSpy: ReturnType<typeof spyOn>;
let mkdirSpy: ReturnType<typeof spyOn>;
let shellEnvContents = "";
let previousConfigDir: string | undefined;
let previousHome: string | undefined;
let previousApiKey: string | undefined;
let previousAuthToken: string | undefined;

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", { configurable: true, value: platform });
}

const baseConfig = {
  port: 4096,
  providers: {},
  defaultProvider: "test",
  claudeCode: { systemEnv: true },
} as unknown as OcxConfig;

beforeEach(() => {
  setPlatform("darwin");
  shellEnvContents = "";
  previousConfigDir = process.env.CLAUDE_CONFIG_DIR;
  previousHome = process.env.HOME;
  // The detector also reads the AMBIENT env (source S5). A runner that exports an
  // Anthropic key would otherwise make "no detectable auth" quietly false and invert
  // every assertion below for reasons unrelated to this code.
  previousApiKey = process.env.ANTHROPIC_API_KEY;
  previousAuthToken = process.env.ANTHROPIC_AUTH_TOKEN;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_AUTH_TOKEN;
  // An empty profile dir + a HOME with no ~/.claude.json = detection "absent".
  const empty = fs.mkdtempSync(join(tmpdir(), "ocx-sysenv-"));
  process.env.CLAUDE_CONFIG_DIR = empty;
  process.env.HOME = empty;

  execSpy = spyOn(childProcess, "execFileSync").mockImplementation(((file: string, args?: string[]) => {
    // No launchctl value: a clean "absent" world.
    if (file === "/bin/launchctl" && args?.[0] === "getenv") return "";
    return "";
  }) as never);
  // 44 = SecKeychainSearchCopyNext "item not found": a REAL absent, not a probe failure.
  spawnSpy = spyOn(childProcess, "spawnSync").mockImplementation((() => ({
    status: 44,
    signal: null,
    error: undefined,
    stdout: null,
    stderr: null,
    output: [],
    pid: 0,
  })) as never);
  readSpy = spyOn(fs, "readFileSync").mockImplementation(((path: string) => {
    if (String(path).includes("system-env-port")) throw new Error("ENOENT");
    return "";
  }) as never);
  writeSpy = spyOn(fs, "writeFileSync").mockImplementation(((path: string, data: string) => {
    if (String(path).includes("claude-env.sh")) shellEnvContents = String(data);
  }) as never);
  mkdirSpy = spyOn(fs, "mkdirSync").mockImplementation((() => undefined) as never);
});

afterEach(() => {
  execSpy.mockRestore();
  spawnSpy.mockRestore();
  readSpy.mockRestore();
  writeSpy.mockRestore();
  mkdirSpy.mockRestore();
  setPlatform(originalPlatform);
  if (previousConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = previousConfigDir;
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  if (previousApiKey === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = previousApiKey;
  if (previousAuthToken === undefined) delete process.env.ANTHROPIC_AUTH_TOKEN;
  else process.env.ANTHROPIC_AUTH_TOKEN = previousAuthToken;
});

// THE point of this phase: an auto config with no detectable auth must still wire up
// plain `claude`, exactly as a stored "proxy" always did.
test("auto with no detectable auth writes the proxy marker", async () => {
  await injectSystemEnv(4567, baseConfig);
  expect(shellEnvContents).toContain(`ANTHROPIC_AUTH_TOKEN='${PROXY_MARKER}'`);
});

test("an explicit subscription withholds the marker even under the same detection", async () => {
  await injectSystemEnv(4567, {
    ...baseConfig,
    claudeCode: { systemEnv: true, authMode: "subscription" },
  } as unknown as OcxConfig);
  expect(shellEnvContents).not.toContain(PROXY_MARKER);
});

test("an explicit proxy still writes the marker", async () => {
  await injectSystemEnv(4567, {
    ...baseConfig,
    claudeCode: { systemEnv: true, authMode: "proxy" },
  } as unknown as OcxConfig);
  expect(shellEnvContents).toContain(`ANTHROPIC_AUTH_TOKEN='${PROXY_MARKER}'`);
});

// Proxy mode owns the Claude auth slot and may use the configured admission key.
test("proxy mode writes the configured admission key instead of the marker", async () => {
  await injectSystemEnv(4567, {
    ...baseConfig,
    claudeCode: { systemEnv: true, authMode: "proxy" },
    apiKeys: [{ key: "admission-key" }],
  } as unknown as OcxConfig);
  expect(shellEnvContents).toContain("ANTHROPIC_AUTH_TOKEN='admission-key'");
  expect(shellEnvContents).not.toContain(PROXY_MARKER);
});

test("subscription mode omits the configured admission key", async () => {
  await injectSystemEnv(4567, {
    ...baseConfig,
    claudeCode: { systemEnv: true, authMode: "subscription" },
    apiKeys: [{ key: "admission-key" }],
  } as unknown as OcxConfig);
  expect(shellEnvContents).not.toContain("ANTHROPIC_AUTH_TOKEN='admission-key'");
  expect(shellEnvContents).not.toContain(PROXY_MARKER);
});

// Detection is env-aware: a proof-bound parent export means auth is present, so auto
// resolves subscription and the marker stays out of the file. An unproven Bun dotenv
// value is deliberately ignored by system-env (covered in system-env.test.ts).
test("auto with a proof-bound user API key writes no marker", async () => {
  const previous = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = "sk-ant-user";
  try {
    await injectSystemEnv(4567, baseConfig, {
      preBunAnthropicSlots: ["ANTHROPIC_API_KEY"],
    });
    expect(shellEnvContents).not.toContain(PROXY_MARKER);
  } finally {
    if (previous === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = previous;
  }
});
