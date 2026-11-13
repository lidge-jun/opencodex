/** Client -> OpenCodex -> candidates. The answered row is highlighted, failed rows say why, skipped rows are muted. */
import type { ReactNode } from "react";
import { useI18n, LOCALES, type TKey } from "../../i18n/shared";
import { LogsClientChip } from "../logs-client-chip";
import { clientLabel } from "../logs-client-label";
import { candidateWho, type FlowCandidate, type FlowStatus, type RouteFlow } from "./flow-model";
import { formatDuration } from "./route-format";
import { FailedDetail, ReasonText } from "./ReasonText";
import "./route-live.css";

const STATUS_TKEY: Record<FlowStatus, TKey> = {
  answered: "routeLive.statusAnswered",
  failed: "routeLive.statusFailed",
  skipped: "routeLive.statusSkipped",
  idle: "routeLive.statusIdle",
};
const STATUS_GLYPH: Record<FlowStatus, string> = { answered: "✓", failed: "✕", skipped: "–", idle: "·" };

function CandidateDetail({ candidate, localeTag }: { candidate: FlowCandidate; localeTag?: string }) {
  const { t } = useI18n();
  const parts: ReactNode[] = [];
  if (candidate.status === "failed") {
    parts.push(<FailedDetail key="why" status={candidate.httpStatus ?? 0} code={candidate.reasonCode} />);
  } else if (candidate.status === "skipped" && candidate.reasonCode) {
    parts.push(<ReasonText key="why" kind="skip" code={candidate.reasonCode} />);
  } else if (candidate.status === "idle") {
    parts.push(t(STATUS_TKEY.idle));
  }
  if (candidate.status !== "skipped" && candidate.status !== "idle") {
    if (candidate.ttftMs !== undefined) parts.push(`${t("routeLive.colTtft")} ${formatDuration(candidate.ttftMs, localeTag)}`);
    if (candidate.durationMs !== undefined) parts.push(`${t("routeLive.colDuration")} ${formatDuration(candidate.durationMs, localeTag)}`);
  }
  if (parts.length === 0) return null;
  return <span className="rl-cand-detail">{parts.flatMap((part, i) => (i === 0 ? [part] : [" · ", part]))}</span>;
}

export function FlowDiagram({ flow }: { flow: RouteFlow }) {
  const { t, locale } = useI18n();
  const localeTag = LOCALES.find(l => l.code === locale)?.htmlLang;
  const candidates = flow.candidates;
  return (
    <section className="rl-flow" aria-label={t("routeLive.flowLabel")}>
      <div className="rl-node">
        <LogsClientChip client={flow.client.value} t={t} />
        <span className="rl-node-text">
          <span className="rl-node-title">{clientLabel(flow.client.value, t)}</span>
          {flow.client.surface && <code className="rl-node-sub">{flow.client.surface}</code>}
        </span>
      </div>
      <span className="rl-arrow" aria-hidden="true" />
      <div className="rl-node rl-node--hub">
        <span className="rl-node-text">
          <span className="rl-node-title">OpenCodex</span>
          <code className="rl-node-sub">{flow.requested.alias ?? flow.requested.model}</code>
        </span>
      </div>
      <span className="rl-arrow" aria-hidden="true" />
      {candidates.length === 0 ? (
        <p className="rl-muted rl-empty-cands">{t("routeLive.noCandidates")}</p>
      ) : (
        <ul className="rl-cands">
          {candidates.map(c => (
            <li key={c.key} className={`rl-cand rl-cand--${c.status}`}>
              <span className="rl-cand-mark" aria-hidden="true">{STATUS_GLYPH[c.status]}</span>
              <span className="rl-cand-body">
                <span className="rl-cand-head">
                  <strong className="rl-cand-who">{candidateWho(c)}</strong>
                  <code className="rl-cand-model">{c.model}</code>
                  <span className="rl-cand-status">{t(STATUS_TKEY[c.status])}</span>
                </span>
                <CandidateDetail candidate={c} localeTag={localeTag} />
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
