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
    expect(commands).toContain("launchctl setenv _CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL 1");
    expect(commands).toContain("launchctl setenv CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY 1");
    // Two writes: shell env file + tracking file
    expect(writeSpy).toHaveBeenCalledTimes(2);
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
});

describe("system environment cleanup", () => {
  test("revertSystemEnv unsets owned variables and deletes the tracking file", () => {
    trackingFile = tracking();
    launchctlBaseUrl = "http://127.0.0.1:4567";

    expect(revertSystemEnv()).toEqual({ reverted: true });
    for (const name of [
      "ANTHROPIC_BASE_URL",
      "_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL",
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
