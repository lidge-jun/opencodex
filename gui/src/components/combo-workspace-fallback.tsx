import { useEffect, useId, useState, type ReactNode } from "react";
import {
  COMBO_STRATEGY_HINT_KEYS, COMBO_TARGETS_HINT_KEYS,
  type ComboItem, type ComboTarget, type ProviderQuotaStates,
} from "../combo-workspace-data";
import { IconAlert, IconLock, IconRoute } from "../icons";
import { useT } from "../i18n/shared";
import { Switch } from "../ui";
import { TargetEditor } from "./combo-target-editor";
import { StrategySeg } from "./combo-workspace-controls";
import type { ModelOption, ProviderOption } from "./combo-workspace-types";
import { comboTargetBilling, comboTargetProviderName } from "./combo-workspace-utils";
import "./combo-routing.css";

type StopReason = "incomplete" | "provider" | "consent" | "model";
type StepState = "eligible" | "blocked" | "skipped" | "unreached";

type FallbackRoutes = Record<string, { provider: string; model: string; requiresConsent: boolean } | null>;

function useFallbackRoutes(apiBase: string | undefined, draft: ComboItem, providers: ProviderOption[], routingRevision?: string) {
  const params = new URLSearchParams();
  if (apiBase !== undefined && draft.strategy === "failover") {
    const selectors = new Set(draft.targets.filter(target => target.provider && target.model)
      .map(target => `${target.provider}/${target.model}`));
    for (const selector of [...selectors].sort()) params.append("fallbackTarget", selector);
  }
  const url = params.size ? `${apiBase}/api/combos?${params}` : undefined;
  // A provider edit can change how a selector resolves, so it invalidates the previous answer.
  const revision = JSON.stringify(providers.map(provider =>
    [provider.name, provider.disabled, provider.comboBilling, provider.authMode, provider.adapter, provider.baseUrl]));
  const key = url && `${url} ${revision} ${routingRevision ?? ""}`;
  const [snapshot, setSnapshot] = useState<{ key: string; routes?: FallbackRoutes }>();
  useEffect(() => {
    if (!url || !key) return;
    const controller = new AbortController();
    void fetch(url, { signal: controller.signal })
      .then(async response => response.ok ? (await response.json() as { routes?: FallbackRoutes }).routes : undefined)
      .catch(() => undefined)
      .then(routes => { if (!controller.signal.aborted) setSnapshot({ key, routes }); });
    return () => controller.abort();
  }, [url, key]);
  // Until an answer carries routes (pending, offline, refused, or an older server), the preview shows the configured targets.
  const answer = snapshot?.key === key ? snapshot : undefined;
  return { routes: answer?.routes, unchecked: draft.strategy === "failover"
    && draft.targets.some(target => target.provider && target.model) && answer?.routes === undefined };
}

function requiresConsent(target: ComboTarget, provider: ProviderOption | undefined, strict: boolean, routes?: FallbackRoutes) {
  const resolved = routes?.[`${target.provider}/${target.model}`];
  return target.metered === true || (strict && (resolved?.requiresConsent
    ?? (provider !== undefined && comboTargetBilling(provider) === "consent")));
}

function fallbackSteps(draft: ComboItem, providers: ProviderOption[], routes?: FallbackRoutes) {
  const byName = new Map(providers.map(provider => [provider.name, provider]));
  const first = draft.targets[0];
  const originalModel = first && routes?.[`${first.provider}/${first.model}`]?.model;
  let stop: { step: number; reason: StopReason } | undefined;

  const steps = draft.targets.map((target, index) => {
    const provider = byName.get(target.provider);
    const resolved = routes?.[`${target.provider}/${target.model}`];
    const resolvedProvider = resolved ? byName.get(resolved.provider) : provider;
    const model = resolved?.model ?? target.model;
    const paid = requiresConsent(target, provider, draft.quotaOnlyFallback === true, routes);
    const channel = resolvedProvider && comboTargetBilling(resolvedProvider);
    const billing = paid ? "cws.preview.paid"
      : channel === "subscription" ? "comboSuggest.tier.subscription"
      : channel === "local" ? "pws.type.local"
      : provider ? "cws.preview.billingUnknown" : undefined;

    let reason: StopReason | undefined;
    let state: StepState = "eligible";
    if (stop) {
      state = "unreached";
    } else {
      if (!target.provider || !target.model) reason = "incomplete";
      else if (!provider || provider.disabled || resolved === null) reason = "provider";
      else if (paid && !draft.allowMeteredTargets) reason = "consent";
      else if (draft.preserveFallbackModel && originalModel && resolved && originalModel !== resolved.model) reason = "model";

      if (reason && (draft.quotaOnlyFallback || reason === "model")) {
        state = "blocked";
        stop = { step: index + 1, reason };
      } else if (reason) {
        state = "skipped";
      }
    }
    return { target, provider: resolvedProvider, model, billing, state, reason, paid } as const;
  });
  return { steps, stop };
}

