import { normalizeRecordedClient, type UsageClient } from "../../../src/usage/client";
import type { TFn } from "../i18n/shared";

const CLIENT_LABELS = {
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

/** Render only classified enum values, including when reading older or malformed cached rows. */
export function LogsClientChip({ client, t }: { client: unknown; t: TFn }) {
  const classified = normalizeRecordedClient(client) ?? "unknown";
  const label = classified === "other" || classified === "unknown"
    ? t(CLIENT_LABELS[classified]) : CLIENT_LABELS[classified];
  return <span className="inline-flex h-[22px] shrink-0 items-center gap-1.5 rounded-full bg-surface-2 px-2 text-[12px] font-medium text-fg-muted whitespace-nowrap" data-log-client={classified}>
    <span aria-hidden="true" className="size-1.5 rounded-full bg-current" />{label}
  </span>;
}
