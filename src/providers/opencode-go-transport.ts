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

/** Add per-conversation Go affinity only to the canonical fixed-key destination. */
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
