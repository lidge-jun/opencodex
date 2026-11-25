import { useCallback } from "react";
import { useDataSurface } from "../../data-surface";
import { useT, type TKey } from "../../i18n/shared";
import { Notice } from "../../ui";
import {
  loadConnections,
  type ConnectionDriftReason,
  type ConnectionKeyChange,
  type ConnectionObserved,
  type ConnectionOwner,
  type ConnectionView,
  type ConnectionDesired,
} from "./connections-api";

const CLIENT_LABEL: Record<ConnectionView["client"], TKey> = {
  codex: "integrations.tab.codex",
  "claude-code": "claude.pageTitle",
  "claude-desktop": "claudeDesktop.title",
};

const STATE_KEYS: Record<ConnectionDesired | ConnectionObserved, TKey> = {
  proxy: "connections.state.proxy",
  native: "connections.state.native",
  "remote-home": "connections.state.remote-home",
  unset: "connections.state.unset",
  foreign: "connections.state.foreign",
  missing: "connections.state.missing",
  unknown: "connections.state.unknown",
};

const OWNER_KEYS: Record<ConnectionOwner, TKey> = {
  opencodex: "connections.owner.opencodex",
  external: "connections.owner.external",
  hub: "connections.owner.hub",
  none: "connections.owner.none",
  unknown: "connections.owner.unknown",
};

const REASON_KEYS: Record<ConnectionDriftReason, TKey> = {
  external_owner: "connections.reason.external_owner",
  account_mode: "connections.reason.account_mode",
  hub_gated: "connections.reason.hub_gated",
  intercept_disabled: "connections.reason.intercept_disabled",
  file_edited: "connections.reason.file_edited",
  pending_restart: "connections.reason.pending_restart",
};

const CHANGE_KEYS: Record<ConnectionKeyChange["change"], TKey> = {
  add: "connections.change.add",
  update: "connections.change.update",
  remove: "connections.change.remove",
};

function stateClass(desired: ConnectionDesired, observed: ConnectionObserved): string {
  if (observed === "unknown") return "badge badge-muted";
  const matches = (desired === observed) || (desired === "unset");
  return matches ? "badge badge-green" : "badge badge-amber";
}

/** Masked keys can repeat (two user tables become `projects.….trust_level`); show each once with a count. */
function groupedChanges(changes: readonly ConnectionKeyChange[]): Array<ConnectionKeyChange & { id: string; count: number }> {
  const groups = new Map<string, ConnectionKeyChange & { id: string; count: number }>();
  for (const change of changes) {
    const id = `${change.file}:${change.key}:${change.change}`;
    const existing = groups.get(id);
    if (existing) existing.count += 1;
    else groups.set(id, { ...change, id, count: 1 });
  }
  return [...groups.values()];
}

function ConnectionCard({ view }: { view: ConnectionView }) {
  const t = useT();
  const drift = view.driftReasons.length > 0;
  const preview = view.restorePreview;
  return (
    <li className="integration-card" data-client={view.client} data-tone={drift ? "attention" : "on"} data-connection-home={view.homeSource}>
      <div className="integration-card-head">
        <h4>{t(CLIENT_LABEL[view.client])}</h4>
        {view.homeSource && (
          <span className="badge badge-muted">{view.homeSource === "default"
            ? t("connections.homeDefault")
            : t("connections.homeExtra", { n: String(view.homeOrdinal ?? "") })}</span>
        )}
      </div>
      {view.home && <p className="integration-path"><code>{view.home}</code></p>}
      <p className="integration-meta">
        {t("connections.desired")} <span className="badge badge-muted">{t(STATE_KEYS[view.desired])}</span>
        {" · "}
        {t("connections.observed")} <span className={stateClass(view.desired, view.observed)} data-connection-observed={view.observed}>{t(STATE_KEYS[view.observed])}</span>
        {" · "}
        {t("connections.owner")} <span className="badge badge-muted" data-connection-owner={view.owner}>{t(OWNER_KEYS[view.owner])}</span>
      </p>
      <p className="integration-path"><code>{view.configPath}</code></p>
      {view.driftReasons.map(reason => (
        <Notice key={reason} tone="warn">
          <span data-connection-reason={reason}>{t(REASON_KEYS[reason])}</span>
          {reason === "external_owner" && view.ownerPath && (
            <> <code data-connection-owner-path>{t("connections.ownerPath", { path: view.ownerPath })}</code></>
          )}
        </Notice>
      ))}
      {preview && (
        <details className="connection-restore-preview">
          <summary>{t("connections.restoreTitle")}</summary>
          {preview.outcome !== "restore" && (
            <p className="integration-meta" data-connection-restore-outcome={preview.outcome}>
              {t("connections.outcome.refused", { reason: preview.outcome })}
            </p>
          )}
          {preview.outcome === "restore" && preview.changes.length === 0 && (
            <p className="integration-meta">{t("connections.restoreNone")}</p>
          )}
          {preview.changes.length > 0 && (
            <ul className="connection-restore-list">
              {groupedChanges(preview.changes).map(change => (
                <li key={change.id} data-change={change.change}>
                  <code>{change.file}</code> <code>{change.key}</code> <span className="chip">{t(CHANGE_KEYS[change.change])}</span>
                  {change.count > 1 && <> <span className="chip">×{change.count}</span></>}
                </li>
              ))}
            </ul>
          )}
        </details>
      )}
    </li>
  );
}

/**
 * The read-only Connections panel (catch-up 010, G-001): one card per client and Claude home,
 * read once per visit and on Refresh — no timer, the projection reads several files.
 */
export default function ConnectionsPanel({ apiBase, active = true }: { apiBase: string; active?: boolean }) {
  const t = useT();
  const load = useCallback((signal: AbortSignal) => loadConnections(apiBase, signal), [apiBase]);
  const resource = useDataSurface<ConnectionView[]>(
    `connections-view:${apiBase}`,
    [apiBase],
    load,
    { isEmpty: rows => rows.length === 0, enabled: active },
  );
  const rows = resource.state.data;
  return (
    <section className="connections-panel" aria-labelledby="connections-panel-title">
      <div className="connect-catalog-head">
        <h3 id="connections-panel-title">{t("connections.title")}</h3>
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => resource.refresh({ forceLoading: true })}>
          {t("connections.refresh")}
        </button>
      </div>
      <p className="page-sub">{t("connections.intro")}</p>
      {resource.state.showError && <Notice tone="err">{t("connections.loadFail")}</Notice>}
      {!rows && !resource.state.showError && <p className="page-sub">{t("connections.loading")}</p>}
      {rows && (
        <ul className="integration-cards">
          {rows.map(view => <ConnectionCard key={`${view.client}:${view.home ?? ""}`} view={view} />)}
        </ul>
      )}
    </section>
  );
}
