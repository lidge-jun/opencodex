import type { Virtualizer } from "@tanstack/react-virtual";
import { useI18n } from "../i18n/shared";
import { IconRefresh } from "../icons";
import { SegmentedControl } from "@/components/ui-v2/segmented-control";
import { cn } from "@/lib/utils";
import { panel, panelBody, quietIconButton } from "../components/v2-logs/classes";
import { LiveToggle } from "../components/v2-logs/live-toggle";
import type { DebugLogEntry, DebugSettings, LogStream } from "./debug-shared";
import { formatLogTime } from "./debug-shared";

const STREAM_LABEL = {
  provider: "debug.streamProvider",
  usage: "debug.streamUsage",
  injection: "debug.streamInjection",
} as const satisfies Record<LogStream, string>;

/*
 * The debug stream as a live tail (React Bits monitoring-5): a header with the stream switch,
 * a manual refresh and the follow toggle, an inset body of monospace lines, and a footer count.
 */
export function DebugLogViewer({
  debug,
  stream,
  streamEnabled,
  entries,
  refreshing,
  follow,
  scrollContainerRef,
  lineVirtualizer,
  onStreamChange,
  onRefresh,
  onFollowChange,
}: {
  debug: DebugSettings | null;
  stream: LogStream;
  streamEnabled: boolean;
  entries: DebugLogEntry[];
  refreshing: boolean;
  follow: boolean;
  scrollContainerRef: React.RefObject<HTMLDivElement | null>;
  lineVirtualizer: Virtualizer<HTMLDivElement, Element>;
  onStreamChange: (stream: LogStream) => void;
  onRefresh: () => void;
  onFollowChange: (follow: boolean) => void;
}) {
  const { t } = useI18n();

  if (!debug) return null;

  const streams = ([
    debug.enabled ? "provider" : null,
    debug.usage ? "usage" : null,
    debug.injection ? "injection" : null,
  ] as const).filter((value): value is LogStream => value !== null);

  return (
    <section className={panel} aria-labelledby="debug-tail-title">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 px-4 pt-3.5 pb-3">
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2">
          <h3 id="debug-tail-title" className="m-0 text-[15px] leading-5 font-semibold tracking-[-0.01em] text-fg">{t("logsV2.debugTail")}</h3>
          {streams.length > 1 && (
            <SegmentedControl
              size="sm"
              aria-label={t("logsV2.debugStream")}
              value={stream}
              onChange={onStreamChange}
              items={streams.map(value => ({ value, label: t(STREAM_LABEL[value]) }))}
            />
          )}
          {streams.length === 1 && (
            <span className="text-[13px] text-fg-muted">{t(STREAM_LABEL[streams[0]!])}</span>
          )}
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            className={quietIconButton}
            disabled={refreshing || !streamEnabled}
            onClick={onRefresh}
            aria-label={t("debug.refresh")}
            title={t("debug.refresh")}
          >
            <span className={cn("inline-flex", refreshing && "animate-spin")}><IconRefresh aria-hidden /></span>
          </button>
          <LiveToggle checked={follow} onChange={onFollowChange} label={t("debug.follow")} />
        </div>
      </div>

      <div className={panelBody}>
        {!streamEnabled ? (
          <div className="empty">
            <div className="title">{t("debug.emptyTitle")}</div>
            <div className="mx-auto mt-1.5 max-w-[560px] text-[13px] text-fg-muted">{t("debug.empty")}</div>
          </div>
        ) : entries.length === 0 ? (
          <div className="empty">
            <div className="title">{t("debug.noLinesTitle")}</div>
            <div className="mx-auto mt-1.5 max-w-[560px] text-[13px] text-fg-muted">{t(`debug.noLines.${stream}`)}</div>
          </div>
        ) : (
          <div
            ref={scrollContainerRef}
            className="debug-tail-lines max-h-[calc(100dvh-320px)] min-h-48 overflow-auto px-4 py-2"
          >
            <div className="relative w-full" style={{ height: lineVirtualizer.getTotalSize() }}>
              {lineVirtualizer.getVirtualItems().map(virtualRow => {
                const entry = entries[virtualRow.index]!;
                return (
                  <div
                    key={virtualRow.key}
                    ref={lineVirtualizer.measureElement}
                    data-index={virtualRow.index}
                    className="absolute top-0 left-0 w-full"
                    style={{ transform: `translateY(${virtualRow.start}px)` }}
                  >
                    <span className="text-fg-subtle">{formatLogTime(entry.at)}</span>
                    <span className="text-fg">{entry.line}</span>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>

      {streamEnabled && entries.length > 0 && (
        <p className="m-0 flex min-h-10 items-center px-4 text-[12.5px] text-fg-subtle tabular-nums">
          {t("logsV2.debugLines", { count: entries.length })}
        </p>
      )}
    </section>
  );
}
