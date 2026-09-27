/**
 * "Request path preview" on the API page: which path a request for one model would take,
 * asked of the server and rendered as it answers.
 *
 * Delivery mode (native / translated / legacy bridge / blocked) is how a request travels,
 * not whether it was verified. Verification is a Lab verdict and lives on the compatibility
 * matrix; this panel shows no verification badge and never borrows `ExternalModelRow.native`,
 * which means "an OpenAI model id", not "a native path".
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { DeliveryMode, Fidelity, Protocol, ProtocolHop } from "../../../../src/protocols/contract";
import type { ProtocolPlanV1 } from "../../../../src/protocols/dto";
import { FEATURE_SOURCES, PROTOCOL_FEATURES, type ProtocolFeature } from "../../../../src/protocols/features";
import type { ExternalModelRow, GatewayInboundProtocol } from "../../api-access-models";
import { useT, type TKey } from "../../i18n/shared";
import { fetchProtocolPlan } from "../../protocol-api";
import { openCompatibilityPair, openProviderSettings, protocolPairUpstream } from "../../protocol-deep-links";
import { FeatureDispositionList } from "./FeatureDispositionList";

const INBOUNDS: readonly Protocol[] = ["responses", "chat", "messages"];

const MODE_KEYS: Record<DeliveryMode, TKey> = {
  native: "api.plan.mode.native",
  translated: "api.plan.mode.translated",
  "legacy-bridge": "api.plan.mode.legacyBridge",
  blocked: "api.plan.mode.blocked",
};

const MODE_TONES: Record<DeliveryMode, string> = {
  native: "badge-green",
  translated: "badge-accent",
  "legacy-bridge": "badge-amber",
  blocked: "badge-muted",
};

const FIDELITY_KEYS: Record<Fidelity, TKey> = {
  preserved: "api.plan.fidelity.preserved",
  degraded: "api.plan.fidelity.degraded",
  unknown: "api.plan.fidelity.unknown",
};

const ROUTE_KIND_KEYS: Record<ProtocolPlanV1["routeKind"], TKey> = {
  direct: "api.plan.routeKind.direct",
  combo: "api.plan.routeKind.combo",
  policy: "api.plan.routeKind.policy",
  unknown: "api.plan.routeKind.unknown",
};

const PATH_SEPARATOR = " → ";

function PathText({ path }: { path: readonly ProtocolHop[] }) {
  const t = useT();
  return path.length > 0 ? <code>{path.join(PATH_SEPARATOR)}</code> : <span className="muted">{t("api.plan.noPath")}</span>;
}

function FeatureNames({ features }: { features: readonly ProtocolFeature[] }) {
  const t = useT();
  if (features.length === 0) return <span className="muted">{t("api.plan.none")}</span>;
  return (
    <span className="protocol-plan-chips">
      {features.map(feature => <code key={feature} className="chip">{feature}</code>)}
    </span>
  );
}

/**
 * One plan, candidate by candidate. Each candidate links to its provider's settings (which
 * wire it receives) and to the compatibility matrix for its pair (what the Lab has verified);
 * the plan itself never claims verification. Shared with the combo detail panel.
 */
