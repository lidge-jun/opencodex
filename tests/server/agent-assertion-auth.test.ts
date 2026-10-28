import { describe, expect, test } from "bun:test";
import { buildResponsesTransport, FORWARD_HEADERS } from "../../src/adapters/openai-responses/transport";
import {
  headersForCodexAuthContext,
  materializeCodexUpstreamAuth,
  materializeCodexUpstreamAuthAsync,
  type CodexAuthContext,
} from "../../src/codex/auth-context";
import { providerForwardClientHeadersConfigError } from "../../src/lib/provider-client-headers";
import { AGENT_ASSERTION_HEADER, AgentAssertionUnsupportedError } from "../../src/lib/authorization-scheme";
import {
  hasForwardableCodexBearer,
  resolveApiAuth,
  resolveContextPrincipal,
  resolveResponsesApiAuth,
  validateForwardAdmissionCredential,
} from "../../src/server/auth-cors";
import { selectForwardHeaders } from "../../src/server/ws-bridge";
import type { OcxConfig, OcxProviderConfig } from "../../src/types";
import { fakeChatGptJwt } from "../helpers/fake-chatgpt-jwt";

/**
 * Codex 0.164 runtime agent instances (openai/codex#55402, #55636) authenticate in two modes:
 * dual_header sends an ordinary Bearer plus x-openai-agent-assertion, and assertion_only sends
 * Authorization: AgentAssertion <jwt>. The legacy replace(/^Bearer\s+/i) read passed the second
 * one through as an opaque bearer.
 */
const ACCOUNT = "agent-assertion-account";
const ASSERTION = fakeChatGptJwt({ "https://api.openai.com/auth": { chatgpt_account_id: ACCOUNT } });
const ADMISSION_KEY = "ocx_data_agent_assertion_fixture";
const remote = {
  hostname: "0.0.0.0",
  providers: {},
  apiKeys: [{ id: "agent-key", name: "agent", key: ADMISSION_KEY, createdAt: "2026-10-21T00:00:00.000Z" }],
} as unknown as OcxConfig;
const canonical: OcxProviderConfig = {
  adapter: "openai-responses", baseUrl: "https://chatgpt.com/backend-api/codex", authMode: "forward",
} as OcxProviderConfig;

function assertionOnly(extra: Record<string, string> = {}): Headers {
  return new Headers({ authorization: `AgentAssertion ${ASSERTION}`, "chatgpt-account-id": ACCOUNT, ...extra });
}

function dualHeader(bearer = "caller-direct-token"): Headers {
  return new Headers({
    authorization: `Bearer ${bearer}`, "chatgpt-account-id": ACCOUNT, [AGENT_ASSERTION_HEADER]: ASSERTION,
  });
}

describe("assertion_only admission", () => {
  test("an AgentAssertion is never admitted, even when its bytes equal a configured proxy key", () => {
    for (const value of [`AgentAssertion ${ASSERTION}`, `AgentAssertion ${ADMISSION_KEY}`]) {
      const req = new Request("http://proxy.test/v1/responses", { headers: { authorization: value } });
      expect(resolveApiAuth(req, remote)).toBeNull();
      expect(resolveResponsesApiAuth(req, remote)).toBeNull();
      expect(resolveContextPrincipal(req, remote, { kind: "loopback", source: "loopback" })).toBeUndefined();
    }
  });

  test("an AgentAssertion is not a forwardable caller Codex bearer", () => {
    // The legacy read saw "AgentAssertion <jwt>" plus an account header as a caller credential.
    expect(hasForwardableCodexBearer(assertionOnly(), remote)).toBe(false);
    expect(hasForwardableCodexBearer(dualHeader(), remote)).toBe(true);
    expect(() => validateForwardAdmissionCredential(assertionOnly(), remote)).not.toThrow();
    expect(() => validateForwardAdmissionCredential(new Headers({ authorization: `Bearer ${ADMISSION_KEY}` }), remote))
      .toThrow();
  });
});

