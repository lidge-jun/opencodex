import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import * as childProcess from "node:child_process";
import * as fs from "node:fs";
import type { OcxConfig } from "../src/types";
import {
  cleanStaleSystemEnv,
  injectSystemEnv,
  revertSystemEnv,
} from "../src/server/system-env";

const originalFetch = globalThis.fetch;
const originalPlatform = process.platform;

const baseConfig = {
  port: 4096,
  providers: {},
  defaultProvider: "test",
  claudeCode: { systemEnv: true },
} satisfies OcxConfig;

let execSpy: ReturnType<typeof spyOn>;
let readSpy: ReturnType<typeof spyOn>;
let writeSpy: ReturnType<typeof spyOn>;
let unlinkSpy: ReturnType<typeof spyOn>;
let mkdirSpy: ReturnType<typeof spyOn>;
let trackingFile: string | undefined;
let launchctlBaseUrl: string | undefined;

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", { configurable: true, value: platform });
}

function tracking(port = 4567): string {
  return JSON.stringify({ pid: 123, port, injectedAt: "2026-07-11T00:00:00.000Z" });
}

beforeEach(() => {
  setPlatform("darwin");
  trackingFile = undefined;
  launchctlBaseUrl = undefined;
  globalThis.fetch = mock(async () => new Response("ok")) as unknown as typeof fetch;

  execSpy = spyOn(childProcess, "execSync").mockImplementation(((command: string) => {
    if (command === "launchctl getenv ANTHROPIC_BASE_URL") return launchctlBaseUrl ?? "";
    return Buffer.alloc(0);
  }) as typeof childProcess.execSync);
  readSpy = spyOn(fs, "readFileSync").mockImplementation((() => {
    if (trackingFile === undefined) throw new Error("ENOENT");
    return trackingFile;
  }) as typeof fs.readFileSync);
  writeSpy = spyOn(fs, "writeFileSync").mockImplementation(((...args: unknown[]) => {
    trackingFile = String(args[1]);
  }) as typeof fs.writeFileSync);
  unlinkSpy = spyOn(fs, "unlinkSync").mockImplementation((() => {
    trackingFile = undefined;
  }) as typeof fs.unlinkSync);
  mkdirSpy = spyOn(fs, "mkdirSync").mockImplementation((() => undefined) as typeof fs.mkdirSync);
});

afterEach(() => {
  execSpy.mockRestore();
  readSpy.mockRestore();
  writeSpy.mockRestore();
  unlinkSpy.mockRestore();
  mkdirSpy.mockRestore();
  globalThis.fetch = originalFetch;
  setPlatform(originalPlatform);
});

