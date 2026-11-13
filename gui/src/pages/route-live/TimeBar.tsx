/**
 * "Where the time went": one stacked bar plus a legend, from measured stages only.
 * The idea follows Magpie's time bar (MIT, Copyright (c) 2026 yetone); the markup is this page's own.
 */
import { useI18n, LOCALES } from "../../i18n/shared";
import type { RouteLiveCopyKey } from "../../i18n/route-live-copy";
import { formatDuration, formatPartDuration } from "./route-format";
import { timeParts, type TimePart, type TimePartKind, type TimeRow } from "./time-parts";

type Side = "ocx" | "earlier" | "upstream";

const PART_SIDE: Record<TimePartKind, Side> = {
  privacy: "ocx", internal: "ocx", earlier: "earlier", upstreamWait: "upstream", streaming: "upstream", reading: "upstream",
};

const PART_LABEL = {
  privacy: "routeLive.timePrivacy",
  internal: "routeLive.timeInternal",
  earlier: "routeLive.timeEarlier",
  upstreamWait: "routeLive.timeUpstreamWait",
  streaming: "routeLive.timeStreaming",
  reading: "routeLive.timeReading",
} as const satisfies Record<TimePartKind, RouteLiveCopyKey>;

function TimeBar({ parts }: { parts: TimePart[] }) {
  const { t, locale } = useI18n();
  const localeTag = LOCALES.find(l => l.code === locale)?.htmlLang;
  const total = parts.reduce((sum, part) => sum + part.ms, 0);
  return (
    <>
      <div className="rl-time-head">
        <h4 className="rl-h">{t("routeLive.timeHead")}</h4>
        <span className="rl-muted">{formatDuration(total, localeTag)}</span>
      </div>
      <div className="rl-time-bar" aria-hidden="true">
        {parts.map(part => (
          <span
            key={part.kind}
            className={`rl-time-seg rl-time-seg--${part.kind} rl-time-side--${PART_SIDE[part.kind]}`}
            style={{ flexGrow: part.ms / total }}
            title={`${t(PART_LABEL[part.kind])} ${formatPartDuration(part.ms, localeTag)}`}
          />
        ))}
      </div>
      <ul className="rl-time-legend">
        {parts.map(part => (
          <li key={part.kind}>
            <span className={`rl-time-dot rl-time-seg--${part.kind} rl-time-side--${PART_SIDE[part.kind]}`} aria-hidden="true" />
            <span>{t(PART_LABEL[part.kind])}</span>
            <span className="rl-num">{formatPartDuration(part.ms, localeTag)}</span>
          </li>
        ))}
      </ul>
    </>
  );
}

/** The bar for a request that reached a provider; a one-line note when its timing was not recorded. */
export function TimeSection({ row }: { row: TimeRow }) {
  const { t } = useI18n();
  const parts = timeParts(row);
  return (
    <section className="rl-time">
      {parts ? <TimeBar parts={parts} /> : <p className="rl-muted rl-hint">{t("routeLive.timeNone")}</p>}
    </section>
  );
}
