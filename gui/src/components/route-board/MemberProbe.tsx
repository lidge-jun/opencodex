import { useEffect, useRef } from "react";
import { useT } from "../../i18n/shared";
import type { TKey } from "../../i18n/en";
import type { ProbeOutcome } from "../../route-board-model";

/** Runs one capability probe; `confirmed` repeats it with the operator's consent to metered requests. */
export type ProbeMemberModel = (provider: string, modelId: string, confirmed: boolean) => Promise<ProbeOutcome>;

export type ProbeState = { phase: "running" } | { phase: "settled"; outcome: ProbeOutcome };

const REASON_KEYS: Record<string, TKey> = {
  disabled: "routeBoard.probe.reason.disabled",
  forward_auth: "routeBoard.probe.reason.forward_auth",
  oauth_auth: "routeBoard.probe.reason.oauth_auth",
  unsupported_adapter: "routeBoard.probe.reason.unsupported_adapter",
  unsupported_transport: "routeBoard.probe.reason.unsupported_transport",
};

const STATUS_KEYS: Record<"accepted" | "rejected" | "inconclusive", TKey> = {
  accepted: "routeBoard.probe.accepted",
  rejected: "routeBoard.probe.rejected",
  inconclusive: "routeBoard.probe.inconclusive",
};

/**
 * What a "Test it" press is doing or found, under the member's row. A metered provider asks first
 * (with the number of requests), an inconclusive baseline changes nothing, and context is never
 * probed: it comes from the model name.
 */
export function ProbeResult({ state, onConfirm, onDismiss }: { state: ProbeState; onConfirm: () => void; onDismiss: () => void }) {
  const t = useT();
  const confirmRef = useRef<HTMLButtonElement>(null);
  const asking = state.phase === "settled" && state.outcome.kind === "confirm";
  useEffect(() => { if (asking) confirmRef.current?.focus(); }, [asking]);

  const body = (() => {
    if (state.phase === "running") return <p className="rb-member-note" role="status">{t("routeBoard.probe.running")}</p>;
    const outcome = state.outcome;
    switch (outcome.kind) {
      case "confirm":
        return (
          <div role="alertdialog" aria-label={t("routeBoard.probe.confirmTitle")} className="rb-probe-confirm">
            <p className="rb-member-note">{t("routeBoard.probe.confirm", { count: outcome.planned })}</p>
            <div className="rb-member-buttons">
              <button ref={confirmRef} type="button" className="btn btn-primary btn-sm" onClick={onConfirm}>{t("routeBoard.probe.confirmGo")}</button>
              <button type="button" className="btn btn-ghost btn-sm" onClick={onDismiss}>{t("common.cancel")}</button>
            </div>
          </div>
        );
      case "inapplicable":
        return <p className="rb-member-note" role="status">{t(REASON_KEYS[outcome.reason] ?? "routeBoard.probe.reason.other")}</p>;
      case "busy":
        return <p className="rb-member-note" role="status">{t("routeBoard.probe.busy")}</p>;
      case "failed":
        return <p className="rb-member-error" role="alert">{t("routeBoard.probe.failed")}</p>;
      case "done": {
        if (!outcome.baselineOk) return <p className="rb-member-note" role="status">{t("routeBoard.probe.uncertain")}</p>;
        const applied = [
          ...(outcome.applied.inputModalities ? [t("routeBoard.probe.appliedInput", { value: outcome.applied.inputModalities.join(" · ") })] : []),
          ...(outcome.applied.reasoningEfforts ? [t("routeBoard.probe.appliedEfforts", { value: outcome.applied.reasoningEfforts.join(" · ") || "—" })] : []),
        ];
        return (
          <ul className="rb-probe-results" role="status">
            {outcome.image && <li>{t("routeBoard.probe.image", { status: t(STATUS_KEYS[outcome.image]) })}</li>}
            {outcome.accepted.length + outcome.rejected.length + outcome.inconclusive.length > 0 && (
              <li>
                {t("routeBoard.probe.efforts", {
                  accepted: outcome.accepted.join(" · ") || "—",
                  rejected: outcome.rejected.join(" · ") || "—",
                  inconclusive: outcome.inconclusive.join(" · ") || "—",
                })}
              </li>
            )}
            <li>{applied.length > 0 ? applied.join("; ") : t("routeBoard.probe.nothingApplied")}</li>
          </ul>
        );
      }
    }
  })();

  return (
    <div className="rb-probe">
      {body}
      <p className="rb-member-note">{t("routeBoard.probe.contextNote")}</p>
      {!asking && state.phase === "settled" && (
        <div className="rb-member-buttons">
          <span className="rb-editor-spacer" />
          <button type="button" className="btn btn-ghost btn-sm" onClick={onDismiss}>{t("routeBoard.probe.close")}</button>
        </div>
      )}
    </div>
  );
}
