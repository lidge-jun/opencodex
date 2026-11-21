import { normalizeRecordedClient, type UsageClient } from "../../../src/usage/client";
import type { TFn } from "../i18n/shared";

export const CLIENT_LABELS = {
  codex_cli: "Codex",
  codex_desktop: "Codex",
  codex_ide: "Codex",
  claude_code: "Claude Code",
  claude_desktop: "Claude Desktop",
  grok: "Grok",
  opencode: "OpenCode",
  aside: "Aside",
  other: "logsV2.clientOther",
  unknown: "logsV2.clientUnknown",
} as const satisfies Record<UsageClient, string>;

/** The plain client name (Codex, Claude Code, ...), for sentences that name the client. */
export function clientLabel(client: unknown, t: TFn): string {
  const classified = normalizeRecordedClient(client) ?? "unknown";
  return classified === "other" || classified === "unknown" ? t(CLIENT_LABELS[classified]) : CLIENT_LABELS[classified];
}