describe("system environment injection", () => {
  test("injectSystemEnv sets the Claude launchctl variables on macOS", async () => {
    expect(await injectSystemEnv(4567, baseConfig)).toEqual({ injected: true });

    const commands = execSpy.mock.calls.map(call => call[0]);
    expect(commands).toContain("launchctl setenv ANTHROPIC_BASE_URL http://127.0.0.1:4567");
    expect(commands).toContain("launchctl setenv CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY 1");
    // Writes include the shell env file and the tracking file (agent-def syncing
    // may add owned ocx-*.md writes — devlog 070; count is no longer fixed).
    const writePaths = writeSpy.mock.calls.map(call => String(call[0]));
    expect(writePaths.some(p => p.includes("claude-env.sh"))).toBe(true);
    expect(writePaths.some(p => p.includes("system-env-port"))).toBe(true);
    expect(JSON.parse(trackingFile!)).toMatchObject({ pid: process.pid, port: 4567 });
  });

  test("injectSystemEnv is a no-op outside macOS", async () => {
    setPlatform("linux");

    expect(await injectSystemEnv(4567, baseConfig)).toEqual({ injected: false, reason: "not macOS" });
    expect(execSpy).not.toHaveBeenCalled();
  });

  test("injectSystemEnv skips disabled Claude and system environment integration", async () => {
    expect(await injectSystemEnv(4567, { ...baseConfig, claudeCode: { enabled: false } })).toEqual({
      injected: false,
      reason: "claude disabled",
    });
    expect(await injectSystemEnv(4567, {
      ...baseConfig,
      claudeCode: { systemEnv: false },
    })).toEqual({ injected: false, reason: "systemEnv disabled" });
  });

  test("injectSystemEnv preserves a custom ANTHROPIC_BASE_URL", async () => {
    launchctlBaseUrl = "https://anthropic.example.com";

    expect(await injectSystemEnv(4567, baseConfig)).toEqual({
      injected: false,
      reason: "user has custom ANTHROPIC_BASE_URL",
    });
    expect(execSpy.mock.calls.some(call => String(call[0]).includes("setenv"))).toBe(false);
  });

  test("injectSystemEnv includes the first configured API key", async () => {
    const config: OcxConfig = {
      ...baseConfig,
      apiKeys: [{ id: "key-1", name: "Primary", key: "secret-token", createdAt: "2026-07-11T00:00:00.000Z" }],
    };

    expect(await injectSystemEnv(4567, config)).toEqual({ injected: true });
    expect(execSpy.mock.calls.map(call => call[0])).toContain("launchctl setenv ANTHROPIC_AUTH_TOKEN secret-token");
  });

  test("injectSystemEnv shell-quotes API keys with special characters", async () => {
    const config: OcxConfig = {
      ...baseConfig,
      apiKeys: [{ id: "key-1", name: "Primary", key: "secret token'quoted", createdAt: "2026-07-11T00:00:00.000Z" }],
    };

    expect(await injectSystemEnv(4567, config)).toEqual({ injected: true });
    expect(execSpy.mock.calls.map(call => call[0])).toContain(
      "launchctl setenv ANTHROPIC_AUTH_TOKEN 'secret token'\\''quoted'",
    );
  });

  // Subscription switch-back cleanup (devlog 260720_claude_authmode_persist, audit R1 #1):
  // re-injecting without proxy mode must unset ONLY the opencodex-owned dummy token.
  function trackingWithToken(port = 4567, keys: string[] = ["ANTHROPIC_BASE_URL", "CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY", "ANTHROPIC_AUTH_TOKEN"]): string {
    return JSON.stringify({ pid: 123, port, injectedAt: "2026-07-11T00:00:00.000Z", injectedKeys: keys });
  }

  function mockAuthTokenGetenv(value: string | undefined): void {
    execSpy.mockImplementation(((command: string) => {
      if (command === "launchctl getenv ANTHROPIC_BASE_URL") return launchctlBaseUrl ?? "";
      if (command === "launchctl getenv ANTHROPIC_AUTH_TOKEN") return value ?? "";
      return Buffer.alloc(0);
    }) as typeof childProcess.execSync);
  }

  test("re-inject after switching back to subscription unsets the owned dummy token", async () => {
    trackingFile = trackingWithToken();
    launchctlBaseUrl = "http://127.0.0.1:4567";
    mockAuthTokenGetenv("opencodex-proxy");

    expect(await injectSystemEnv(4567, baseConfig)).toEqual({ injected: true });
    expect(execSpy.mock.calls.map(call => call[0])).toContain("launchctl unsetenv ANTHROPIC_AUTH_TOKEN");
    expect(JSON.parse(trackingFile!).injectedKeys).not.toContain("ANTHROPIC_AUTH_TOKEN");
  });

  test("re-inject preserves a tracked token whose value is not the opencodex dummy", async () => {
    trackingFile = trackingWithToken();
    launchctlBaseUrl = "http://127.0.0.1:4567";
    mockAuthTokenGetenv("sk-user-real-token");

    expect(await injectSystemEnv(4567, baseConfig)).toEqual({ injected: true });
    expect(execSpy.mock.calls.map(call => call[0])).not.toContain("launchctl unsetenv ANTHROPIC_AUTH_TOKEN");
  });

  test("re-inject preserves an untracked dummy-valued token it does not own", async () => {
    // Ownership guard independent of the value guard (audit R2 #1): the launchd domain
    // carries "opencodex-proxy" but WE never injected it (not in injectedKeys).
    trackingFile = trackingWithToken(4567, ["ANTHROPIC_BASE_URL", "CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY"]);
    launchctlBaseUrl = "http://127.0.0.1:4567";
    mockAuthTokenGetenv("opencodex-proxy");

    expect(await injectSystemEnv(4567, baseConfig)).toEqual({ injected: true });
    expect(execSpy.mock.calls.map(call => call[0])).not.toContain("launchctl unsetenv ANTHROPIC_AUTH_TOKEN");
  });
});

describe("system environment cleanup", () => {
  test("revertSystemEnv unsets owned variables and deletes the tracking file", () => {
    trackingFile = tracking();
    launchctlBaseUrl = "http://127.0.0.1:4567";

    expect(revertSystemEnv()).toEqual({ reverted: true });
    for (const name of [
      "ANTHROPIC_BASE_URL",
      "CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY",
      "ANTHROPIC_AUTH_TOKEN",
    ]) {
    expect(execSpy.mock.calls.map(call => call[0])).toContain(`launchctl unsetenv ${name}`);
    }
    // Two deletes: shell env file + tracking file
    expect(unlinkSpy).toHaveBeenCalledTimes(2);
  });

  test("revertSystemEnv skips variables it does not own", () => {
    trackingFile = tracking();
    launchctlBaseUrl = "http://127.0.0.1:9999";

    expect(revertSystemEnv()).toEqual({ reverted: false, reason: "ownership mismatch" });
    expect(unlinkSpy).not.toHaveBeenCalled();
  });

  test("cleanStaleSystemEnv reverts a dead tracked proxy", async () => {
    trackingFile = tracking();
    launchctlBaseUrl = "http://127.0.0.1:4567";
    globalThis.fetch = mock(async () => { throw new Error("connection refused"); }) as unknown as typeof fetch;

    expect(await cleanStaleSystemEnv()).toEqual({ cleaned: true });
    // Two deletes: shell env file + tracking file
    expect(unlinkSpy).toHaveBeenCalledTimes(2);
  });
});