describe("assertion_only credential materialization", () => {
  const pool = { kind: "pool", accountId: "pool-account", accessToken: "pool-token", chatgptAccountId: "pool-uuid" } as unknown as CodexAuthContext;
  const main = { kind: "main", accountId: null } as CodexAuthContext;

  test("pool, stored-main and Direct materialization refuse instead of substituting a Bearer", async () => {
    expect(() => materializeCodexUpstreamAuth(assertionOnly(), pool)).toThrow(AgentAssertionUnsupportedError);
    expect(() => materializeCodexUpstreamAuth(assertionOnly(), main)).toThrow(AgentAssertionUnsupportedError);
    expect(() => materializeCodexUpstreamAuth(assertionOnly(), main, { substituteMainCredential: true }))
      .toThrow(AgentAssertionUnsupportedError);
    await expect(materializeCodexUpstreamAuthAsync(assertionOnly(), main, { substituteMainCredential: true }))
      .rejects.toBeInstanceOf(AgentAssertionUnsupportedError);
  });
});

describe("dual_header assertion forwarding", () => {
  test("first-party Direct passthrough forwards the caller's Bearer and the assertion", () => {
    const { headers } = buildResponsesTransport(canonical, { headers: dualHeader() });
    expect(headers.authorization).toBe("Bearer caller-direct-token");
    expect(headers[AGENT_ASSERTION_HEADER]).toBe(ASSERTION);
  });

  test("a pooled account override strips the assertion", () => {
    const pooled = { ...canonical, _codexAccountOverride: { accessToken: "pool-token", chatgptAccountId: "pool-uuid" } };
    const { headers } = buildResponsesTransport(pooled, { headers: dualHeader() });
    expect(headers.authorization).toBe("Bearer pool-token");
    expect(headers[AGENT_ASSERTION_HEADER]).toBeUndefined();
  });

  test("routed transports never forward the assertion, even when configured to", () => {
    const routed: OcxProviderConfig[] = [
      { adapter: "openai-responses", baseUrl: "https://gateway.example.test/v1", authMode: "forward" } as OcxProviderConfig,
      { adapter: "openai-responses", baseUrl: "https://gateway.example.test/v1", authMode: "key", apiKey: "sk-routed" } as OcxProviderConfig,
      { ...canonical, baseUrl: "https://gateway.example.test/v1", forwardClientHeaders: [AGENT_ASSERTION_HEADER] } as OcxProviderConfig,
    ];
    for (const provider of routed) {
      const { headers } = buildResponsesTransport(provider, { headers: dualHeader() });
      expect(Object.keys(headers).map(name => name.toLowerCase())).not.toContain(AGENT_ASSERTION_HEADER);
    }
    expect(providerForwardClientHeadersConfigError([AGENT_ASSERTION_HEADER])).toContain("credential");
  });

  test("Codex materialization and sidecar allowlists drop the assertion", () => {
    expect(FORWARD_HEADERS).not.toContain(AGENT_ASSERTION_HEADER);
    const main = { kind: "main", accountId: null } as CodexAuthContext;
    expect(materializeCodexUpstreamAuth(dualHeader(), main).has(AGENT_ASSERTION_HEADER)).toBe(false);
    // openai-sidecar.ts selects sidecar credentials through this wrapper.
    expect(headersForCodexAuthContext(dualHeader(), main).has(AGENT_ASSERTION_HEADER)).toBe(false);
  });

  test("the WebSocket handshake keeps the assertion for Direct and drops it for a pool override", () => {
    expect(selectForwardHeaders(dualHeader()).get(AGENT_ASSERTION_HEADER)).toBe(ASSERTION);
    const pooled = selectForwardHeaders(dualHeader(), { accessToken: "pool-token", chatgptAccountId: "pool-uuid" });
    expect(pooled.get("authorization")).toBe("Bearer pool-token");
    expect(pooled.has(AGENT_ASSERTION_HEADER)).toBe(false);
  });
});
