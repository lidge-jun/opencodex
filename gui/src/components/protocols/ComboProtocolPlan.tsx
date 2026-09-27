/**
 * Combo detail: what each target would do with a request, and which features every target
 * keeps versus only some of them — asked of `POST /api/protocols/plan`, never computed here.
 *
 * The preview runs on demand (one button, like the API page's preview), for every feature the
 * chosen client API can express, so the guaranteed/partial split covers the whole vocabulary.
 * It reads the SAVED combo: an unsaved target edit is not in the config the server plans from.
 * An older server without the route hides the section.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { PROTOCOLS, type Protocol } from "../../../../src/protocols/contract";
import type { ProtocolPlanV1 } from "../../../../src/protocols/dto";
import { FEATURE_SOURCES, PROTOCOL_FEATURES } from "../../../../src/protocols/features";
import { useT } from "../../i18n/shared";
import { fetchProtocolPlan } from "../../protocol-api";
import { protocolHopLabel } from "./protocol-labels";
import { PlanResult } from "./ProtocolPlanPanel";

export function ComboProtocolPlan({ apiBase, model, dirty }: {
  apiBase: string;
  /** The combo's public model id, as a client would send it. */
  model: string;
  /** The editor holds unsaved changes the preview cannot see. */
  dirty: boolean;
}) {
  const t = useT();
  const [inbound, setInbound] = useState<Protocol>("responses");
  const [plan, setPlan] = useState<ProtocolPlanV1 | null>(null);
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const controllerRef = useRef<AbortController | null>(null);

  useEffect(() => () => controllerRef.current?.abort(), []);

  const features = useMemo(
    () => PROTOCOL_FEATURES.filter(feature => FEATURE_SOURCES[feature].includes(inbound)),
    [inbound],
  );

  const run = async () => {
    if (pending) return;
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    setPending(true);
    setFailed(false);
    try {
      const result = await fetchProtocolPlan(apiBase, { model, inbound, features }, controller.signal);
      if (controller.signal.aborted) return;
      if (result.kind === "unavailable") setUnavailable(true);
      else if (result.kind === "error") setFailed(true);
      else setPlan(result.plan);
    } catch {
      // Aborted by a newer preview or by leaving the combo.
    } finally {
      if (controllerRef.current === controller) setPending(false);
    }
  };

  if (unavailable) return null;
  return (
    <section className="pwi-section combo-protocol-plan" aria-labelledby="cws-plan-title">
      <h3 id="cws-plan-title" className="pwi-section-title">{t("cws.plan.title")}</h3>
      <p className="muted small">{t("cws.plan.description")}</p>
      <p className="muted small">{t("api.plan.modeNote")}</p>
      {dirty && <p className="muted small" role="status">{t("cws.plan.savedOnly")}</p>}
      <div className="protocol-plan-form">
        <label className="protocol-plan-field">
          <span className="muted small">{t("api.plan.inbound")}</span>
          <select
            className="input"
            value={inbound}
            onChange={event => { setInbound(event.target.value as Protocol); setPlan(null); }}
          >
            {PROTOCOLS.map(protocol => <option key={protocol} value={protocol}>{protocolHopLabel(protocol, t)}</option>)}
          </select>
        </label>
      </div>
      <div>
        <button type="button" className="btn btn-sm" disabled={pending} onClick={() => { void run(); }}>
          {pending ? t("api.plan.previewing") : t("cws.plan.run")}
        </button>
      </div>
      {failed && <p className="awi-delete-error" role="alert">{t("api.plan.failed")}</p>}
      {plan && plan.inbound === inbound && <PlanResult plan={plan} />}
    </section>
  );
}