describe("systemEnv lever keys (devlog 136 B6)", () => {
  const leverConfig = {
    ...baseConfig,
    claudeCode: { systemEnv: true, maxContextTokens: 1_000_000, alwaysEnableEffort: true },
  } satisfies OcxConfig;

  function capturedWrites(): Array<{ path: string; data: string }> {
    const writes: Array<{ path: string; data: string }> = [];
    writeSpy.mockImplementation(((...args: unknown[]) => {
      writes.push({ path: String(args[0]), data: String(args[1]) });
      trackingFile = String(args[1]);
    }) as typeof fs.writeFileSync);
    return writes;
  }

  test("injects lever keys, tracks them, and shell file uses conditional exports", async () => {
    const writes = capturedWrites();
    expect(await injectSystemEnv(4096, leverConfig)).toEqual({ injected: true });
    const setCalls = execSpy.mock.calls.map(call => String(call[0]));
    expect(setCalls).toContain("launchctl setenv CLAUDE_CODE_MAX_CONTEXT_TOKENS 1000000");
    expect(setCalls).toContain("launchctl setenv DISABLE_COMPACT 1");
    expect(setCalls).toContain("launchctl setenv CLAUDE_CODE_ALWAYS_ENABLE_EFFORT 1");
    const trackingWrite = writes.filter(w => w.path.includes("system-env-port")).at(-1);
    expect(JSON.parse(trackingWrite!.data).injectedKeys).toEqual(expect.arrayContaining([
      "CLAUDE_CODE_MAX_CONTEXT_TOKENS", "DISABLE_COMPACT", "CLAUDE_CODE_ALWAYS_ENABLE_EFFORT",
    ]));
    // Shell env file: lever keys are CONDITIONAL exports so a shell-only user value wins.
    const shellWrite = writes.find(w => w.path.includes("claude-env.sh"));
    expect(shellWrite!.data).toContain(`[ -z "\${CLAUDE_CODE_MAX_CONTEXT_TOKENS+x}" ] && export CLAUDE_CODE_MAX_CONTEXT_TOKENS='1000000'`);
    expect(shellWrite!.data).toContain(`[ -z "\${DISABLE_COMPACT+x}" ] && export DISABLE_COMPACT='1'`);
    expect(shellWrite!.data).toContain(`[ -z "\${CLAUDE_CODE_ALWAYS_ENABLE_EFFORT+x}" ] && export CLAUDE_CODE_ALWAYS_ENABLE_EFFORT='1'`);
  });

  test("user-preset launchctl values are skipped and never tracked (revert cannot delete them)", async () => {
    const writes = capturedWrites();
    execSpy.mockImplementation(((command: string) => {
      if (command === "launchctl getenv ANTHROPIC_BASE_URL") return launchctlBaseUrl ?? "";
      if (command === "launchctl getenv CLAUDE_CODE_MAX_CONTEXT_TOKENS") return "777000";
      if (command.startsWith("launchctl getenv")) return "";
      return Buffer.alloc(0);
    }) as typeof childProcess.execSync);
    expect(await injectSystemEnv(4096, leverConfig)).toEqual({ injected: true });
    const setCalls = execSpy.mock.calls.map(call => String(call[0]));
    expect(setCalls).not.toContain("launchctl setenv CLAUDE_CODE_MAX_CONTEXT_TOKENS 1000000");
    expect(setCalls).toContain("launchctl setenv DISABLE_COMPACT 1");
    const trackingWrite = writes.filter(w => w.path.includes("system-env-port")).at(-1);
    const keys = JSON.parse(trackingWrite!.data).injectedKeys as string[];
    expect(keys).not.toContain("CLAUDE_CODE_MAX_CONTEXT_TOKENS");
    expect(keys).toContain("DISABLE_COMPACT");
  });

  test("levers disabled: no lever keys injected or exported", async () => {
    const writes = capturedWrites();
    expect(await injectSystemEnv(4096, baseConfig)).toEqual({ injected: true });
    const setCalls = execSpy.mock.calls.map(call => String(call[0]));
    expect(setCalls.some(c => c.includes("CLAUDE_CODE_MAX_CONTEXT_TOKENS"))).toBe(false);
    expect(setCalls.some(c => c.includes("CLAUDE_CODE_ALWAYS_ENABLE_EFFORT"))).toBe(false);
    const shellWrite = writes.find(w => w.path.includes("claude-env.sh"));
    expect(shellWrite!.data).not.toContain("DISABLE_COMPACT");
  });

  test("auto-context default lever: AUTO_COMPACT_WINDOW 350000 injected, tracked, conditionally exported (devlog 020)", async () => {
    const writes = capturedWrites();
    expect(await injectSystemEnv(4096, baseConfig)).toEqual({ injected: true });
    const setCalls = execSpy.mock.calls.map(call => String(call[0]));
    expect(setCalls).toContain("launchctl setenv CLAUDE_CODE_AUTO_COMPACT_WINDOW 350000");
    const trackingWrite = writes.filter(w => w.path.includes("system-env-port")).at(-1);
    expect(JSON.parse(trackingWrite!.data).injectedKeys).toContain("CLAUDE_CODE_AUTO_COMPACT_WINDOW");
    const shellWrite = writes.find(w => w.path.includes("claude-env.sh"));
    expect(shellWrite!.data).toContain(`[ -z "\${CLAUDE_CODE_AUTO_COMPACT_WINDOW+x}" ] && export CLAUDE_CODE_AUTO_COMPACT_WINDOW='350000'`);
  });

  test("auto-context: user-preset launchctl value is respected and untracked (audit 021 #2)", async () => {
    const writes = capturedWrites();
    execSpy.mockImplementation(((command: string) => {
      if (command === "launchctl getenv ANTHROPIC_BASE_URL") return launchctlBaseUrl ?? "";
      if (command === "launchctl getenv CLAUDE_CODE_AUTO_COMPACT_WINDOW") return "500000";
      if (command.startsWith("launchctl getenv")) return "";
      return Buffer.alloc(0);
    }) as typeof childProcess.execSync);
    expect(await injectSystemEnv(4096, baseConfig)).toEqual({ injected: true });
    const setCalls = execSpy.mock.calls.map(call => String(call[0]));
    expect(setCalls.some(c => c.startsWith("launchctl setenv CLAUDE_CODE_AUTO_COMPACT_WINDOW"))).toBe(false);
    const trackingWrite = writes.filter(w => w.path.includes("system-env-port")).at(-1);
    expect(JSON.parse(trackingWrite!.data).injectedKeys).not.toContain("CLAUDE_CODE_AUTO_COMPACT_WINDOW");
  });

  test("auto-context stays inert while the maxContextTokens lever is set", async () => {
    capturedWrites();
    expect(await injectSystemEnv(4096, leverConfig)).toEqual({ injected: true });
    const setCalls = execSpy.mock.calls.map(call => String(call[0]));
    expect(setCalls.some(c => c.startsWith("launchctl setenv CLAUDE_CODE_AUTO_COMPACT_WINDOW"))).toBe(false);
  });

  test("tier slots inject ANTHROPIC_DEFAULT_*_MODEL via launchctl and conditional shell exports", async () => {
    const writes = capturedWrites();
    const tierConfig = {
      ...baseConfig,
      claudeCode: { systemEnv: true, tierModels: { opus: "cursor/gpt-5.6-luna", sonnet: "mock/small" } },
    } satisfies OcxConfig;
    expect(await injectSystemEnv(4096, tierConfig)).toEqual({ injected: true });
    const setCalls = execSpy.mock.calls.map(call => String(call[0]));
    expect(setCalls.some(c => c.startsWith("launchctl setenv ANTHROPIC_DEFAULT_OPUS_MODEL"))).toBe(true);
    expect(setCalls.some(c => c.startsWith("launchctl setenv ANTHROPIC_DEFAULT_SONNET_MODEL"))).toBe(true);
    const trackingWrite = writes.filter(w => w.path.includes("system-env-port")).at(-1);
    expect(JSON.parse(trackingWrite!.data).injectedKeys).toEqual(expect.arrayContaining([
      "ANTHROPIC_DEFAULT_OPUS_MODEL", "ANTHROPIC_DEFAULT_SONNET_MODEL",
    ]));
    const shellWrite = writes.find(w => w.path.includes("claude-env.sh"));
    expect(shellWrite!.data).toContain('[ -z "${ANTHROPIC_DEFAULT_OPUS_MODEL+x}" ] && export ANTHROPIC_DEFAULT_OPUS_MODEL=');
  });
});
