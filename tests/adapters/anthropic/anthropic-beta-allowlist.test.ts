/**
 * The caller `anthropic-beta` allowlist of the managed native Messages lane (PF-10,
 * src/adapters/anthropic/beta-allowlist.ts) and how the builder applies it: per provider class,
 * unknown values dropped, allowlisted values re-spelled from the list, proxy-owned betas kept.
 */
import { describe, expect, test } from "bun:test";
import { ANTHROPIC_OAUTH_BETA } from "../../../src/oauth/anthropic";
import {
  allowlistAnthropicBetas,
  anthropicBetaAllowlist,
} from "../../../src/adapters/anthropic/beta-allowlist";
import { buildAnthropicMessagesPassthroughRequest } from "../../../src/adapters/anthropic/passthrough";
import type { OcxProviderConfig } from "../../../src/types";

const ALLOWED = "interleaved-thinking-2025-05-14";
const UNKNOWN = "fixture-unknown-beta-2099-01-01";

function provider(overrides: Partial<OcxProviderConfig> = {}): OcxProviderConfig {
  return {
    adapter: "anthropic",
    baseUrl: "https://api.anthropic.com",
    authMode: "key",
    apiKey: "fixture-managed-key",
    ...overrides,
  } as OcxProviderConfig;
}

const BODY = { model: "selector", max_tokens: 16, messages: [{ role: "user", content: "fixture" }] };

describe("allowlistAnthropicBetas", () => {
  test("first-party keeps listed values and drops the rest", () => {
    expect(anthropicBetaAllowlist("first-party")).toContain(ALLOWED);
    expect(allowlistAnthropicBetas(`${ALLOWED}, ${UNKNOWN}`, "first-party")).toEqual({ betas: [ALLOWED], dropped: true });
    expect(allowlistAnthropicBetas(ALLOWED, "first-party")).toEqual({ betas: [ALLOWED], dropped: false });
  });

  test("an Anthropic-compatible third party forwards nothing", () => {
    expect(anthropicBetaAllowlist("compatible")).toEqual([]);
    expect(allowlistAnthropicBetas(ALLOWED, "compatible")).toEqual({ betas: [], dropped: true });
  });

  test("matching is case-insensitive and the output is the list's own spelling, deduplicated", () => {
    const result = allowlistAnthropicBetas(` ${ALLOWED.toUpperCase()} ,${ALLOWED},,`, "first-party");
    expect(result).toEqual({ betas: [ALLOWED], dropped: false });
  });

  test("absent or blank headers drop nothing; an oversized header is dropped whole", () => {
    expect(allowlistAnthropicBetas(undefined, "first-party")).toEqual({ betas: [], dropped: false });
    expect(allowlistAnthropicBetas(null, "first-party")).toEqual({ betas: [], dropped: false });
    expect(allowlistAnthropicBetas("  ", "first-party")).toEqual({ betas: [], dropped: false });
    expect(allowlistAnthropicBetas(`${ALLOWED},${"x".repeat(4096)}`, "first-party")).toEqual({ betas: [], dropped: true });
  });

  test("a proxy-owned beta is never taken from the caller", () => {
    for (const beta of ANTHROPIC_OAUTH_BETA.split(",")) {
      expect(allowlistAnthropicBetas(beta, "first-party").betas).toEqual([]);
    }
  });
});

describe("the builder applies the allowlist", () => {
  test("first-party key: the allowlisted value is sent, the unknown one is not", () => {
    const built = buildAnthropicMessagesPassthroughRequest(provider(), "claude-wire", BODY, undefined, {
      callerAnthropicBeta: `${UNKNOWN},${ALLOWED}`,
    });
    expect(built.headers["anthropic-beta"]).toBe(ALLOWED);
    expect(built.droppedBetas).toBe(true);
    expect(JSON.stringify(built.headers)).not.toContain(UNKNOWN);
  });

  test("compatible key: no caller beta reaches the provider", () => {
    const built = buildAnthropicMessagesPassthroughRequest(
      provider({ baseUrl: "https://compatible.example/anthropic" }), "claude-wire", BODY, undefined,
      { callerAnthropicBeta: ALLOWED },
    );
    expect(built.headers).not.toHaveProperty("anthropic-beta");
    expect(built.droppedBetas).toBe(true);
  });

  test("an operator-configured beta is kept and merged with the allowlisted caller value", () => {
    const built = buildAnthropicMessagesPassthroughRequest(
      provider({ headers: { "Anthropic-Beta": "operator-beta" } }), "claude-wire", BODY, undefined,
      { callerAnthropicBeta: ALLOWED },
    );
    expect(built.headers["anthropic-beta"]).toBe(`operator-beta,${ALLOWED}`);
    expect(built.headers).not.toHaveProperty("Anthropic-Beta");
  });

  test("OAuth keeps its own beta pair and adds only the allowlisted caller value", () => {
    const built = buildAnthropicMessagesPassthroughRequest(
      provider({ authMode: "oauth", apiKey: "fixture-oauth-access" }), "claude-wire", BODY, undefined,
      { callerAnthropicBeta: `${ALLOWED},${UNKNOWN}` },
    );
    expect(built.headers["anthropic-beta"]).toBe(`${ANTHROPIC_OAUTH_BETA},${ALLOWED}`);
    expect(built.droppedBetas).toBe(true);
  });

  test("with no caller header nothing is dropped", () => {
    const built = buildAnthropicMessagesPassthroughRequest(provider(), "claude-wire", BODY);
    expect(built.droppedBetas).toBe(false);
    expect(built.headers).not.toHaveProperty("anthropic-beta");
  });
});
