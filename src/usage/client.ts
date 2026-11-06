/** A bounded, observational client label. Header values themselves are never returned. */
export const USAGE_CLIENTS = [
  "codex_cli", "codex_desktop", "codex_ide", "claude_code", "claude_desktop",
  "grok", "opencode", "aside", "other", "unknown",
] as const;

export type UsageClient = (typeof USAGE_CLIENTS)[number];

const KNOWN_CLIENTS: ReadonlySet<string> = new Set(USAGE_CLIENTS);
const MAX_HEADER_LENGTH = 1024;

/** Preserve absence on legacy rows; a present invalid value is explicitly unknown. */
export function normalizeRecordedClient(value: unknown): UsageClient | undefined {
  if (value === undefined) return undefined;
  return typeof value === "string" && KNOWN_CLIENTS.has(value) ? value as UsageClient : "unknown";
}

/**
 * Classify only signatures established by existing client fixtures or upstream sources.
 * These headers can be supplied by callers and must never authorize an action.
 */
export function classifyUsageClient(headers: Headers): UsageClient {
  const originator = headers.get("originator") ?? "";
  const userAgent = headers.get("user-agent") ?? "";
  if (originator.length > MAX_HEADER_LENGTH || userAgent.length > MAX_HEADER_LENGTH) return "unknown";

  let originClient: UsageClient | undefined;
  if (originator === "codex_cli_rs" || originator === "codex-tui") originClient = "codex_cli";
  else if (originator === "Codex Desktop" || originator === "codex_desktop") originClient = "codex_desktop";
  else if (originator === "codex_vscode") originClient = "codex_ide";
  else if (originator === "opencode") originClient = "opencode";

  const claudeEntrypoint = /^claude-cli\/[A-Za-z0-9][A-Za-z0-9._+-]* \(external, ([A-Za-z0-9._-]+)(?:, [^,()]+)*\)$/i.exec(userAgent)?.[1]?.toLowerCase();
  let agentClient: UsageClient | undefined;
  if (claudeEntrypoint === "cli" || claudeEntrypoint === "sdk-cli") agentClient = "claude_code";
  else if (claudeEntrypoint === "claude-desktop" || claudeEntrypoint === "claude-desktop-3p" || claudeEntrypoint === "local-agent") agentClient = "claude_desktop";
  else if (/^claude-code\/[A-Za-z0-9][A-Za-z0-9._+-]*(?:\s|$)/i.test(userAgent)) agentClient = "claude_code";
  else if (/^opencode\/[A-Za-z0-9][A-Za-z0-9._+-]*(?:\s|$)/i.test(userAgent)) agentClient = "opencode";
  else if (/^codex_cli_rs\/[A-Za-z0-9][A-Za-z0-9._+-]*(?:\s|$)/i.test(userAgent)) agentClient = "codex_cli";
  if (originClient && agentClient && originClient !== agentClient
    && !(originClient.startsWith("codex_") && agentClient.startsWith("codex_"))) return "unknown";
  return originClient ?? agentClient ?? "unknown";
}
