import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import * as childProcess from "node:child_process";
import * as fs from "node:fs";
import { repoPath } from "../helpers/repo-root";
import type { OcxConfig } from "../../src/types";
import {
  cleanStaleSystemEnv,
  getShellEnvFilePath,
  injectSystemEnv,
  installShellHook,
  revertSystemEnv,
} from "../../src/server/system-env";
import {
  getShellEnvFilePath as shellEnvFilePath,
  installShellHook as shellInstallHook,
} from "../../src/server/system-env-shell";

const originalFetch = globalThis.fetch;
const originalPlatform = process.platform;

const baseConfig = {
  port: 4096,
  providers: {},
  defaultProvider: "test",
  claudeCode: { systemEnv: true },
} satisfies OcxConfig;

let execSpy: ReturnType<typeof spyOn>;
let execFileSpy: ReturnType<typeof spyOn>;
let readSpy: ReturnType<typeof spyOn>;
let writeSpy: ReturnType<typeof spyOn>;
let unlinkSpy: ReturnType<typeof spyOn>;
let mkdirSpy: ReturnType<typeof spyOn>;
let trackingFile: string | undefined;
let launchctlBaseUrl: string | undefined;
let launchctlEnvValues: Record<string, string | undefined>;

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", { configurable: true, value: platform });
}

function tracking(port = 4567): string {
  return JSON.stringify({ pid: 123, port, injectedAt: "2026-07-11T00:00:00.000Z" });
}

function launchctlCommands(): string[] {
  return execFileSpy.mock.calls
    .filter(call => call[0] === "/bin/launchctl")
    .map(call => `launchctl ${(call[1] as string[]).join(" ")}`);
}

