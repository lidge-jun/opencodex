import type { ClaudeFirstPartyDesired } from "../first-party-settings";

export type InterceptClient = "desktop" | "cli" | "unknown";
export const DESKTOP_ENTRYPOINTS = ["claude-desktop", "claude-desktop-3p", "local-agent"] as const;

export function interceptEntrypoint(userAgent: string | null): string | null {
  return userAgent?.match(/^claude-cli\/[^\s()]+ \(external, ([A-Za-z0-9._-]+)(?:, [^,()]+)*\)$/)?.[1] ?? null;
}

export function classifyInterceptClient(userAgent: string | null): InterceptClient {
  const entrypoint = interceptEntrypoint(userAgent);
  if (entrypoint === null) return "unknown";
  return (DESKTOP_ENTRYPOINTS as readonly string[]).includes(entrypoint) ? "desktop" : "cli";
}

export function interceptRouteFor(client: InterceptClient, desired: ClaudeFirstPartyDesired): "router" | "relay-native" {
  return client !== "unknown" && desired[client] ? "router" : "relay-native";
}
