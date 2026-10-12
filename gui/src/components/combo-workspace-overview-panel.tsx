import type { ComboItem, ProviderQuotaStates } from "../combo-workspace-data";
import { buildComboAttention, groupCombos, jevDecisionSummary } from "../combo-workspace-data";
import { IconAlert, IconChevron, IconPlus } from "../icons";
import { useT, type TFn } from "../i18n/shared";
import type { ProviderOption } from "./combo-workspace-types";

function attentionCopy(
  reason: "empty-targets" | "few-targets" | "catalog-omitted" | "all-targets-exhausted",
  t: TFn,
): string {
  if (reason === "empty-targets") return t("cws.attention.empty");
  if (reason === "catalog-omitted") return t("cws.attention.catalogOmitted");
  if (reason === "all-targets-exhausted") return t("cws.attention.allTargetsExhausted");
  return t("cws.attention.few");
}

export function OverviewPanel({
  combos,
  cataloguedComboIds,
  providerMap,
  providerQuotaStates,
  providers,
  onSelect,
  onAdd,
}: {
  combos: ComboItem[];
  cataloguedComboIds?: ReadonlySet<string>;
  providerMap: Readonly<Record<string, { disabled?: boolean }>>;
  providerQuotaStates: ProviderQuotaStates;
  /** Configured providers; resolves a JEV combo's decision service to its endpoint. */
  providers: readonly ProviderOption[];
  onSelect: (id: string) => void;
  onAdd: () => void;
}) {
  const t = useT();
  const sections = groupCombos(combos);
  const attention = buildComboAttention(combos, {
    cataloguedComboIds,
    providers: providerMap,
    providerQuotaStates,
  });
  const jevCombos = combos.flatMap((item) => {
    const decision = jevDecisionSummary(item, providers);
    return decision ? [{ item, decision }] : [];
  });

  return (
    <div className="combos-workspace-overview">
      <div className="combos-workspace-overview-head">
        <h2 className="combos-workspace-overview-title">{t("cws.overviewTitle")}</h2>
        <button type="button" className="btn btn-primary btn-sm" onClick={onAdd}>
          <IconPlus width={14} height={14} /> {t("cws.add")}
        </button>
      </div>
      <p className="muted" style={{ marginTop: 0, maxWidth: "62ch" }}>{t("cws.overviewBlurb")}</p>
      <div className="cwi-count-strip">
        <div className="cwi-count-pill"><strong>{combos.length}</strong><span>{t("cws.count.total")}</span></div>
        <div className="cwi-count-pill"><strong>{sections.failover.length}</strong><span>{t("cws.count.failover")}</span></div>
        <div className="cwi-count-pill"><strong>{sections.roundRobin.length}</strong><span>{t("cws.count.roundRobin")}</span></div>
        <div className="cwi-count-pill"><strong>{sections.other.length}</strong><span>{t("cws.count.other")}</span></div>
      </div>

      <section className="pwi-section" aria-label={t("cws.howTitle")}>
        <h3 className="pwi-section-title">{t("cws.howTitle")}</h3>
        <p className="muted" style={{ margin: 0 }}>{t("cws.howBody")}</p>
      </section>

      {jevCombos.length > 0 && (
        <section className="pwi-section" aria-label={t("cws.jev.decisionServicesTitle")}>
          <h3 className="pwi-section-title">{t("cws.jev.decisionServicesTitle")}</h3>
          <div className="cwi-attention-list">
            {jevCombos.map(({ item, decision }) => (
              <button
                key={item.id}
                type="button"
                className="cwi-attention-row"
                style={{ flexWrap: "wrap" }}
                data-decision-provider={decision.model ? undefined : decision.provider ?? "jev"}
                data-decision-model={decision.model ?? undefined}
                onClick={() => onSelect(item.id)}
              >
                <code className="chip">{item.model}</code>
                {decision.model
                  ? <span>{t("cws.jev.method.model")}: <code>{decision.model}</code></span>
                  : <span>{decision.provider ?? t("cws.jev.decisionServiceDefault")}</span>}
                {decision.baseUrl && <code className="muted" style={{ overflowWrap: "anywhere" }}>{decision.baseUrl}</code>}
                <span className="muted">
                  {decision.timeoutMs === null
                    ? t("cws.jev.decisionTimeoutDefaultShort")
                    : t("cws.jev.decisionTimeoutShort", { ms: decision.timeoutMs })}
                </span>
                <IconChevron width={14} height={14} style={{ marginLeft: "auto" }} aria-hidden="true" />
              </button>
            ))}
          </div>
        </section>
      )}

      {attention.length > 0 && (
        <section className="pwi-section" aria-label={t("cws.attentionTitle")}>
          <h3 className="pwi-section-title">{t("cws.attentionTitle")}</h3>
          <div className="cwi-attention-list">
            {attention.map((item) => (
              <button
                key={`${item.id}:${item.reason}`}
                type="button"
                className="cwi-attention-row"
                onClick={() => onSelect(item.id)}
              >
                <IconAlert width={14} height={14} aria-hidden="true" />
                <code className="chip">{item.model}</code>
                <span className="muted">{attentionCopy(item.reason, t)}</span>
                <IconChevron width={14} height={14} style={{ marginLeft: "auto" }} aria-hidden="true" />
              </button>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
