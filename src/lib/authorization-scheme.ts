/**
 * One parser for the inbound `Authorization` scheme.
 *
 * Bearer reads in the proxy used `replace(/^Bearer\s+/i, "")`, which returns any other value
 * unchanged. Codex 0.164 runtime agent instances (`features.runtime_agent_instances`) can send
 * `Authorization: AgentAssertion <jwt>`, and that replace handed the whole value on as an opaque
 * bearer. An agent assertion is never a bearer: it is not an opencodex admission secret, it is not
 * a ChatGPT credential, and it must never be forwarded as `Bearer`.
 *
 * The legacy read is preserved for every other value, including a scheme-less token, so this file
 * changes nothing except the AgentAssertion case.
 */

/** The companion header Codex sends in `dual_header` mode next to an ordinary Bearer. */
export const AGENT_ASSERTION_HEADER = "x-openai-agent-assertion";

/** Stable error code for `Authorization: AgentAssertion`, which opencodex does not route. */
export const AGENT_ASSERTION_UNSUPPORTED_CODE = "agent_assertion_unsupported";

export const AGENT_ASSERTION_UNSUPPORTED_MESSAGE = "Codex runtime agent assertion_only authentication "
  + "(Authorization: AgentAssertion) is not supported through opencodex pooling or routing. "
  + "Use dual_header mode, or turn off features.runtime_agent_instances.";

export type AuthorizationScheme =
  | { kind: "none" }
  | { kind: "bearer"; token: string }
  | { kind: "agent-assertion" }
  | { kind: "other"; credential: string };

const BEARER_PREFIX = /^Bearer\s+/i;
// RFC 9110 auth schemes are case-insensitive; the scheme ends at whitespace or end of value.
const AGENT_ASSERTION_SCHEME = /^\s*AgentAssertion(?:\s|$)/i;

/** Classify an Authorization value. The assertion's own bytes are deliberately not returned. */
export function parseAuthorizationScheme(value: string | null | undefined): AuthorizationScheme {
  if (value == null) return { kind: "none" };
  if (AGENT_ASSERTION_SCHEME.test(value)) return { kind: "agent-assertion" };
  if (BEARER_PREFIX.test(value)) {
    const token = value.replace(BEARER_PREFIX, "").trim();
    return token ? { kind: "bearer", token } : { kind: "none" };
  }
  const credential = value.trim();
  return credential ? { kind: "other", credential } : { kind: "none" };
}

/**
 * The credential the legacy `replace(/^Bearer\s+/i, "").trim()` read produced, except that an
 * AgentAssertion value yields nothing. Use this wherever that replace used to be.
 */
export function authorizationCredential(headers: Pick<Headers, "get">): string | undefined {
  const parsed = parseAuthorizationScheme(headers.get("authorization"));
  if (parsed.kind === "bearer") return parsed.token;
  if (parsed.kind === "other") return parsed.credential;
  return undefined;
}

/** Whether the request authenticates with `Authorization: AgentAssertion` (assertion_only). */
export function hasAgentAssertionAuthorization(headers: Pick<Headers, "get">): boolean {
  return parseAuthorizationScheme(headers.get("authorization")).kind === "agent-assertion";
}

export class AgentAssertionUnsupportedError extends Error {
  readonly code = AGENT_ASSERTION_UNSUPPORTED_CODE;
  constructor() {
    super(AGENT_ASSERTION_UNSUPPORTED_MESSAGE);
    this.name = "AgentAssertionUnsupportedError";
  }
}

/** The typed refusal. It never echoes the request's Authorization or assertion header. */
export function agentAssertionUnsupportedResponse(): Response {
  return Response.json({
    error: {
      message: AGENT_ASSERTION_UNSUPPORTED_MESSAGE,
      type: "invalid_request_error",
      code: AGENT_ASSERTION_UNSUPPORTED_CODE,
    },
  }, { status: 400, headers: { "cache-control": "no-store" } });
}

/**
 * Carry the dual_header assertion onto first-party Direct headers, and only when the outbound
 * Authorization is the caller's own Bearer, byte for byte. A pool account, a substituted main
 * credential, or a stripped Authorization means the assertion would accompany a credential it was
 * not sent with, so it is dropped instead.
 */
export function carryAgentAssertionForCallerBearer(target: Headers, caller: Pick<Headers, "get">): void {
  target.delete(AGENT_ASSERTION_HEADER);
  const assertion = caller.get(AGENT_ASSERTION_HEADER);
  if (!assertion) return;
  const callerAuth = parseAuthorizationScheme(caller.get("authorization"));
  const outboundAuth = parseAuthorizationScheme(target.get("authorization"));
  if (callerAuth.kind !== "bearer" || outboundAuth.kind !== "bearer" || callerAuth.token !== outboundAuth.token) return;
  target.set(AGENT_ASSERTION_HEADER, assertion);
}
