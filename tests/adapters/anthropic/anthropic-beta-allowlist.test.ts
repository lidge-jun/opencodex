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
  CONTEXT_MANAGEMENT_BETA,
  logDroppedAnthropicBetas,
} from "../../../src/adapters/anthropic/beta-allowlist";
import { buildAnthropicMessagesPassthroughRequest } from "../../../src/adapters/anthropic/passthrough";
import { captureAnthropicClientIdentity } from "../../../src/adapters/anthropic/client-identity";
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
    expect(allowlistAnthropicBetas(`${ALLOWED}, ${UNKNOWN}`, "first-party")).toMatchObject({ betas: [ALLOWED], dropped: true });
    expect(allowlistAnthropicBetas(ALLOWED, "first-party")).toMatchObject({ betas: [ALLOWED], dropped: false });
  });

  test("an Anthropic-compatible third party forwards nothing", () => {
    expect(anthropicBetaAllowlist("compatible")).toEqual([]);
    expect(allowlistAnthropicBetas(ALLOWED, "compatible")).toMatchObject({ betas: [], dropped: true });
  });

  test("matching is case-insensitive and the output is the list's own spelling, deduplicated", () => {
    const result = allowlistAnthropicBetas(` ${ALLOWED.toUpperCase()} ,${ALLOWED},,`, "first-party");
    expect(result).toMatchObject({ betas: [ALLOWED], dropped: false });
  });

  test("absent or blank headers drop nothing; an oversized header is dropped whole", () => {
    expect(allowlistAnthropicBetas(undefined, "first-party")).toMatchObject({ betas: [], dropped: false });
    expect(allowlistAnthropicBetas(null, "first-party")).toMatchObject({ betas: [], dropped: false });
    expect(allowlistAnthropicBetas("  ", "first-party")).toMatchObject({ betas: [], dropped: false });
    expect(allowlistAnthropicBetas(`${ALLOWED},${"x".repeat(4096)}`, "first-party")).toMatchObject({ betas: [], dropped: true });
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

describe('observed native client feature betas', () => {
  const nativeBetas = ['advisor-tool-2026-03-01', 'per-turn-control-2026-07-01', 'redact-thinking-2026-02-12', 'inline-tools-2026-09-15', 'thinking-display-updates-2026-08-18', 'prompt-caching-scope-2026-01-05', 'mid-conversation-system-2026-04-07'];
  test('keeps required schemas only for an observed first-party native client', () => {
    expect(allowlistAnthropicBetas(nativeBetas.join(','), 'first-party', { observedNativeClient: true })).toMatchObject({betas:nativeBetas, dropped:false});
    expect(allowlistAnthropicBetas(nativeBetas.join(','), 'first-party')).toMatchObject({betas:[], dropped:true});
    expect(allowlistAnthropicBetas(nativeBetas.join(','), 'compatible', { observedNativeClient: true })).toMatchObject({betas:[], dropped:true});
  });
  test('unknown betas remain excluded for an observed native client', () => {
    expect(allowlistAnthropicBetas('inline-tools-2026-09-15,unknown-fixture-2099-01-01','first-party',{ observedNativeClient: true })).toMatchObject({betas:['inline-tools-2026-09-15'],dropped:true});
  });
});

describe("context management (#7042)", () => {
  const CONTEXT_MANAGEMENT = { edits: [{ type: "clear_tool_uses_20250919" }] };
  const source = { ...BODY, context_management: CONTEXT_MANAGEMENT };
  const observed = captureAnthropicClientIdentity(new Headers({
    "User-Agent": "claude-cli/2.1.296 (external, cli)",
    "X-App": "cli",
    "X-Claude-Code-Session-Id": "11111111-1111-4111-8111-111111111111",
    "X-Stainless-Lang": "js",
    "X-Stainless-Runtime": "node",
  }));

  test("an observed native client keeps the beta and its body field together", () => {
    expect(allowlistAnthropicBetas(CONTEXT_MANAGEMENT_BETA, "first-party", { observedNativeClient: true }).betas)
      .toEqual([CONTEXT_MANAGEMENT_BETA]);
  });

  test("the body field is forwarded only when its beta is", () => {
    expect(observed).toBeDefined();
    const withBeta = buildAnthropicMessagesPassthroughRequest(provider(), "claude-wire", source, undefined, {
      callerAnthropicBeta: CONTEXT_MANAGEMENT_BETA, clientIdentity: observed,
    });
    expect(withBeta.headers["anthropic-beta"]).toBe(CONTEXT_MANAGEMENT_BETA);
    expect(withBeta.wireBody.context_management).toEqual(CONTEXT_MANAGEMENT);
    expect(JSON.parse(withBeta.body).context_management).toEqual(CONTEXT_MANAGEMENT);
    const oauth = buildAnthropicMessagesPassthroughRequest(
      provider({ authMode: "oauth", apiKey: "fixture-oauth-access" }), "claude-wire", source, undefined,
      { callerAnthropicBeta: CONTEXT_MANAGEMENT_BETA, clientIdentity: observed },
    );
    expect(oauth.headers["anthropic-beta"]).toBe(`${ANTHROPIC_OAUTH_BETA},${CONTEXT_MANAGEMENT_BETA}`);
    expect(oauth.wireBody.context_management).toEqual(CONTEXT_MANAGEMENT);
    const withoutBeta = buildAnthropicMessagesPassthroughRequest(provider(), "claude-wire", source, undefined, {
      clientIdentity: observed,
    });
    expect(withoutBeta.wireBody).not.toHaveProperty("context_management");
  });

  test("OAuth rewrites exclude_tools to the prefixed wire names of declared client tools", () => {
    const managed = {
      ...BODY,
      tools: [{ name: "lookup", input_schema: { type: "object" } }, { type: "web_search_20250305", name: "web_search" }],
      context_management: { edits: [{ type: "clear_tool_uses_20250919", exclude_tools: ["lookup", "web_search", "undeclared"] }] },
    };
    const oauth = buildAnthropicMessagesPassthroughRequest(
      provider({ authMode: "oauth", apiKey: "fixture-oauth-access" }), "claude-wire", managed, undefined,
      { callerAnthropicBeta: CONTEXT_MANAGEMENT_BETA, clientIdentity: observed },
    );
    const wireTool = (oauth.wireBody.tools as Array<{ name: string }>)[0]!.name;
    expect(wireTool).not.toBe("lookup");
    expect(oauth.wireBody.context_management).toEqual({
      edits: [{ type: "clear_tool_uses_20250919", exclude_tools: [wireTool, "web_search", "undeclared"] }],
    });
    // The caller's body is never mutated.
    expect(managed.context_management.edits[0]!.exclude_tools).toEqual(["lookup", "web_search", "undeclared"]);
    const key = buildAnthropicMessagesPassthroughRequest(provider(), "claude-wire", managed, undefined,
      { callerAnthropicBeta: CONTEXT_MANAGEMENT_BETA, clientIdentity: observed });
    expect(key.wireBody.context_management).toBe(managed.context_management);
    const generic = buildAnthropicMessagesPassthroughRequest(provider(), "claude-wire", source, undefined, {
      callerAnthropicBeta: CONTEXT_MANAGEMENT_BETA,
    });
    expect(generic.headers).not.toHaveProperty("anthropic-beta");
    expect(generic.wireBody).not.toHaveProperty("context_management");
    const compatible = buildAnthropicMessagesPassthroughRequest(
      provider({ baseUrl: "https://compatible.example/anthropic" }), "claude-wire", source, undefined,
      { callerAnthropicBeta: CONTEXT_MANAGEMENT_BETA, clientIdentity: observed },
    );
    expect(compatible.wireBody).not.toHaveProperty("context_management");
  });
});

describe("dropped beta names (#7042)", () => {
  test("only known beta names are named; a caller-chosen dated value is counted, never echoed", () => {
    const result = allowlistAnthropicBetas(
      `${UNKNOWN},effort-2025-11-24,EFFORT-2025-11-24,customer-acme-2026-10-13,sk-ant-fixture-secret,${ALLOWED}`, "first-party",
    );
    expect(result).toEqual({
      betas: [ALLOWED], dropped: true,
      droppedNames: ["effort-2025-11-24"], droppedUnrecognized: 3,
    });
    expect(allowlistAnthropicBetas(CONTEXT_MANAGEMENT_BETA, "first-party").droppedNames).toEqual([CONTEXT_MANAGEMENT_BETA]);
  });

  test("the log line names each distinct set once and never echoes unshaped values", () => {
    const lines: string[] = [];
    const warn = (line: string) => lines.push(line);
    logDroppedAnthropicBetas({ droppedNames: ["zeta-fixture-2099-01-02", "alpha-fixture-2099-01-01"], droppedUnrecognized: 2 }, warn);
    logDroppedAnthropicBetas({ droppedNames: ["alpha-fixture-2099-01-01", "zeta-fixture-2099-01-02"], droppedUnrecognized: 1 }, warn);
    logDroppedAnthropicBetas({ droppedNames: [], droppedUnrecognized: 0 }, warn);
    expect(lines).toEqual(["[anthropic] anthropic-beta-dropped=alpha-fixture-2099-01-01,zeta-fixture-2099-01-02 (+2 unnamed)"]);
  });
});
