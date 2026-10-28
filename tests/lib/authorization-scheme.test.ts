import { describe, expect, test } from "bun:test";
import {
  AGENT_ASSERTION_HEADER,
  AGENT_ASSERTION_UNSUPPORTED_CODE,
  agentAssertionUnsupportedResponse,
  authorizationCredential,
  carryAgentAssertionForCallerBearer,
  hasAgentAssertionAuthorization,
  parseAuthorizationScheme,
} from "../../src/lib/authorization-scheme";
import { redactHeaders, redactSecretString, REDACTED_SECRET } from "../../src/lib/redact";
import { fakeChatGptJwt } from "../helpers/fake-chatgpt-jwt";

// Codex 0.164 runtime agent assertions are JWT-shaped; the bytes only have to be recognisable.
const ASSERTION = fakeChatGptJwt({ agent: "runtime-agent-assertion-fixture" });

describe("Authorization scheme parsing", () => {
  test("AgentAssertion is its own scheme in any case and never yields a credential", () => {
    for (const value of [`AgentAssertion ${ASSERTION}`, `agentassertion ${ASSERTION}`, `AGENTASSERTION\t${ASSERTION}`, "AgentAssertion"]) {
      expect(parseAuthorizationScheme(value)).toEqual({ kind: "agent-assertion" });
      const headers = new Headers({ authorization: value });
      expect(authorizationCredential(headers)).toBeUndefined();
      expect(hasAgentAssertionAuthorization(headers)).toBe(true);
    }
  });

  test("Bearer and scheme-less values keep the legacy read", () => {
    expect(authorizationCredential(new Headers({ authorization: "Bearer abc.def" }))).toBe("abc.def");
    expect(authorizationCredential(new Headers({ authorization: "bearer   spaced " }))).toBe("spaced");
    expect(authorizationCredential(new Headers({ authorization: "ocx_data_bare" }))).toBe("ocx_data_bare");
    expect(authorizationCredential(new Headers())).toBeUndefined();
    // A longer scheme that merely starts with the name is not an agent assertion.
    expect(parseAuthorizationScheme("AgentAssertionX token")).toEqual({ kind: "other", credential: "AgentAssertionX token" });
    expect(hasAgentAssertionAuthorization(new Headers({ authorization: `Bearer ${ASSERTION}` }))).toBe(false);
  });

  test("the dual_header assertion is carried only beside the caller's own unchanged Bearer", () => {
    const caller = new Headers({ authorization: "Bearer caller-token", [AGENT_ASSERTION_HEADER]: ASSERTION });
    const same = new Headers({ authorization: "Bearer caller-token" });
    carryAgentAssertionForCallerBearer(same, caller);
    expect(same.get(AGENT_ASSERTION_HEADER)).toBe(ASSERTION);

    const pooled = new Headers({ authorization: "Bearer pool-token", [AGENT_ASSERTION_HEADER]: ASSERTION });
    carryAgentAssertionForCallerBearer(pooled, caller);
    expect(pooled.has(AGENT_ASSERTION_HEADER)).toBe(false);

    const stripped = new Headers();
    carryAgentAssertionForCallerBearer(stripped, caller);
    expect(stripped.has(AGENT_ASSERTION_HEADER)).toBe(false);

    const assertionOnly = new Headers({ authorization: `AgentAssertion ${ASSERTION}`, [AGENT_ASSERTION_HEADER]: ASSERTION });
    const target = new Headers({ authorization: `AgentAssertion ${ASSERTION}` });
    carryAgentAssertionForCallerBearer(target, assertionOnly);
    expect(target.has(AGENT_ASSERTION_HEADER)).toBe(false);
  });

  test("the typed refusal is stable and does not echo the assertion", async () => {
    const response = agentAssertionUnsupportedResponse();
    expect(response.status).toBe(400);
    const text = await response.text();
    expect(JSON.parse(text).error.code).toBe(AGENT_ASSERTION_UNSUPPORTED_CODE);
    expect(text).not.toContain(ASSERTION);
  });
});

describe("agent assertion redaction", () => {
  test("header records redact both the AgentAssertion Authorization and the dual_header header", () => {
    const redacted = redactHeaders(new Headers({
      authorization: `AgentAssertion ${ASSERTION}`,
      [AGENT_ASSERTION_HEADER]: ASSERTION,
    }));
    expect(redacted.authorization).toBe(REDACTED_SECRET);
    expect(redacted[AGENT_ASSERTION_HEADER]).toBe(REDACTED_SECRET);
  });

  test("diagnostic strings never keep the assertion bytes", () => {
    for (const raw of [
      `upstream echoed authorization: AgentAssertion ${ASSERTION}`,
      `upstream echoed ${AGENT_ASSERTION_HEADER}: ${ASSERTION}`,
      JSON.stringify({ [AGENT_ASSERTION_HEADER]: ASSERTION }),
    ]) {
      expect(redactSecretString(raw)).not.toContain(ASSERTION);
    }
  });
});
