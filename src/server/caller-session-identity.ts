/** Promote third-party conversation markers after ingress authentication and origin checks. */
import { contextPrincipalIdOf, type DataPlaneAdmission } from "./auth-cors";

const SESSION_HEADERS = ["session_id", "session-id", "thread-id"] as const;
const SAFE_CALLER_SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export function safeCallerSessionId(raw: string | null): string | undefined {
  const value = raw?.trim();
  return value && SAFE_CALLER_SESSION_ID.test(value) ? value : undefined;
}

export function callerSessionId(headers: Headers): string | undefined {
  if (SESSION_HEADERS.some(name => headers.has(name))) return undefined;
  return safeCallerSessionId(headers.get("x-session-id"));
}

/** Authenticated callers share continuity only within their trusted credential principal. */
export function principalScopedSessionId(conversation: string, admission: DataPlaneAdmission): string | undefined {
  if (admission.kind === "loopback") return conversation;
  const principal = contextPrincipalIdOf(admission);
  if (!principal) return undefined;
  return new Bun.CryptoHasher("sha256")
    .update(JSON.stringify(["opencodex-caller-session-v1", principal, conversation])).digest("hex");
}

export function withCallerSessionIdentity(req: Request, admission: DataPlaneAdmission): Request {
  const conversation = callerSessionId(req.headers);
  if (!conversation) return req;
  const sessionId = principalScopedSessionId(conversation, admission);
  if (!sessionId) return req;
  const headers = new Headers(req.headers);
  headers.set("session_id", sessionId);
  // Preserve the unread body stream and propagate the original request's abort signal.
  return new Request(req, { headers });
}
