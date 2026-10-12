import { parseProtocolTraceV1 } from "../../../../src/protocols/dto";
import type { TFn } from "../../i18n/shared";
import { PROTOCOL_MODE_KEYS, protocolCompactLabel } from "./protocol-labels";

/**
 * Compact protocol path for a Logs row, e.g. "Chat → Chat · Native". The mode is written out,
 * never conveyed by colour alone. A row without a valid trace renders nothing: an old row is
 * not guessed at.
 */
export function ProtocolBadge({ trace, t }: { trace: unknown; t: TFn }) {
  const parsed = parseProtocolTraceV1(trace);
  if (!parsed) return null;
  const path = protocolCompactLabel(parsed, t);
  const mode = t(PROTOCOL_MODE_KEYS[parsed.mode]);
  return (
    <span
      className="badge badge-muted protocol-path-badge"
      title={t("logs.protocol.badgeTitle", { path, mode })}
      data-protocol-mode={parsed.mode}
    >
      {path} · {mode}
    </span>
  );
}
