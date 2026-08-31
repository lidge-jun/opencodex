import type { ComboItem, ProviderQuotaStates } from "../combo-workspace-data";
import { buildComboAttention, groupCombos } from "../combo-workspace-data";
import { IconAlert, IconChevron, IconPlus } from "../icons";
import { useT, type TFn } from "../i18n/shared";

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
  onSelect,
  onAdd,
}: {
  combos: ComboItem[];
  cataloguedComboIds?: ReadonlySet<string>;
  providerMap: Readonly<Record<string, { disabled?: boolean }>>;
  providerQuotaStates: ProviderQuotaStates;
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