export function ComboFallbackPreview({ draft, providers, consent, routes, routesUnchecked }: {
  draft: ComboItem;
  providers: ProviderOption[];
  consent?: ReactNode;
  routes?: FallbackRoutes;
  routesUnchecked?: boolean;
}) {
  const t = useT();
  const heading = useId();
  if (draft.strategy !== "failover" || !draft.targets.some(target => target.provider)) return null;
  const { steps, stop } = fallbackSteps(draft, providers, routes);
  const StatusIcon = stop?.reason === "consent" ? IconLock : stop ? IconAlert : IconRoute;
  return (
    <section className="cwi-preview" aria-labelledby={heading}>
      <h3 id={heading}>{t("cws.preview.title")}</h3>
      <div className="cwi-preview-status" role="status" data-blocked={stop ? "" : undefined}>
        <StatusIcon width={18} height={18} aria-hidden="true" />
        <div>
          <strong>{stop ? t("cws.preview.stopAt", { step: stop.step }) : t("cws.preview.terminal")}</strong>
          {stop && <span>{t(`cws.preview.${stop.reason}`)}</span>}
        </div>
      </div>
      {consent && <div className="cwi-preview-consent">{consent}</div>}
      <ol className="cwi-preview-steps" role="list">
        {steps.map(({ target, provider, model, billing, state, reason, paid }, index) => (
          <li key={target.clientKey ?? index} data-state={state}>
            <span className="cwi-preview-index" aria-hidden="true">{index + 1}</span>
            <div className="cwi-preview-step">
              <strong>{target.provider ? comboTargetProviderName(provider?.name ?? target.provider, provider, t) : t("cws.target.pickProvider")}</strong>
              {model && <code>{model}</code>}
              {state === "unreached" && <span>{t("cws.preview.unreached")}</span>}
              {state === "skipped" && reason && <span>{t("cws.preview.skipped", { reason: t(`cws.preview.${reason}`) })}</span>}
            </div>
            {billing && <span className="cwi-billing-label" data-paid={paid ? "" : undefined}>{t(billing)}</span>}
          </li>
        ))}
      </ol>
      <p className="cwi-preview-note">{t(routesUnchecked ? "cws.preview.unchecked" : "cws.preview.note")}</p>
    </section>
  );
}

export function ComboRoutingEditor({ apiBase, draft, providers, models, capabilityModels, providerQuotaStates,
  disabled, inDialog, offerSubscriptionsOnly, onChange, routingRevision,
}: {
  apiBase?: string;
  routingRevision?: string;
  draft: ComboItem;
  providers: ProviderOption[];
  models: ModelOption[];
  capabilityModels: ModelOption[];
  providerQuotaStates: ProviderQuotaStates;
  disabled: boolean;
  inDialog?: boolean;
  /** A new preset offers to drop every target that would need paid-call consent. */
  offerSubscriptionsOnly?: boolean;
  onChange: (patch: Partial<ComboItem>) => void;
}) {
  const t = useT();
  const heading = useId();
  const failover = draft.strategy === "failover";
  const showPreview = failover && draft.targets.some(target => target.provider);
  const { routes, unchecked: routesUnchecked } = useFallbackRoutes(apiBase, draft, providers, routingRevision);
  const strict = failover && draft.quotaOnlyFallback === true;
  const targetRequiresConsent = (target: ComboTarget) =>
    requiresConsent(target, providers.find(provider => provider.name === target.provider), strict, routes);
  const showConsent = draft.allowMeteredTargets || draft.targets.some(targetRequiresConsent);
  const includedTargets = offerSubscriptionsOnly ? draft.targets.filter(target => !targetRequiresConsent(target)) : undefined;
  const consent = showConsent && (
    <Switch showLabel label={t("cws.allowPaidLocal")} on={draft.allowMeteredTargets === true} disabled={disabled}
      onClick={() => onChange({ allowMeteredTargets: !draft.allowMeteredTargets })} />
  );

  return (
    <section className="cwi-routing" aria-labelledby={heading}>
      <div className="cwi-routing-strategy">
        <h3 id={heading}>{t("cws.strategy")}</h3>
        <StrategySeg value={draft.strategy} disabled={disabled} onChange={(strategy) => onChange({ strategy })} />
        <p>{t(failover && draft.quotaOnlyFallback ? "cws.preview.quotaRule" : COMBO_STRATEGY_HINT_KEYS[draft.strategy])}</p>
        {(failover || (showConsent && !showPreview)) && (
          <div className="cwi-routing-rules">
            {failover && (
              <>
                <Switch showLabel label={t("cws.quotaOnly")} on={draft.quotaOnlyFallback === true} disabled={disabled}
                  onClick={() => onChange({ quotaOnlyFallback: !draft.quotaOnlyFallback })} />
                <Switch showLabel label={t("cws.preserveModel")} on={draft.preserveFallbackModel === true} disabled={disabled}
                  onClick={() => onChange({ preserveFallbackModel: !draft.preserveFallbackModel })} />
              </>
            )}
            {!showPreview && consent}
          </div>
        )}
      </div>
      <div className="cwi-routing-layout" data-preview={showPreview ? "" : undefined}>
        {showPreview && <ComboFallbackPreview draft={draft} providers={providers} consent={consent} routes={routes}
          routesUnchecked={routesUnchecked} />}
        <div className="cwi-routing-targets">
          <div className="cwi-routing-target-head">
            <h3>{t("cws.targets")}</h3>
            {includedTargets && includedTargets.length > 0 && includedTargets.length < draft.targets.length && (
              <button type="button" className="btn btn-ghost btn-sm" disabled={disabled}
                onClick={() => onChange({ targets: includedTargets, allowMeteredTargets: false })}>
                {t("cws.preview.subscriptionsOnly")}
              </button>
            )}
          </div>
          <TargetEditor
            targets={draft.targets}
            strategy={draft.strategy}
            requiresAutomaticConsent={strict ? target => targetRequiresConsent({ ...target, metered: false }) : undefined}
            providers={providers}
            models={models}
            capabilityModels={capabilityModels}
            providerQuotaStates={providerQuotaStates}
            inDialog={inDialog}
            disabled={disabled}
            onChange={(targets) => onChange({ targets })}
          />
          {!failover && <p className="cwi-preview-note">{t(COMBO_TARGETS_HINT_KEYS[draft.strategy])}</p>}
        </div>
      </div>
    </section>
  );
}
