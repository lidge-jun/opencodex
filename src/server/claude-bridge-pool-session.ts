/** Private pool identity for translated Claude turns; replay headers remain unchanged. */
import { codexPoolAffinityKey } from "../codex/auth-context";
import { contextPrincipalIdOf, type DataPlaneAdmission } from "./auth-cors";
import { safeCallerSessionId } from "./caller-session-identity";
import { isThreadSpawnRequest } from "./effort-policy";
import type { RouteResult } from "../router";
import type { HandleResponsesOptions } from "./responses/core-options";

export function resolveClaudeBridgePoolSession(args: {
  ingress: Headers; replay: Headers; metadataSessionId?: string; admission?: DataPlaneAdmission;
}): string | undefined {
  const { ingress, replay, metadataSessionId, admission } = args;
  if (!admission || isThreadSpawnRequest(ingress) || isThreadSpawnRequest(replay)) return undefined;
  if (ingress.has("x-codex-parent-thread-id") || ingress.has("thread-id")) return undefined;
  if (codexPoolAffinityKey(replay) !== undefined) return undefined;
  let value: string | undefined;
  if (ingress.has("session_id") || ingress.has("session-id")) {
    const first = ingress.get("session_id");
    const second = ingress.get("session-id");
    if (first && second && first !== second) return undefined;
    value = safeCallerSessionId(first || second);
  } else {
    value = safeCallerSessionId(metadataSessionId ?? ingress.get("x-claude-code-session-id"));
  }
  if (!value) return undefined;
  // Every remote identity this bridge names, caller aliases included, is bound to the admitted
  // principal: a shared or guessed value must never select another principal's conversation key.
  if (admission.kind === "loopback") return value;
  const principal = contextPrincipalIdOf(admission);
  if (!principal) return undefined;
  return new Bun.CryptoHasher("sha256")
    .update(JSON.stringify(["opencodex-caller-session-v1", principal, value])).digest("hex");
}

export function completeClaudeBridgePoolIdentity(headers: Headers, options: Pick<HandleResponsesOptions, "claudeBridgePoolSession">): Headers {
  const session = options.claudeBridgePoolSession;
  if (!session || headers.get("x-codex-parent-thread-id") || headers.get("thread-id")
    || codexPoolAffinityKey(headers) !== undefined) return headers;
  const completed = new Headers(headers);
  completed.set("session-id", session);
  completed.set("thread-id", session);
  return completed;
}

export function applyClaudeBridgePoolSession(headers: Headers, route: Pick<RouteResult, "codexAccountMode">,
  options: Pick<HandleResponsesOptions, "claudeBridgePoolSession">): Headers {
  return route.codexAccountMode !== undefined ? completeClaudeBridgePoolIdentity(headers, options) : headers;
}