beforeEach(() => {
  setPlatform("darwin");
  trackingFile = undefined;
  launchctlBaseUrl = undefined;
  launchctlEnvValues = {};
  globalThis.fetch = mock(async () => new Response("ok")) as unknown as typeof fetch;

  execSpy = spyOn(childProcess, "execSync").mockImplementation((() => Buffer.alloc(0)) as typeof childProcess.execSync);
  execFileSpy = spyOn(childProcess, "execFileSync").mockImplementation(((file: string, args?: readonly string[]) => {
    if (file === "/bin/launchctl" && args?.[0] === "getenv") {
      const name = args[1];
      if (name === "ANTHROPIC_BASE_URL") return launchctlBaseUrl ?? "";
      return launchctlEnvValues[name] ?? "";
    }
    return Buffer.alloc(0);
  }) as typeof childProcess.execFileSync);
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
  execFileSpy.mockRestore();
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

    const commands = launchctlCommands();
    expect(commands).toContain("launchctl setenv ANTHROPIC_BASE_URL http://127.0.0.1:4567");
    expect(commands).toContain("launchctl setenv CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY 1");
    // Writes include the shell env file and the tracking file (agent-def syncing
    // may add owned ocx-*.md writes — devlog 070; count is no longer fixed).
    const writePaths = writeSpy.mock.calls.map(call => String(call[0]));
    expect(writePaths.some(p => p.includes("claude-env.sh"))).toBe(true);
    expect(writePaths.some(p => p.includes("system-env-port"))).toBe(true);
    expect(JSON.parse(trackingFile!)).toMatchObject({ pid: process.pid, port: 4567 });
  });

  test("injectSystemEnv invokes launchctl without a command shell", async () => {
    expect(await injectSystemEnv(4567, baseConfig)).toEqual({ injected: true });

    expect(execFileSpy).toHaveBeenCalledWith(
      "/bin/launchctl",
      ["getenv", "ANTHROPIC_BASE_URL"],
      { encoding: "utf8" },
    );
    expect(execFileSpy).toHaveBeenCalledWith(
      "/bin/launchctl",
      ["setenv", "ANTHROPIC_BASE_URL", "http://127.0.0.1:4567"],
    );
    expect(execSpy).not.toHaveBeenCalled();
  });

  test("injectSystemEnv is a no-op outside macOS", async () => {
    setPlatform("linux");

    expect(await injectSystemEnv(4567, baseConfig)).toEqual({ injected: false, reason: "not macOS" });
    expect(execFileSpy).not.toHaveBeenCalled();
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
    expect(launchctlCommands().some(command => command.includes("setenv"))).toBe(false);
  });

  test("injectSystemEnv includes the first configured API key", async () => {
    const config: OcxConfig = {
      ...baseConfig,
      claudeCode: { systemEnv: true, authMode: "proxy" },
      apiKeys: [{ id: "key-1", name: "Primary", key: "secret-token", createdAt: "2026-07-11T00:00:00.000Z" }],
    };

    expect(await injectSystemEnv(4567, config)).toEqual({ injected: true });
    expect(launchctlCommands()).toContain("launchctl setenv ANTHROPIC_AUTH_TOKEN secret-token");
  });

  test("injectSystemEnv passes API keys with special characters as one argument", async () => {
    const config: OcxConfig = {
      ...baseConfig,
      claudeCode: { systemEnv: true, authMode: "proxy" },
      apiKeys: [{ id: "key-1", name: "Primary", key: "secret token'quoted", createdAt: "2026-07-11T00:00:00.000Z" }],
    };

    expect(await injectSystemEnv(4567, config)).toEqual({ injected: true });
    expect(execFileSpy).toHaveBeenCalledWith(
      "/bin/launchctl",
      ["setenv", "ANTHROPIC_AUTH_TOKEN", "secret token'quoted"],
    );
  });

  test("subscription mode leaves configured proxy keys out of launch environments", async () => {
    const config: OcxConfig = {
      ...baseConfig,
      claudeCode: { systemEnv: true, authMode: "subscription" },
      apiKeys: [{ id: "key-1", name: "Primary", key: "secret-token", createdAt: "2026-07-11T00:00:00.000Z" }],
    };

    expect(await injectSystemEnv(4567, config)).toEqual({ injected: true });
    expect(launchctlCommands()).not.toContain("launchctl setenv ANTHROPIC_AUTH_TOKEN secret-token");
    const shellWrite = writeSpy.mock.calls.find(call => String(call[0]).includes("claude-env.sh"));
    expect(String(shellWrite?.[1] ?? "")).not.toContain("ANTHROPIC_AUTH_TOKEN");
  });

  test("dotenv-only Anthropic slots do not suppress the configured proxy key", async () => {
    const previousApiKey = process.env.ANTHROPIC_API_KEY;
    const previousAuthToken = process.env.ANTHROPIC_AUTH_TOKEN;
    process.env.ANTHROPIC_API_KEY = "sk-ant-dotenv-test";
    process.env.ANTHROPIC_AUTH_TOKEN = "dotenv-token-test";
    const config: OcxConfig = {
      ...baseConfig,
      apiKeys: [{ id: "key-1", name: "Primary", key: "secret-token", createdAt: "2026-07-11T00:00:00.000Z" }],
    };
    const authAbsent = {
      readClaudeJson: () => undefined,
      credentialsFileExists: () => false,
      keychainProbe: () => "absent" as const,
    };

    try {
      expect(await injectSystemEnv(4567, config, {
        // Simulates Bun values that came only from a project dotenv file.
        preBunAnthropicSlots: [],
        authDetect: authAbsent,
      })).toEqual({ injected: true });
      expect(launchctlCommands()).toContain("launchctl setenv ANTHROPIC_AUTH_TOKEN secret-token");
      const shellWrite = writeSpy.mock.calls.find(call => String(call[0]).includes("claude-env.sh"));
      expect(String(shellWrite?.[1] ?? "")).toContain("export ANTHROPIC_AUTH_TOKEN='secret-token'");
    } finally {
      if (previousApiKey === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = previousApiKey;
      if (previousAuthToken === undefined) delete process.env.ANTHROPIC_AUTH_TOKEN;
      else process.env.ANTHROPIC_AUTH_TOKEN = previousAuthToken;
    }
  });

  test("proof-bound parent Anthropic key selects subscription and remains untouched", async () => {
    const previousApiKey = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "sk-ant-parent-test";
    const config: OcxConfig = {
      ...baseConfig,
      apiKeys: [{ id: "key-1", name: "Primary", key: "secret-token", createdAt: "2026-07-11T00:00:00.000Z" }],
    };
    const authAbsent = {
      readClaudeJson: () => undefined,
      credentialsFileExists: () => false,
      keychainProbe: () => "absent" as const,
    };

    try {
      expect(await injectSystemEnv(4567, config, {
        // Simulates a genuine parent export captured by bin/ocx.mjs before Bun starts.
        preBunAnthropicSlots: ["ANTHROPIC_API_KEY"],
        authDetect: authAbsent,
      })).toEqual({ injected: true });
      expect(launchctlCommands()).not.toContain("launchctl setenv ANTHROPIC_AUTH_TOKEN secret-token");
      expect(launchctlCommands()).not.toContain("launchctl unsetenv ANTHROPIC_AUTH_TOKEN");
      const shellWrite = writeSpy.mock.calls.find(call => String(call[0]).includes("claude-env.sh"));
      expect(String(shellWrite?.[1] ?? "")).not.toContain("ANTHROPIC_AUTH_TOKEN");
      expect(process.env.ANTHROPIC_API_KEY).toBe("sk-ant-parent-test");
    } finally {
      if (previousApiKey === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = previousApiKey;
    }
  });

  // Subscription switch-back cleanup (devlog 260720_claude_authmode_persist, audit R1 #1):
  // re-injecting without proxy mode must unset an opencodex-owned auth token.
  function trackingWithToken(port = 4567, keys: string[] = ["ANTHROPIC_BASE_URL", "CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY", "ANTHROPIC_AUTH_TOKEN"]): string {
    return JSON.stringify({ pid: 123, port, injectedAt: "2026-07-11T00:00:00.000Z", injectedKeys: keys });
  }

  function mockAuthTokenGetenv(value: string | undefined): void {
    launchctlEnvValues.ANTHROPIC_AUTH_TOKEN = value;
  }

  test("re-inject after switching back to subscription unsets the owned dummy token", async () => {
    trackingFile = trackingWithToken();
    launchctlBaseUrl = "http://127.0.0.1:4567";
    mockAuthTokenGetenv("opencodex-proxy");

    // EXPLICIT subscription, not auto: this asserts the switch-back strip, and under
    // auto the resolver would read the real machine's Claude auth and could legitimately
    // decide proxy (devlog 260726_claude_auth_auto/040).
    const subscription = {
      ...baseConfig,
      claudeCode: { systemEnv: true, authMode: "subscription" },
    } as unknown as OcxConfig;
    expect(await injectSystemEnv(4567, subscription)).toEqual({ injected: true });
    expect(execFileSpy).toHaveBeenCalledWith("/bin/launchctl", ["unsetenv", "ANTHROPIC_AUTH_TOKEN"]);
    expect(JSON.parse(trackingFile!).injectedKeys).not.toContain("ANTHROPIC_AUTH_TOKEN");
  });

  test("re-inject removes a tracked configured admission token in subscription mode", async () => {
    trackingFile = trackingWithToken();
    launchctlBaseUrl = "http://127.0.0.1:4567";
    mockAuthTokenGetenv("secret-token");
    const subscription = {
      ...baseConfig,
      claudeCode: { systemEnv: true, authMode: "subscription" },
      apiKeys: [{ id: "key-1", name: "Primary", key: "secret-token", createdAt: "2026-07-11T00:00:00.000Z" }],
    } as unknown as OcxConfig;

    expect(await injectSystemEnv(4567, subscription)).toEqual({ injected: true });
    expect(execFileSpy).toHaveBeenCalledWith("/bin/launchctl", ["unsetenv", "ANTHROPIC_AUTH_TOKEN"]);
    expect(JSON.parse(trackingFile!).injectedKeys).not.toContain("ANTHROPIC_AUTH_TOKEN");
  });

  test("re-inject preserves a tracked token whose value is not the opencodex dummy", async () => {
    trackingFile = trackingWithToken();
    launchctlBaseUrl = "http://127.0.0.1:4567";
    mockAuthTokenGetenv("sk-user-real-token");

    expect(await injectSystemEnv(4567, baseConfig)).toEqual({ injected: true });
    expect(launchctlCommands()).not.toContain("launchctl unsetenv ANTHROPIC_AUTH_TOKEN");
  });

  test("re-inject preserves an untracked dummy-valued token it does not own", async () => {
    // Ownership guard independent of the value guard (audit R2 #1): the launchd domain
    // carries "opencodex-proxy" but WE never injected it (not in injectedKeys).
    trackingFile = trackingWithToken(4567, ["ANTHROPIC_BASE_URL", "CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY"]);
    launchctlBaseUrl = "http://127.0.0.1:4567";
    mockAuthTokenGetenv("opencodex-proxy");

    expect(await injectSystemEnv(4567, baseConfig)).toEqual({ injected: true });
    expect(launchctlCommands()).not.toContain("launchctl unsetenv ANTHROPIC_AUTH_TOKEN");
  });
});

