import { createHash } from "node:crypto";
import type { OcxProviderConfig } from "../types";
import { registryEntryForProviderDestination } from "./registry";

export const OPENCODE_GO_SESSION_HEADER = "x-opencode-session";

function hasHeaderCaseInsensitive(
  headers: Record<string, string> | undefined,
  name: string,
): boolean {
  const target = name.toLowerCase();
  return Object.keys(headers ?? {}).some(key => key.toLowerCase() === target);
}

/** Derive a provider-scoped opaque value without exposing Codex task or subagent ids. */
export function deriveOpenCodeGoSessionId(sessionLane: string): string {
  const digest = createHash("sha256")
    .update("opencodex/opencode-go/session/v1\0")
    .update(sessionLane)
    .digest("hex")
    .slice(0, 32);
  return `ocx_${digest}`;
}

/**
 * Add Go affinity only to the canonical fixed-key destination.
 *
 * Callers on the request path resolve the lane with `getOrAllocateRequestSessionLane`, which returns
 * real conversation identity when the client supplied it and a per-request value otherwise, so a
 * request reaching this helper from the proxy always carries a lane. The `!sessionLane` guard stays
 * for direct callers that have no request context; it is not a per-request identity of its own, and
 * minting one here would hand each retry a different value.
 */
export function resolveOpenCodeGoTransport<T extends OcxProviderConfig>(
  provider: T,
  sessionLane: string | undefined,
): T {
  if (registryEntryForProviderDestination(provider)?.id !== "opencode-go") return provider;
  if (!sessionLane) return provider;
  if (hasHeaderCaseInsensitive(provider.headers, OPENCODE_GO_SESSION_HEADER)) return provider;

  return {
    ...provider,
    headers: {
      ...(provider.headers ?? {}),
      [OPENCODE_GO_SESSION_HEADER]: deriveOpenCodeGoSessionId(sessionLane),
    },
  };
}
