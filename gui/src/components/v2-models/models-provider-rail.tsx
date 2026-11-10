import { useT } from "../../i18n/shared";
import { formatProviderDisplayName } from "../../provider-icons";
import { cn } from "@/lib/utils";
import { ProviderMark } from "./provider-mark";

export interface RailItem {
  provider: string;
  active: number;
  total: number;
}

/*
 * The Models catalog's provider list (React Bits app-sidebar pattern): one row per
 * provider with its logo, name and "on / total" count, plus "All providers" on top. The
 * selected row takes the raised plate the app sidebar uses; a thin meter under the name
 * shows at a glance how much of each provider is switched on.
 */
export function ModelsProviderRail({ items, all, selected, onSelect }: {
  items: RailItem[];
  all: { active: number; total: number };
  selected: string | null;
  onSelect: (provider: string | null) => void;
}) {
  const t = useT();
  return (
    // No `ui-v2` marker: its button reset sits in a layer above models.css, which styles these rows.
    <aside className="models-workspace-rail" aria-label={t("nav.models")}>
      <div className="models-workspace-rail-header">
        <span className="models-workspace-rail-title">{t("models.workspace.providers")}</span>
        <span className="models-workspace-rail-count">{items.length}</span>
      </div>
      <div className="models-workspace-rail-list">
        <RailRow label={t("models.workspace.allProviders")} meta={t("models.active", all)} ratio={all.total ? all.active / all.total : 0}
          current={selected === null} onClick={() => onSelect(null)} />
        {items.map(item => (
          <RailRow key={item.provider} provider={item.provider} label={formatProviderDisplayName(item.provider, t)}
            meta={t("models.active", { active: item.active, total: item.total })} ratio={item.total ? item.active / item.total : 0}
            current={selected === item.provider} onClick={() => onSelect(item.provider)} />
        ))}
      </div>
    </aside>
  );
}

function RailRow({ provider, label, meta, ratio, current, onClick }: {
  provider?: string;
  label: string;
  meta: string;
  ratio: number;
  current: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={cn("models-workspace-rail-row", current && "models-workspace-rail-row--selected")}
      onClick={onClick}
      aria-current={current ? "true" : undefined}
    >
      {provider ? <ProviderMark name={provider} /> : <span aria-hidden="true" className="models-rail-all-mark" />}
      <span className="models-workspace-rail-name">{label}</span>
      <span className="models-workspace-rail-meta">{meta}</span>
      <span aria-hidden="true" className="models-rail-meter">
        <span style={{ width: `${Math.round(ratio * 100)}%` }} />
      </span>
    </button>
  );
}