/**
 * A launchd-started `claude` is a local client (#4236): on a hub bound to a tailnet address the
 * only credential-free socket is the unauthenticated loopback listener, so that is the port the
 * injected ANTHROPIC_BASE_URL must name — in the launchd domain AND in the shell env file.
 *
 * The tracking record keeps three separate facts because they genuinely separate here: `port` is
 * the owning proxy's identity, `bindHost` is where its `/healthz` answers, and `clientBaseUrl` is
 * what was injected. The first round of this change recorded only a `clientPort` and probed
 * `127.0.0.1:<public port>` for liveness — an address that does not exist on this hub, so every
 * probe failed, the record was reverted on every start, and the "another instance owns env" guard
 * could never fire.
 */
describe("system environment local destination", () => {
  const hubConfig = (listener?: { enabled: boolean; port?: number }): OcxConfig => ({
    ...baseConfig,
    // Pinned rather than detected: the bind-address branch only injects when opencodex owns
    // authentication, so an ambient subscription on the test host would hide the case.
    claudeCode: { systemEnv: true, authMode: "proxy" },
    hostname: "100.76.170.81",
    runtimeRole: "hub",
    apiKeys: [{ id: "k1", name: "local", key: "ocx_data_this_proxy_key", createdAt: "2026-01-01T00:00:00Z" }],
    ...(listener ? { unauthenticatedLoopbackListener: listener } : {}),
  } as OcxConfig);

  function shellEnvBody(): string {
    const write = writeSpy.mock.calls.find(call => String(call[0]).includes("claude-env.sh"));
    return String(write?.[1] ?? "");
  }

  test("a ported listener moves both injected destinations, not the tracked identity", async () => {
    expect(await injectSystemEnv(4567, hubConfig({ enabled: true, port: 10104 }))).toEqual({ injected: true });
    expect(launchctlCommands()).toContain("launchctl setenv ANTHROPIC_BASE_URL http://127.0.0.1:10104");
    expect(shellEnvBody()).toContain("export ANTHROPIC_BASE_URL='http://127.0.0.1:10104'");
    // port stays the proxy's identity; bindHost is its /healthz host; clientBaseUrl is what
    // was injected. All three differ on this hub, which is why all three are recorded.
    expect(JSON.parse(trackingFile!)).toMatchObject({
      port: 4567,
      bindHost: "100.76.170.81",
      clientBaseUrl: "http://127.0.0.1:10104",
    });
  });

  test("with the listener OFF the bind address is injected, with the credential it demands", async () => {
    // The #4236 topology. `127.0.0.1:4567` does not exist here, so the first round's answer was
    // a dead socket in the machine-wide launchd domain.
    expect(await injectSystemEnv(4567, hubConfig())).toEqual({ injected: true });
    const commands = launchctlCommands();
    expect(commands).toContain("launchctl setenv ANTHROPIC_BASE_URL http://100.76.170.81:4567");
    expect(commands).toContain("launchctl setenv ANTHROPIC_AUTH_TOKEN ocx_data_this_proxy_key");
    expect(shellEnvBody()).toContain("export ANTHROPIC_BASE_URL='http://100.76.170.81:4567'");
    expect(shellEnvBody()).toContain("export ANTHROPIC_AUTH_TOKEN='ocx_data_this_proxy_key'");
    expect(JSON.parse(trackingFile!)).toMatchObject({
      port: 4567,
      bindHost: "100.76.170.81",
      clientBaseUrl: "http://100.76.170.81:4567",
    });
  });

  test("a destination that demands a credential nobody can supply is not injected at all", async () => {
    // The launchd domain is machine-wide: a base URL that 401s every plain `claude` on the box
    // is worse than no injection, so this degrades with a reason instead.
    const noCredential = { ...hubConfig(), apiKeys: [] } as OcxConfig;
    expect(await injectSystemEnv(4567, noCredential))
      .toEqual({ injected: false, reason: "local inference requires a data-plane credential" });
    expect(launchctlCommands().some(command => command.includes("setenv ANTHROPIC_BASE_URL"))).toBe(false);
  });

  test("the companion form and a plain install are unchanged", async () => {
    expect(await injectSystemEnv(4567, hubConfig({ enabled: true }))).toEqual({ injected: true });
    expect(launchctlCommands()).toContain("launchctl setenv ANTHROPIC_BASE_URL http://127.0.0.1:4567");
    // clientBaseUrl is omitted when it carries nothing beyond `port`; bindHost is still recorded,
    // because /healthz does NOT answer on loopback here.
    expect(JSON.parse(trackingFile!).clientBaseUrl).toBeUndefined();
    expect(JSON.parse(trackingFile!).bindHost).toBe("100.76.170.81");

    execFileSpy.mockClear();
    trackingFile = undefined;
    expect(await injectSystemEnv(4567, baseConfig)).toEqual({ injected: true });
    expect(launchctlCommands()).toContain("launchctl setenv ANTHROPIC_BASE_URL http://127.0.0.1:4567");
    // A plain loopback install writes the byte-identical record it always did: no new fields.
    const plain = JSON.parse(trackingFile!);
    expect(plain.clientBaseUrl).toBeUndefined();
    expect(plain.bindHost).toBeUndefined();
  });

  test("revert proves ownership against the injected base URL, not the tracked port", () => {
    trackingFile = JSON.stringify({
      pid: 123, port: 4567, bindHost: "100.76.170.81",
      clientBaseUrl: "http://127.0.0.1:10104", injectedAt: "2026-07-11T00:00:00.000Z",
    });
    // What launchd actually holds is the listener's port: that IS ours.
    launchctlBaseUrl = "http://127.0.0.1:10104";
    expect(revertSystemEnv()).toEqual({ reverted: true });
  });

  test("revert recognizes a bind-address injection as ours too", () => {
    trackingFile = JSON.stringify({
      pid: 123, port: 4567, bindHost: "100.76.170.81",
      clientBaseUrl: "http://100.76.170.81:4567", injectedAt: "2026-07-11T00:00:00.000Z",
    });
    launchctlBaseUrl = "http://100.76.170.81:4567";
    expect(revertSystemEnv()).toEqual({ reverted: true });
  });

  test("liveness is probed on the BIND host and the public port, never on the listener", async () => {
    // Two separate errors the first round made: the listener serves no /healthz (so probing its
    // port 404s and reverts a LIVE proxy's env), and 127.0.0.1 is not where this proxy listens
    // (so probing it failed every time and reverted on every start).
    trackingFile = JSON.stringify({
      pid: 123, port: 4567, bindHost: "100.76.170.81",
      clientBaseUrl: "http://127.0.0.1:10104", injectedAt: "2026-07-11T00:00:00.000Z",
    });
    launchctlBaseUrl = "http://127.0.0.1:10104";
    const probed: string[] = [];
    globalThis.fetch = mock(async (input: unknown) => {
      probed.push(String(input));
      return new Response("ok");
    }) as unknown as typeof fetch;

    expect(await cleanStaleSystemEnv()).toEqual({ cleaned: false, reason: "proxy still alive" });
    expect(probed).toEqual(["http://100.76.170.81:4567/healthz"]);
    expect(unlinkSpy).not.toHaveBeenCalled();
  });

  test("a record with no bindHost still probes loopback, so old records are read unchanged", async () => {
    trackingFile = JSON.stringify({ pid: 123, port: 4567, injectedAt: "2026-07-11T00:00:00.000Z" });
    launchctlBaseUrl = "http://127.0.0.1:4567";
    const probed: string[] = [];
    globalThis.fetch = mock(async (input: unknown) => {
      probed.push(String(input));
      return new Response("ok");
    }) as unknown as typeof fetch;

    expect(await cleanStaleSystemEnv()).toEqual({ cleaned: false, reason: "proxy still alive" });
    expect(probed).toEqual(["http://127.0.0.1:4567/healthz"]);
  });

  test("a tampered bindHost cannot become a probe URL", async () => {
    // This field is interpolated into a fetch URL, so the shape is validated on read. A record
    // carrying a path, a scheme, or whitespace falls back to loopback instead of being dialed.
    for (const bindHost of ["evil.example.com/../x", "http://evil.example.com", "a b", ""]) {
      trackingFile = JSON.stringify({ pid: 123, port: 4567, bindHost, injectedAt: "2026-07-11T00:00:00.000Z" });
      launchctlBaseUrl = "http://127.0.0.1:4567";
      const probed: string[] = [];
      globalThis.fetch = mock(async (input: unknown) => {
        probed.push(String(input));
        return new Response("ok");
      }) as unknown as typeof fetch;
      expect(await cleanStaleSystemEnv()).toEqual({ cleaned: false, reason: "proxy still alive" });
      expect({ bindHost, probed }).toEqual({ bindHost, probed: ["http://127.0.0.1:4567/healthz"] });
    }
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
      expect(execFileSpy).toHaveBeenCalledWith("/bin/launchctl", ["unsetenv", name]);
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

  test("revertSystemEnv ignores unrecognized names from a tampered tracking file", () => {
    trackingFile = JSON.stringify({
      pid: 123,
      port: 4567,
      injectedAt: "2026-07-11T00:00:00.000Z",
      injectedKeys: [
        "ANTHROPIC_BASE_URL",
        "CLAUDE_CODE_MAX_CONTEXT_TOKENS",
        "UNRELATED_USER_SETTING",
      ],
    });
    launchctlBaseUrl = "http://127.0.0.1:4567";

    expect(revertSystemEnv()).toEqual({ reverted: true });
    const unsetNames = execFileSpy.mock.calls
      .filter(call => call[0] === "/bin/launchctl" && (call[1] as string[])[0] === "unsetenv")
      .map(call => (call[1] as string[])[1]);
    expect(unsetNames).toContain("ANTHROPIC_BASE_URL");
    expect(unsetNames).toContain("CLAUDE_CODE_MAX_CONTEXT_TOKENS");
    expect(unsetNames).not.toContain("UNRELATED_USER_SETTING");
  });

  test("revertSystemEnv invokes launchctl without a command shell", () => {
    trackingFile = tracking();
    launchctlBaseUrl = "http://127.0.0.1:4567";

    expect(revertSystemEnv()).toEqual({ reverted: true });
    expect(execFileSpy).toHaveBeenCalledWith(
      "/bin/launchctl",
      ["unsetenv", "ANTHROPIC_BASE_URL"],
    );
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
    const setCalls = launchctlCommands();
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
    launchctlEnvValues.CLAUDE_CODE_MAX_CONTEXT_TOKENS = "777000";
    expect(await injectSystemEnv(4096, leverConfig)).toEqual({ injected: true });
    const setCalls = launchctlCommands();
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
    const setCalls = launchctlCommands();
    expect(setCalls.some(c => c.includes("CLAUDE_CODE_MAX_CONTEXT_TOKENS"))).toBe(false);
    expect(setCalls.some(c => c.includes("CLAUDE_CODE_ALWAYS_ENABLE_EFFORT"))).toBe(false);
    const shellWrite = writes.find(w => w.path.includes("claude-env.sh"));
    expect(shellWrite!.data).not.toContain("DISABLE_COMPACT");
  });

  test("auto-context default lever: AUTO_COMPACT_WINDOW 829800 injected, tracked, conditionally exported (devlog 020)", async () => {
    const writes = capturedWrites();
    expect(await injectSystemEnv(4096, baseConfig)).toEqual({ injected: true });
    const setCalls = launchctlCommands();
    expect(setCalls).toContain("launchctl setenv CLAUDE_CODE_AUTO_COMPACT_WINDOW 829800");
    const trackingWrite = writes.filter(w => w.path.includes("system-env-port")).at(-1);
    expect(JSON.parse(trackingWrite!.data).injectedKeys).toContain("CLAUDE_CODE_AUTO_COMPACT_WINDOW");
    const shellWrite = writes.find(w => w.path.includes("claude-env.sh"));
    expect(shellWrite!.data).toContain(`[ -z "\${CLAUDE_CODE_AUTO_COMPACT_WINDOW+x}" ] && export CLAUDE_CODE_AUTO_COMPACT_WINDOW='829800'`);
  });

  test("auto-context: user-preset launchctl value is respected and untracked (audit 021 #2)", async () => {
    const writes = capturedWrites();
    launchctlEnvValues.CLAUDE_CODE_AUTO_COMPACT_WINDOW = "500000";
    expect(await injectSystemEnv(4096, baseConfig)).toEqual({ injected: true });
    const setCalls = launchctlCommands();
    expect(setCalls.some(c => c.startsWith("launchctl setenv CLAUDE_CODE_AUTO_COMPACT_WINDOW"))).toBe(false);
    const trackingWrite = writes.filter(w => w.path.includes("system-env-port")).at(-1);
    expect(JSON.parse(trackingWrite!.data).injectedKeys).not.toContain("CLAUDE_CODE_AUTO_COMPACT_WINDOW");
  });

  test("auto-context stays inert while the maxContextTokens lever is set", async () => {
    capturedWrites();
    expect(await injectSystemEnv(4096, leverConfig)).toEqual({ injected: true });
    const setCalls = launchctlCommands();
    expect(setCalls.some(c => c.startsWith("launchctl setenv CLAUDE_CODE_AUTO_COMPACT_WINDOW"))).toBe(false);
  });

  test("tier slots inject ANTHROPIC_DEFAULT_*_MODEL via launchctl and conditional shell exports", async () => {
    const writes = capturedWrites();
    const tierConfig = {
      ...baseConfig,
      claudeCode: { systemEnv: true, tierModels: { opus: "cursor/gpt-5.6-luna", sonnet: "mock/small" } },
    } satisfies OcxConfig;
    expect(await injectSystemEnv(4096, tierConfig)).toEqual({ injected: true });
    const setCalls = launchctlCommands();
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

test("system-env preserves the shell seam without a back-import", () => {
  readSpy.mockRestore();
  expect(installShellHook).toBe(shellInstallHook);
  expect(getShellEnvFilePath).toBe(shellEnvFilePath);
  const shellSource = fs.readFileSync(repoPath("src/server/system-env-shell.ts"), "utf8");
  expect(shellSource.split("\n").some(line => /from\s+["']\.\/system-env["']/.test(line))).toBe(false);
  expect(fs.readFileSync(repoPath("src/server/system-env.ts"), "utf8")).toContain("catalog_busy");
});
