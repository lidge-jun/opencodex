import { parseProtocolTraceV1 } from "../../../../src/protocols/dto";
import type { TFn } from "../../i18n/shared";
import { openCompatibilityPair, protocolPairUpstream } from "../../protocol-deep-links";
import { FEATURE_DISPOSITION_KEYS, PROTOCOL_MODE_KEYS, protocolHopLabel, protocolPathLabel } from "./protocol-labels";

/**
 * The protocol section of the Logs detail dialog: what this request actually did, attempt by
 * attempt. Reason codes and feature ids are fixed machine identifiers and render as code; the
 * internal Responses hop is labelled as internal. A row without a valid trace says so instead
 * of inferring a path from other fields. A traced row links to the compatibility matrix
 * prefiltered to its client API and upstream wire, where the Lab verdicts (not this trace) live.
 */
export function ProtocolTracePanel({ trace, t }: { trace: unknown; t: TFn }) {
  const parsed = parseProtocolTraceV1(trace);
  return (
    <section className="log-detail-section" aria-labelledby="log-detail-protocol">
      <h4 id="log-detail-protocol" className="log-detail-section-title">{t("logs.detail.protocol.section")}</h4>
      {parsed ? (
        <>
          <div className="log-detail-grid" data-protocol-mode={parsed.mode}>
            <span className="muted">{t("logs.detail.protocol.inbound")}</span>
            <span>{protocolHopLabel(parsed.inbound, t)}</span>
            <span className="muted">{t("logs.detail.protocol.mode")}</span>
            <span>{t(PROTOCOL_MODE_KEYS[parsed.mode])}</span>
            {parsed.upstream && (
              <>
                <span className="muted">{t("logs.detail.protocol.upstream")}</span>
                <span>{protocolHopLabel(parsed.upstream, t)}</span>
              </>
            )}
            {parsed.requestPath.length > 0 && (
              <>
                <span className="muted">{t("logs.detail.protocol.requestPath")}</span>
                <span>{protocolPathLabel(parsed.requestPath, t)}</span>
                <span className="muted">{t("logs.detail.protocol.responsePath")}</span>
                <span>{protocolPathLabel(parsed.responsePath, t)}</span>
              </>
            )}
            <span className="muted">{t("logs.detail.protocol.reasons")}</span>
            <span className="mono log-detail-break">{parsed.reasonCodes.join(", ") || "–"}</span>
            {parsed.featureEffects && parsed.featureEffects.length > 0 && (
              <>
                <span className="muted">{t("logs.detail.protocol.features")}</span>
                <span>
                  {parsed.featureEffects.map(effect => (
                    <span key={effect.feature} style={{ display: "block" }}>
                      <code>{effect.feature}</code>: {t(FEATURE_DISPOSITION_KEYS[effect.disposition])}
                    </span>
                  ))}
                </span>
              </>
            )}
            {parsed.attempts && parsed.attempts.length > 0 && (
              <>
                <span className="muted">{t("logs.detail.protocol.attempts")}</span>
                <span>
                  {parsed.attempts.map(attempt => (
                    <span key={attempt.ordinal} style={{ display: "block" }}>
                      {t("logs.detail.protocol.attempt", { ordinal: attempt.ordinal })}:{" "}
                      {protocolPathLabel(attempt.requestPath, t)} · {t(PROTOCOL_MODE_KEYS[attempt.mode])}
                    </span>
                  ))}
                </span>
              </>
            )}
          </div>
          <button
            type="button"
            className="btn btn-ghost btn-sm protocol-deep-link"
            onClick={() => openCompatibilityPair({ inbound: parsed.inbound, upstream: protocolPairUpstream(parsed.upstream) })}
          >
            {t("protocolLinks.labEvidence")}
          </button>
        </>
      ) : (
        <p className="log-detail-notes-line muted">{t("logs.detail.protocol.none")}</p>
      )}
    </section>
  );
}
