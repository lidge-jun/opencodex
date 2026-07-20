import { describe, expect, test } from "bun:test";
import { claudeNotFoundHint } from "../src/cli/claude";
import { commandInvocation } from "../src/lib/win-exec";
import { buildClaudeEnv } from "../src/cli/claude";
import type { OcxConfig } from "../src/types";

function cfg(extra?: Partial<OcxConfig>): OcxConfig {
  return {
    port: 10100,
    defaultProvider: "mock",
    providers: { mock: { adapter: "openai-chat", baseUrl: "http://x/v1" } },
    ...extra,
  } as OcxConfig;
}

describe("ocx claude env assembly", () => {
  test("injects base URL, discovery flag and model slots — NO auth token by default (subscription mode)", () => {
    const env = buildClaudeEnv(cfg({
      claudeCode: { model: "claude-ocx-gemini--gemini-3-pro", smallFastModel: "gemini/gemini-3-flash" },
    }), 10123, {});
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
    }), 10100, {});
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe("sk-ocx-123");
  });

  // Host-managed routing guard (devlog 260720_claude_authmode_persist/020):
  // defends the spawn env against leftover cc-switch/CCR settings.json env hijack.
  test("sets CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST=1 by default", () => {
    const env = buildClaudeEnv(cfg({ claudeCode: {} }), 10100, {});
    expect(env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST).toBe("1");
  });

  test("a user pre-export of the host-managed flag wins (opt-out preserved)", () => {
    const env = buildClaudeEnv(cfg({ claudeCode: {} }), 10100, {
      CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: "0",
    });
    // isEnvTruthy("0") is false inside Claude Code, so "0" disables the strip.
    expect(env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST).toBe("0");
  });

  test("model-slot injection is independent of the host-managed flag", () => {
    // With no configured model, the flag rides along but no model slots appear —
    // the intentional contract: settings.env slots are stripped by Claude Code,
    // so users migrate to config model or the top-level settings "model" field.
    const env = buildClaudeEnv(cfg({ claudeCode: {} }), 10100, {});
    expect(env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST).toBe("1");
    expect(env.ANTHROPIC_MODEL).toBeUndefined();
    // And with a configured model both coexist.
    const withModel = buildClaudeEnv(cfg({ claudeCode: { model: "mock/test-model" } }), 10100, {});
    expect(withModel.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST).toBe("1");
    expect(withModel.ANTHROPIC_MODEL).toBe("mock/test-model");
  });

  test("lever env defaults OFF: no effort forcing, no context override (devlog 136 B6)", () => {
    const env = buildClaudeEnv(cfg({ claudeCode: {} }), 10100, {});
    expect(env.CLAUDE_CODE_ALWAYS_ENABLE_EFFORT).toBeUndefined();
    expect(env.CLAUDE_CODE_MAX_CONTEXT_TOKENS).toBeUndefined();
    expect(env.DISABLE_COMPACT).toBeUndefined();
    // Auto-context IS on by default (devlog 020): compact window injected at 350k.
    expect(env.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe("350000");
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

  test("auto-context: 372k slot gets [1m] + compact window rides along (devlog 020)", () => {
    const windows = { "mock/big": 372_000, "mock/small": 128_000 };
    const env = buildClaudeEnv(cfg({
      claudeCode: { model: "mock/big", smallFastModel: "mock/small" },
    }), 10100, {}, windows);
    expect(env.ANTHROPIC_MODEL).toBe("mock/big[1m]");
    expect(env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe("mock/small"); // below floor, unmarked
    expect(env.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe("350000");
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
    });
    expect(env.ANTHROPIC_BASE_URL).toBe("http://my-own-gateway:9");
    expect(env.ANTHROPIC_MODEL).toBe("my-model");
    expect(env.PATH).toBe("/usr/bin");
    expect(env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBeUndefined();
    expect(env.ANTHROPIC_SMALL_FAST_MODEL).toBeUndefined();
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
