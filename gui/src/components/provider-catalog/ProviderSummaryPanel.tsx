import type { ReactNode } from "react";
import { IconLock, IconPlus } from "../../icons";

export default function ProviderSummaryPanel({
  headingId,
  title,
  description,
  emptyMessage,
  addLabel,
  addDescription,
  onAdd,
  children,
}: {
  headingId: string;
  title: string;
  description: string;
  emptyMessage?: string;
  addLabel: string;
  addDescription: string;
  onAdd: () => void;
  children?: ReactNode;
}) {
  return (
    <section className="panel panel-accent prov-accounts-panel" aria-labelledby={headingId}>
      <div className="prov-accounts-head">
        <div>
          <div className="row">
            <IconLock style={{ width: 16, height: 16, color: "var(--accent)" }} />
            <h3 id={headingId} className="text-subtitle">{title}</h3>
          </div>
          <p className="muted text-label leading-body" style={{ margin: "5px 0 0" }}>{description}</p>
        </div>
      </div>
      <div className="oauth-grid">{children}</div>
      {emptyMessage && <div className="prov-accounts-empty muted text-control">{emptyMessage}</div>}
      <button type="button" className="prov-account-add-tile" onClick={onAdd} aria-label={addLabel}>
        <span className="prov-account-add-icon"><IconPlus /></span>
        <span className="prov-account-add-copy">
          <span className="font-semibold">{addLabel}</span>
          <span className="muted text-label">{addDescription}</span>
        </span>
      </button>
    </section>
  );
}
