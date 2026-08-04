import type { Virtualizer } from "@tanstack/react-virtual";
import { useI18n } from "../i18n/shared";
import type { DebugLogEntry, LogStream } from "./debug-shared";
import { formatLogTime } from "./debug-shared";

export function DebugLogViewer({
  debug,
  stream,
  streamEnabled,
  entries,
  scrollContainerRef,
  lineVirtualizer,
}: {
  debug: boolean;
  stream: LogStream;
  streamEnabled: boolean;
  entries: DebugLogEntry[];
  scrollContainerRef: React.RefObject<HTMLDivElement | null>;
  lineVirtualizer: Virtualizer<HTMLDivElement, Element>;
}) {
  const { t } = useI18n();

  if (!debug) return null;

  if (!streamEnabled) {
    return (
      <div className="empty">
        <div className="font-semibold" style={{ marginBottom: 6 }}>{t("debug.emptyTitle")}</div>
        <div className="muted text-control" style={{ maxWidth: 560, marginInline: "auto" }}>{t("debug.empty")}</div>
      </div>
    );
  }

  if (entries.length === 0) {
    return (
      <div className="empty">
        <div className="font-semibold" style={{ marginBottom: 6 }}>{t("debug.noLinesTitle")}</div>
        <div className="muted text-control" style={{ maxWidth: 560, marginInline: "auto" }}>{t(`debug.noLines.${stream}`)}</div>
      </div>
    );
  }

  return (
    <div
      ref={scrollContainerRef}
      className="log-detail-json"
      style={{ maxHeight: "calc(100vh - 280px)", overflow: "auto" }}
    >
      <div
        style={{
          position: "relative",
          height: lineVirtualizer.getTotalSize(),
          width: "100%",
        }}
      >
        {lineVirtualizer.getVirtualItems().map(virtualRow => (
          <div
            key={virtualRow.key}
            ref={lineVirtualizer.measureElement}
            data-index={virtualRow.index}
            style={{
              position: "absolute",
              top: 0,
              left: 0,
              width: "100%",
              transform: `translateY(${virtualRow.start}px)`,
            }}
          >
            {`${formatLogTime(entries[virtualRow.index]!.at)}${entries[virtualRow.index]!.line}`}
          </div>
        ))}
      </div>
    </div>
  );
}
