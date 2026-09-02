import { describe, expect, test } from "bun:test";
import { buildClaudeEnv, claudeNotFoundHint, ensureProxyForClaude, rootSkipPermissionsNotice, shouldAllowRootSkipPermissions } from "../src/cli/claude";
import { commandInvocation } from "../src/lib/win-exec";
import type { LivenessIo, LiveProxy } from "../src/server/proxy-liveness";
import type { OcxConfig } from "../src/types";

function cfg(extra?: Partial<OcxConfig>): OcxConfig {
  return {
    port: 10100,
    defaultProvider: "mock",
    providers: { mock: { adapter: "openai-chat", baseUrl: "http://x/v1" } },
    ...extra,
  } as OcxConfig;
}

/**
 * These cases assert SUBSCRIPTION behaviour, so detection must be pinned. Under `auto`
 * the resolver reads the real machine (files + keychain), and on a developer box with
 * no Claude auth it would legitimately resolve to proxy and invert every assertion.
 */
const AUTH_PRESENT = {
  authDetect: {
    readClaudeJson: () => ({ oauthAccount: { emailAddress: "dev-fixture" } }),
    credentialsFileExists: () => true,
    keychainProbe: () => "present" as const,
  },
};

describe("ocx claude proxy liveness", () => {
  test("retries the initial liveness probe before spawning a proxy", async () => {
    const seen: (number | undefined)[] = [];
    const findLiveProxy = async (io?: LivenessIo): Promise<LiveProxy> => {
      seen.push(io?.attempts);
      // retry semantics are covered by tests/proxy-liveness.test.ts:102-119; this pins that the launcher hands the stop-path budget down.
      return { pid: 4242, port: 10100, source: "runtime" };
    };

    expect(await ensureProxyForClaude({ findLiveProxy })).toBe(10100);
    expect(seen).toEqual([3]);
  });
});

