import { normalizeRecordedClient, type UsageClient } from "../../../src/usage/client";
import type { TFn } from "../i18n/shared";
import { clientIconClass } from "../client-icon";

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

const CLIENT_ICONS: Record<UsageClient, string | null> = {
  codex_cli: "openai.svg", codex_desktop: "openai.svg", codex_ide: "openai.svg",
  claude_code: "claude-color.svg", claude_desktop: "claude-color.svg",
  grok: "grok.svg", opencode: "opencode.svg", aside: "aside.svg", other: null, unknown: null,
};

/** Render only classified enum values, including when reading older or malformed cached rows. */
export function LogsClientChip({ client, t }: { client: unknown; t: TFn }) {
  const classified = normalizeRecordedClient(client) ?? "unknown";
  const label = classified === "other" || classified === "unknown"
    ? t(CLIENT_LABELS[classified]) : CLIENT_LABELS[classified];
  const icon = CLIENT_ICONS[classified];
  return <span className="inline-flex h-6 w-8 shrink-0 items-center justify-center rounded-full bg-surface-2 text-fg-muted" data-log-client={classified} role="img" aria-label={label}>
    {icon ? <img src={`/provider-icons/${icon}`} alt="" aria-hidden="true" className={clientIconClass(icon)} />
      : <svg aria-hidden="true" focusable="false" viewBox="0 0 16 16" className="size-4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M5.5 5.5a2.5 2.5 0 1 1 4.15 1.88C8.65 8.2 8 8.65 8 10" /><path d="M8 12.5h.01" />
      </svg>}
  </span>;
}
