import { IconLock } from "../../icons";
import { EmptyState, Notice, Switch } from "../../ui";
import { useT } from "../../i18n/shared";
import { GUARDRAILS_DATA_TYPE_KEYS } from "./constants";
import type { GuardrailsOverview, GuardrailsSettingsPatch } from "./types";

const RESULT_KEYS = {
  scanned: "guardrails.result.scanned",
  masked: "guardrails.result.masked",
  detected: "guardrails.result.detected",
  blocked: "guardrails.result.blocked",
  passthrough: "guardrails.result.passthrough",
  demask_warning: "guardrails.result.demaskWarning",
  tool_argument_restore_skipped: "guardrails.result.toolSkipped",
} as const;

export function GuardrailsOverviewPanel({
  data,
  pending,
  onSettings,
}: {
  data: GuardrailsOverview;
  pending: boolean;
  onSettings: (
    patch: GuardrailsSettingsPatch,
    consequence?: "disable" | "detect" | "passthrough",
  ) => void;
}) {
  const t = useT();
  const counters = data.overview.counters;
  const lastPassthroughAt = data.overview.lastPassthroughAt;
  const registryStatusKey = data.registry.status === "ready"
    ? "guardrails.registryReady"
    : data.registry.status === "failed"
      ? "guardrails.registryFailed"
      : "guardrails.registryDisabled";
  return (
    <div className="guardrails-panel-stack">
      {(data.mode === "detect" || data.failurePolicy === "passthrough") && (
        <Notice tone="warn">
          {data.mode === "detect" ? t("guardrails.detectWarning") : t("guardrails.passthroughWarning")}
        </Notice>
      )}
      <section className="card guardrails-overview-hero">
        <div>
          <strong>{t("guardrails.enabled")}</strong>
          <p className="card-sub">{t("guardrails.enabledHint")}</p>
          <div className="guardrails-registry-summary">
            <span className={`badge ${data.registry.status === "ready" ? "badge-green" : data.registry.status === "failed" ? "badge-amber" : "badge-muted"}`}>
              {t(registryStatusKey)}
            </span>
            <span>{t(data.mode === "enforce" ? "guardrails.modeEnforce" : "guardrails.modeDetect")}</span>
            <span>{t("guardrails.effectiveRules", { count: data.registry.effectiveRuleCount })}</span>
            {data.registry.generation !== null && (
              <span>{t("guardrails.registryGeneration", { generation: data.registry.generation })}</span>
            )}
          </div>
        </div>
        <Switch
          on={data.enabled}
          disabled={pending}
          label={t("guardrails.enabled")}
          onClick={() => onSettings(
            { enabled: !data.enabled },
            data.enabled ? "disable" : undefined,
          )}
        />
      </section>
      <div className="guardrails-metric-grid">
        {([
          ["guardrails.metric.scanned", counters.scanned],
          ["guardrails.metric.masked", counters.masked],
          ["guardrails.metric.detected", counters.detected],
          ["guardrails.metric.errors", counters.blocked + counters.passthrough + counters.demaskWarning],
        ] as const).map(([key, value]) => (
          <section className="card guardrails-metric" key={key}>
            <span>{t(key)}</span><strong>{value.toLocaleString()}</strong>
          </section>
        ))}
      </div>
      {lastPassthroughAt !== null && (
        <Notice tone="warn">
          {t("guardrails.lastPassthrough", { date: new Date(lastPassthroughAt).toLocaleString() })}
        </Notice>
      )}
      <div className="guardrails-overview-columns">
        <section className="card">
          <div className="card-head"><strong>{t("guardrails.topRules")}</strong></div>
          {data.overview.topRules.length === 0
            ? <EmptyState title={t("guardrails.noActivity")} />
            : <ul className="guardrails-ranked-list">{data.overview.topRules.map(row => (
                <li key={row.id}><code>{row.id}</code><span>{row.count}</span></li>
              ))}</ul>}
        </section>
        <section className="card">
          <div className="card-head"><strong>{t("guardrails.topCategories")}</strong></div>
          {data.overview.topCategories.length === 0
            ? <EmptyState title={t("guardrails.noActivity")} />
            : <ul className="guardrails-ranked-list">{data.overview.topCategories.map(row => (
                <li key={row.id}><span>{t(GUARDRAILS_DATA_TYPE_KEYS[row.id])}</span><span>{row.count}</span></li>
              ))}</ul>}
        </section>
      </div>
      {data.overview.recentEvents.length === 0
        ? (
          <EmptyState icon={<IconLock />} title={t("guardrails.noActivity")}>
            {t("guardrails.noActivityHint")}
          </EmptyState>
        )
        : (
          <section className="card">
            <div className="card-head"><strong>{t("guardrails.recentActivity")}</strong></div>
            <ul className="guardrails-ranked-list">{data.overview.recentEvents.map(event => (
              <li key={event.id}>
                <span>
                  {new Date(event.timestamp).toLocaleString()} · {t(RESULT_KEYS[event.result])}
                  {" · "}
                  {t("guardrails.registryGeneration", { generation: event.registryGeneration })}
                </span>
                <span>{event.count}</span>
              </li>
            ))}</ul>
          </section>
        )}
    </div>
  );
}