describe("ocx claude env assembly", () => {
  test("connected target injects only the hub base and client admission token", () => {
    const env = buildClaudeEnv(cfg(), {
      baseUrl: "https://hub.example.test",
      admissionToken: "ocx_data_connected",
    }, {}, {}, AUTH_PRESENT);
    expect(env.ANTHROPIC_BASE_URL).toBe("https://hub.example.test");
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe("ocx_data_connected");
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST).toBe("1");
  });

  test("a connected target keeps its admission token even when the local env reads as subscription", () => {
    // #3148 resolves the auth mode before adding proxy-owned credentials, which is right for
    // an ordinary launch. A connected launch is different: the caller already named a hub and
    // supplied the client admission token for it, so a machine whose own environment looks
    // like a Claude subscription must not strip the credential the launch was built with.
    const env = buildClaudeEnv(cfg(), {
      baseUrl: "https://hub.example.test",
      admissionToken: "ocx_data_connected",
    }, {}, {}, { mode: "subscription", origin: "explicit" });
    expect(env.ANTHROPIC_BASE_URL).toBe("https://hub.example.test");
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe("ocx_data_connected");
  });

  test("user-owned connected destination wins and cannot receive the hub token", () => {
    const env = buildClaudeEnv(cfg(), {
      baseUrl: "https://hub.example.test",
      admissionToken: "ocx_data_connected",
    }, {
      ANTHROPIC_BASE_URL: "https://user-gateway.example.test",
      ANTHROPIC_AUTH_TOKEN: "ocx_data_connected",
    }, {}, {
      ...AUTH_PRESENT,
      preBunAnthropicSlots: ["ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN"],
    });
    expect(env.ANTHROPIC_BASE_URL).toBe("https://user-gateway.example.test");
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
  });

  test("root skip-permissions bypass requires both the explicit flag and uid 0", () => {
    expect(shouldAllowRootSkipPermissions(["--dangerously-skip-permissions"], () => 0)).toBe(true);
    expect(shouldAllowRootSkipPermissions([], () => 0)).toBe(false);
    expect(shouldAllowRootSkipPermissions(["--dangerously-skip-permissions"], () => 1000)).toBe(false);
    expect(shouldAllowRootSkipPermissions(["--dangerously-skip-permissions"], null)).toBe(false);
  });

  test("root skip-permissions opt-in marks only that launch as sandboxed", () => {
    const bypass = buildClaudeEnv(cfg(), 10100, {}, {}, {
      ...AUTH_PRESENT,
      allowRootSkipPermissions: true,
    });
    expect(bypass.IS_SANDBOX).toBe("1");

    const ordinary = buildClaudeEnv(cfg(), 10100, {}, {}, AUTH_PRESENT);
    expect(ordinary.IS_SANDBOX).toBeUndefined();
  });

  test("an explicit user sandbox value wins over the root skip-permissions opt-in", () => {
    const env = buildClaudeEnv(cfg(), 10100, { IS_SANDBOX: "0" }, {}, {
      ...AUTH_PRESENT,
      allowRootSkipPermissions: true,
    });
    expect(env.IS_SANDBOX).toBe("0");
    expect(rootSkipPermissionsNotice(env)).toContain("preserving user IS_SANDBOX=0");
    expect(rootSkipPermissionsNotice(env)).toContain("root guard remains in control");
  });

  test("the unsafe root bypass notice discloses that no OS sandbox was created", () => {
    const notice = rootSkipPermissionsNotice({ IS_SANDBOX: "1" });
    expect(notice).toContain("set IS_SANDBOX=1");
    expect(notice).toContain("did not create an OS sandbox");
  });

  test("injects base URL, discovery flag and model slots — NO auth token by default (subscription mode)", () => {
    const env = buildClaudeEnv(cfg({
      claudeCode: { model: "claude-ocx-gemini--gemini-3-pro", smallFastModel: "gemini/gemini-3-flash" },
    }), 10123, {}, {}, AUTH_PRESENT);
    expect(env.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:10123");
    // Setting ANTHROPIC_AUTH_TOKEN disables claude.ai connectors and kills subscription
    // OAuth — the launcher must leave it unset on an open loopback proxy.
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(env.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY).toBe("1");
    expect(env.ANTHROPIC_MODEL).toBe("claude-ocx-gemini--gemini-3-pro");
    expect(env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe("gemini/gemini-3-flash");
    expect(env.ANTHROPIC_SMALL_FAST_MODEL).toBe("gemini/gemini-3-flash");
    // Never both token vars (Claude Code auth-conflict warning, 003 E1).
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    // Do NOT set _CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL — it disables gateway model discovery.
    expect(env._CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL).toBeUndefined();
  });

  test("configured API key becomes the auth token (admission required)", () => {
    const env = buildClaudeEnv(cfg({
      apiKeys: [{ id: "1", name: "main", key: "sk-ocx-123", createdAt: "2026-01-01" }],
      claudeCode: { authMode: "proxy" },
    }), 10100, {});
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe("sk-ocx-123");
  });

  test("subscription mode keeps configured proxy keys out of Claude auth", () => {
    const env = buildClaudeEnv(cfg({
      apiKeys: [{ id: "1", name: "main", key: "sk-ocx-123", createdAt: "2026-01-01" }],
      claudeCode: { authMode: "subscription" },
    }), 10100, {}, {}, AUTH_PRESENT);
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST).toBeUndefined();
  });

  test("subscription mode removes an inherited proxy admission token", () => {
    const env = buildClaudeEnv(cfg({
      apiKeys: [{ id: "1", name: "main", key: "ocx_data_this_proxy_key", createdAt: "2026-01-01" }],
      claudeCode: { authMode: "subscription" },
    }), 10100, {
      ANTHROPIC_AUTH_TOKEN: "ocx_data_this_proxy_key",
    }, {}, {
      ...AUTH_PRESENT,
      preBunAnthropicSlots: ["ANTHROPIC_AUTH_TOKEN"],
    });
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST).toBeUndefined();
  });

  // Host-managed routing guard (devlog 260720_claude_authmode_persist/020):
  // defends the spawn env against leftover cc-switch/CCR settings.json env hijack.
  test("subscription mode leaves the host-managed auth assertion unset", () => {
    const env = buildClaudeEnv(cfg({ claudeCode: {} }), 10100, {}, {}, AUTH_PRESENT);
    expect(env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST).toBeUndefined();
  });

  test("proxy-owned authentication sets CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST=1", () => {
    const proxy = buildClaudeEnv(cfg({ claudeCode: { authMode: "proxy" } }), 10100, {});
    expect(proxy.ANTHROPIC_AUTH_TOKEN).toBe("opencodex-proxy");
    expect(proxy.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST).toBe("1");

    const admission = buildClaudeEnv(cfg({
      apiKeys: [{ id: "1", name: "main", key: "sk-ocx-123", createdAt: "2026-01-01" }],
      claudeCode: { authMode: "proxy" },
    }), 10100, {});
    expect(admission.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST).toBe("1");
  });

  test("a user pre-export of the host-managed flag wins (opt-out preserved)", () => {
    const env = buildClaudeEnv(cfg({ claudeCode: {} }), 10100, {
      CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: "0",
    }, {}, AUTH_PRESENT);
    // isEnvTruthy("0") is false inside Claude Code, so "0" disables the strip.
    expect(env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST).toBe("0");
  });

  test("model-slot injection is independent of the host-managed flag", () => {
    // With no configured model, the flag rides along but no model slots appear —
    // the intentional contract: settings.env slots are stripped by Claude Code,
    // so users migrate to config model or the top-level settings "model" field.
    const env = buildClaudeEnv(cfg({ claudeCode: {} }), 10100, {}, {}, AUTH_PRESENT);
    expect(env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST).toBeUndefined();
    expect(env.ANTHROPIC_MODEL).toBeUndefined();
    // And with a configured model both coexist.
    const withModel = buildClaudeEnv(cfg({ claudeCode: { model: "mock/test-model" } }), 10100, {}, {}, AUTH_PRESENT);
    expect(withModel.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST).toBeUndefined();
    expect(withModel.ANTHROPIC_MODEL).toBe("mock/test-model");
  });

  test("lever env defaults OFF: no effort forcing, no context override (devlog 136 B6)", () => {
    const env = buildClaudeEnv(cfg({ claudeCode: {} }), 10100, {});
    expect(env.CLAUDE_CODE_ALWAYS_ENABLE_EFFORT).toBeUndefined();
    expect(env.CLAUDE_CODE_MAX_CONTEXT_TOKENS).toBeUndefined();
    expect(env.DISABLE_COMPACT).toBeUndefined();
    // Auto-context IS on by default (devlog 020). The window now matches the auto-compaction
    // limit the Codex catalog ships for the same native rows (829,800 under a 922,000 window),
    // so one model does not compact at two different points depending on the client.
    expect(env.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe("829800");
  });

  test("opt-in levers: alwaysEnableEffort=1, maxContextTokens injects the official pair", () => {
    const env = buildClaudeEnv(cfg({
      claudeCode: { alwaysEnableEffort: true, maxContextTokens: 1_000_000 },
    }), 10100, {});
    expect(env.CLAUDE_CODE_ALWAYS_ENABLE_EFFORT).toBe("1");
    expect(env.CLAUDE_CODE_MAX_CONTEXT_TOKENS).toBe("1000000");
    // MAX_CONTEXT_TOKENS alone is ignored for recognized claude-shaped ids; the
    // official pair requires DISABLE_COMPACT (exact name, no CLAUDE_CODE_ prefix).
    expect(env.DISABLE_COMPACT).toBe("1");
    // Legacy override wins rule-1 inside the CLI -> auto-context stays inert.
    expect(env.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBeUndefined();
  });

  test("user-exported lever values win over config levers", () => {
    const env = buildClaudeEnv(cfg({
      claudeCode: { alwaysEnableEffort: true, maxContextTokens: 1_000_000 },
    }), 10100, {
      CLAUDE_CODE_MAX_CONTEXT_TOKENS: "500000",
      DISABLE_COMPACT: "0",
      CLAUDE_CODE_ALWAYS_ENABLE_EFFORT: "0",
    });
    expect(env.CLAUDE_CODE_MAX_CONTEXT_TOKENS).toBe("500000");
    expect(env.DISABLE_COMPACT).toBe("0");
    expect(env.CLAUDE_CODE_ALWAYS_ENABLE_EFFORT).toBe("0");
  });

  test("invalid maxContextTokens values inject nothing", () => {
    for (const bad of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const env = buildClaudeEnv(cfg({ claudeCode: { maxContextTokens: bad } }), 10100, {});
      expect(env.CLAUDE_CODE_MAX_CONTEXT_TOKENS).toBeUndefined();
      expect(env.DISABLE_COMPACT).toBeUndefined();
    }
  });

  test("tier slots inject ANTHROPIC_DEFAULT_*_MODEL with [1m] auto-marking (devlog 260712 B2)", () => {
    const windows = { "cursor/gpt-5.6-luna": 1_000_000, "mock/small": 128_000 };
    const env = buildClaudeEnv(cfg({
      claudeCode: {
        model: "cursor/gpt-5.6-luna",
        smallFastModel: "mock/small",
        tierModels: { opus: "cursor/gpt-5.6-luna", sonnet: "mock/small", fable: "cursor/gpt-5.6-luna[1m]" },
      },
    }), 10100, {}, windows);
    expect(env.ANTHROPIC_MODEL).toBe("cursor/gpt-5.6-luna[1m]");
    expect(env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe("cursor/gpt-5.6-luna[1m]");
    expect(env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe("mock/small");
    // already-marked value passes through unchanged (no double suffix).
    expect(env.ANTHROPIC_DEFAULT_FABLE_MODEL).toBe("cursor/gpt-5.6-luna[1m]");
    // effective-haiku feeds both variables.
    expect(env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe("mock/small");
    expect(env.ANTHROPIC_SMALL_FAST_MODEL).toBe("mock/small");
  });

  test("user-exported tier slots win over config tier slots", () => {
    const env = buildClaudeEnv(cfg({
      claudeCode: { tierModels: { opus: "cursor/gpt-5.6-luna" } },
    }), 10100, { ANTHROPIC_DEFAULT_OPUS_MODEL: "my-own" }, { "cursor/gpt-5.6-luna": 1_000_000 });
    expect(env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe("my-own");
  });

  test("no context map -> no [1m] marking (conservative fallback)", () => {
    const env = buildClaudeEnv(cfg({ claudeCode: { model: "cursor/gpt-5.6-luna" } }), 10100, {});
    expect(env.ANTHROPIC_MODEL).toBe("cursor/gpt-5.6-luna");
  });

  test("auto-context: a slot wide enough for the compact window gets [1m], and the window rides along (devlog 020)", () => {
    // The fixture has to clear the default compact window (829,800) — marking a model that
    // cannot host it is the #854 defect the predicate exists to prevent.
    const windows = { "mock/big": 900_000, "mock/small": 128_000 };
    const env = buildClaudeEnv(cfg({
      claudeCode: { model: "mock/big", smallFastModel: "mock/small" },
    }), 10100, {}, windows);
    expect(env.ANTHROPIC_MODEL).toBe("mock/big[1m]");
    expect(env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe("mock/small"); // below floor, unmarked
    expect(env.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe("829800");
    // And a real native row at 922,000 clears it too — that is the model this default tracks.
    const native = buildClaudeEnv(cfg({
      claudeCode: { model: "gpt-5.6-sol" },
    }), 10100, {}, { "gpt-5.6-sol": 922_000 });
    expect(native.ANTHROPIC_MODEL).toBe("gpt-5.6-sol[1m]");
  });

  test("auto-context: custom window moves both the env and the marking threshold", () => {
    const windows = { "mock/big": 372_000 };
    const env = buildClaudeEnv(cfg({
      claudeCode: { model: "mock/big", autoCompactWindow: 380_000 },
    }), 10100, {}, windows);
    // 372k real < 380k threshold -> marking would strand the safety net: no [1m].
    expect(env.ANTHROPIC_MODEL).toBe("mock/big");
    expect(env.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe("380000");
  });

  test("auto-context: user-exported env value drives the predicate (audit 021 #2)", () => {
    const windows = { "mock/big": 372_000 };
    // User exported 500k: 372k model must NOT be marked (threshold beyond real window).
    const env = buildClaudeEnv(cfg({
      claudeCode: { model: "mock/big" },
    }), 10100, { CLAUDE_CODE_AUTO_COMPACT_WINDOW: "500000" }, windows);
    expect(env.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe("500000"); // user wins
    expect(env.ANTHROPIC_MODEL).toBe("mock/big");
    // Invalid user value: CLI would ignore it -> auto marking fully disabled.
    const env2 = buildClaudeEnv(cfg({
      claudeCode: { model: "mock/big" },
    }), 10100, { CLAUDE_CODE_AUTO_COMPACT_WINDOW: "banana" }, windows);
    expect(env2.ANTHROPIC_MODEL).toBe("mock/big");
    expect(env2.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe("banana"); // untouched (user wins)
    // >=1M models still get marked even with an invalid override (non-auto path).
    const env3 = buildClaudeEnv(cfg({
      claudeCode: { model: "mock/huge" },
    }), 10100, { CLAUDE_CODE_AUTO_COMPACT_WINDOW: "banana" }, { "mock/huge": 1_000_000 });
    expect(env3.ANTHROPIC_MODEL).toBe("mock/huge[1m]");
  });

  test("auto-context off: no env injection, no sub-1M marking", () => {
    const windows = { "mock/big": 372_000 };
    const env = buildClaudeEnv(cfg({
      claudeCode: { model: "mock/big", autoContext: false },
    }), 10100, {}, windows);
    expect(env.ANTHROPIC_MODEL).toBe("mock/big");
    expect(env.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBeUndefined();
  });

  test("user-exported env always wins; unset slots stay unset", () => {
    const env = buildClaudeEnv(cfg(), 10100, {
      ANTHROPIC_BASE_URL: "http://my-own-gateway:9",
      ANTHROPIC_MODEL: "my-model",
      PATH: "/usr/bin",
    }, {}, { preBunAnthropicSlots: ["ANTHROPIC_BASE_URL"] });
    expect(env.ANTHROPIC_BASE_URL).toBe("http://my-own-gateway:9");
    expect(env.ANTHROPIC_MODEL).toBe("my-model");
    expect(env.PATH).toBe("/usr/bin");
    expect(env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBeUndefined();
    expect(env.ANTHROPIC_SMALL_FAST_MODEL).toBeUndefined();
  });

  // A stale loopback ANTHROPIC_BASE_URL is rewritten to this launch's port. The credentials
  // in that environment were minted by the proxy we just stopped pointing at, so keeping
  // them makes Claude Code launch as a host-managed provider instead of using its own
  // subscription OAuth.
  test("replacing a stale loopback base URL drops the admission credential paired with it", () => {
    // This proxy requires no admission key, so the launch must stay in subscription mode.
    // The inherited token was minted by the proxy on :19999 that we just stopped targeting.
    const env = buildClaudeEnv(cfg(), 10100, {
      ANTHROPIC_BASE_URL: "http://127.0.0.1:19999",
      ANTHROPIC_AUTH_TOKEN: "ocx_data_other_proxy_key",
    }, {}, { ...AUTH_PRESENT, preBunAnthropicSlots: ["ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN"] });
    expect(env.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:10100");
    // A surviving token makes Claude Code authenticate as a host-managed provider and
    // overrides the caller's own claude.ai OAuth.
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
  });

  test("a stale admission token is replaced by THIS proxy's key, never carried over", () => {
    const env = buildClaudeEnv(
      cfg({
        claudeCode: { authMode: "proxy" },
        apiKeys: [{ id: "k1", name: "local", key: "ocx_data_this_proxy_key", createdAt: "2026-01-01T00:00:00Z" }],
      }),
      10100,
      {
        ANTHROPIC_BASE_URL: "http://127.0.0.1:19999",
        ANTHROPIC_AUTH_TOKEN: "ocx_data_other_proxy_key",
      },
      {},
      { ...AUTH_PRESENT, preBunAnthropicSlots: ["ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN"] },
    );
    expect(env.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:10100");
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe("ocx_data_this_proxy_key");
  });

  test("a user sk-ant- credential survives the stale base-URL rewrite (native passthrough auth)", () => {
    const env = buildClaudeEnv(cfg(), 10100, {
      ANTHROPIC_BASE_URL: "http://127.0.0.1:19999",
      ANTHROPIC_API_KEY: "sk-ant-user-owned-key",
    }, {}, { ...AUTH_PRESENT, preBunAnthropicSlots: ["ANTHROPIC_BASE_URL", "ANTHROPIC_API_KEY"] });
    expect(env.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:10100");
    expect(env.ANTHROPIC_API_KEY).toBe("sk-ant-user-owned-key");
  });

});

describe("ocx claude Windows launch (devlog 260715_cross_platform_audit/020)", () => {
  test("win32 .cmd shim launches through cmd.exe with preserved arg boundaries", () => {
    const deps = {
      env: { PATH: "C:\\Users\\u\\AppData\\Roaming\\npm", ComSpec: "C:\\WINDOWS\\system32\\cmd.exe" },
      exists: (p: string) => p === "C:\\Users\\u\\AppData\\Roaming\\npm\\claude.cmd",
    };
    const inv = commandInvocation("claude", ["chat", "hello world", 'say "hi"', "50%"], "win32", deps);
    expect(inv.file).toBe("C:\\WINDOWS\\system32\\cmd.exe");
    expect(inv.args.slice(0, 3)).toEqual(["/d", "/s", "/c"]);
    expect(inv.args[3]).toBe(
      '"C:\\Users\\u\\AppData\\Roaming\\npm\\claude.cmd ^"chat^" ^"hello^ world^" ^"say^ \\^"hi\\^"^" ^"50^%^""',
    );
    expect(inv.options).toEqual({ windowsVerbatimArguments: true });
  });

  test("POSIX launch is byte-identical to the pre-launcher behavior", () => {
    expect(commandInvocation("claude", ["chat"], "darwin"))
      .toEqual({ file: "claude", args: ["chat"], options: {} });
  });

  test("exit-9009 hint fires only for win32 non-signal not-found exits", () => {
    expect(claudeNotFoundHint(9009, null, "win32")).toContain("npm install -g @anthropic-ai/claude-code");
    expect(claudeNotFoundHint(9009, "SIGTERM", "win32")).toBeNull();
    expect(claudeNotFoundHint(9009, null, "darwin")).toBeNull();
    expect(claudeNotFoundHint(1, null, "win32")).toBeNull();
    expect(claudeNotFoundHint(0, null, "win32")).toBeNull();
  });
});