export function PlanResult({ plan }: { plan: ProtocolPlanV1 }) {
  const t = useT();
  return (
    <div className="protocol-plan-result" aria-live="polite">
      <dl className="awi-kv">
        <div className="awi-kv-row">
          <dt>{t("api.plan.overallMode")}</dt>
          <dd><span className={`badge ${MODE_TONES[plan.mode]}`}>{t(MODE_KEYS[plan.mode])}</span></dd>
        </div>
        <div className="awi-kv-row">
          <dt>{t("api.plan.routeKind")}</dt>
          <dd>{t(ROUTE_KIND_KEYS[plan.routeKind])}</dd>
        </div>
        {plan.reasonCodes.length > 0 && (
          <div className="awi-kv-row">
            <dt>{t("api.plan.reasons")}</dt>
            <dd><span className="protocol-plan-chips">{plan.reasonCodes.map(code => <code key={code} className="chip">{code}</code>)}</span></dd>
          </div>
        )}
        <div className="awi-kv-row">
          <dt>{t("api.plan.guaranteed")}</dt>
          <dd><FeatureNames features={plan.guaranteedFeatures} /></dd>
        </div>
        <div className="awi-kv-row">
          <dt>{t("api.plan.partial")}</dt>
          <dd><FeatureNames features={plan.partialFeatures} /></dd>
        </div>
        <div className="awi-kv-row">
          <dt>{t("api.plan.policyRevision")}</dt>
          <dd><code>{plan.policyRevision}</code></dd>
        </div>
      </dl>
      {plan.candidates.length === 0 ? (
        <p className="muted small">{t("api.plan.noCandidates")}</p>
      ) : (
        <ol className="protocol-plan-candidates">
          {plan.candidates.map(candidate => (
            <li key={`${candidate.provider}/${candidate.model}`} className="protocol-plan-candidate">
              <div className="protocol-plan-candidate-head">
                <code>{candidate.provider}/{candidate.model}</code>
                <span className={`badge ${MODE_TONES[candidate.mode]}`}>{t(MODE_KEYS[candidate.mode])}</span>
                {!candidate.eligible && candidate.mode !== "blocked" && (
                  <span className="badge badge-muted">{t("api.plan.ineligible")}</span>
                )}
              </div>
              <dl className="awi-kv">
                <div className="awi-kv-row">
                  <dt>{t("api.plan.requestPath")}</dt>
                  <dd><PathText path={candidate.requestPath} /></dd>
                </div>
                <div className="awi-kv-row">
                  <dt>{t("api.plan.responsePath")}</dt>
                  <dd><PathText path={candidate.responsePath} /></dd>
                </div>
                <div className="awi-kv-row">
                  <dt>{t("api.plan.fidelity")}</dt>
                  <dd>{t(FIDELITY_KEYS[candidate.fidelity])}</dd>
                </div>
                {candidate.reasonCodes.length > 0 && (
                  <div className="awi-kv-row">
                    <dt>{t("api.plan.reasons")}</dt>
                    <dd><span className="protocol-plan-chips">{candidate.reasonCodes.map(code => <code key={code} className="chip">{code}</code>)}</span></dd>
                  </div>
                )}
              </dl>
              <FeatureDispositionList effects={candidate.featureEffects} unknownFeatures={candidate.unknownFeatures} />
              <div className="protocol-plan-links">
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => openProviderSettings(candidate.provider)}>
                  {t("protocolLinks.providerSettings")}
                </button>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  onClick={() => openCompatibilityPair({ inbound: plan.inbound, upstream: protocolPairUpstream(candidate.upstream) })}
                >
                  {t("protocolLinks.labEvidence")}
                </button>
              </div>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

export function ProtocolPlanPanel({
  apiBase,
  models,
  protocolLabel,
}: {
  apiBase: string;
  models: readonly ExternalModelRow[];
  protocolLabel: (protocol: GatewayInboundProtocol) => string;
}) {
  const t = useT();
  const [model, setModel] = useState("");
  const [inbound, setInbound] = useState<Protocol>("chat");
  const [features, setFeatures] = useState<ReadonlySet<ProtocolFeature>>(() => new Set());
  const [plan, setPlan] = useState<ProtocolPlanV1 | null>(null);
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const controllerRef = useRef<AbortController | null>(null);

  // The caller keys this panel by `apiBase`, so a different target remounts it with fresh
  // state; all that is left to do here is cancel a preview still in flight.
  useEffect(() => () => controllerRef.current?.abort(), []);

  const selectedModel = model || models[0]?.id || "";
  const expressible = useMemo(
    () => PROTOCOL_FEATURES.filter(feature => FEATURE_SOURCES[feature].includes(inbound)),
    [inbound],
  );

  const changeInbound = (next: Protocol) => {
    setInbound(next);
    setFeatures(current => new Set([...current].filter(feature => FEATURE_SOURCES[feature].includes(next))));
  };

  const toggleFeature = (feature: ProtocolFeature, on: boolean) => {
    setFeatures(current => {
      const next = new Set(current);
      if (on) next.add(feature);
      else next.delete(feature);
      return next;
    });
  };

  const runPreview = async () => {
    if (!selectedModel || pending) return;
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    setPending(true);
    setFailed(false);
    try {
      const result = await fetchProtocolPlan(apiBase, { model: selectedModel, inbound, features: [...features] }, controller.signal);
      if (controller.signal.aborted) return;
      if (result.kind === "unavailable") {
        setUnavailable(true);
        setPlan(null);
      } else if (result.kind === "error") {
        setFailed(true);
      } else {
        setPlan(result.plan);
      }
    } catch {
      // Aborted by a newer preview or by leaving the page; the newer one owns the state.
    } finally {
      if (controllerRef.current === controller) setPending(false);
    }
  };

  return (
    <div className="panel api-panel protocol-plan-panel">
      <h3 className="panel-title">{t("api.plan.title")}</h3>
      <p className="muted small">{t("api.plan.description")}</p>
      <p className="muted small">{t("api.plan.modeNote")}</p>
      {unavailable ? (
        <p className="muted small">{t("api.plan.unavailable")}</p>
      ) : models.length === 0 ? (
        <p className="muted small">{t("api.plan.noModels")}</p>
      ) : (
        <>
          <div className="protocol-plan-form">
            <label className="protocol-plan-field">
              <span className="muted small">{t("api.plan.model")}</span>
              <select className="input" value={selectedModel} onChange={event => setModel(event.target.value)}>
                {models.map(row => <option key={row.id} value={row.id}>{row.id}</option>)}
              </select>
            </label>
            <label className="protocol-plan-field">
              <span className="muted small">{t("api.plan.inbound")}</span>
              <select className="input" value={inbound} onChange={event => changeInbound(event.target.value as Protocol)}>
                {INBOUNDS.map(protocol => <option key={protocol} value={protocol}>{protocolLabel(protocol)}</option>)}
              </select>
            </label>
          </div>
          <fieldset className="protocol-plan-features">
            <legend className="muted small">{t("api.plan.features")}</legend>
            {expressible.map(feature => (
              <label key={feature} className="protocol-plan-feature">
                <input
                  type="checkbox"
                  checked={features.has(feature)}
                  onChange={event => toggleFeature(feature, event.target.checked)}
                />
                <code>{feature}</code>
              </label>
            ))}
          </fieldset>
          <div>
            <button type="button" className="btn btn-sm" disabled={!selectedModel || pending} onClick={() => { void runPreview(); }}>
              {pending ? t("api.plan.previewing") : t("api.plan.preview")}
            </button>
          </div>
          {failed && <p className="awi-delete-error" role="alert">{t("api.plan.failed")}</p>}
          {plan && <PlanResult plan={plan} />}
        </>
      )}
    </div>
  );
}
