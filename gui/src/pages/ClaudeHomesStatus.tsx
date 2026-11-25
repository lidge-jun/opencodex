import { useCallback } from "react";
import { useDataSurface } from "../data-surface";
import { useT, type TKey } from "../i18n/shared";
import { loadConnections, type ConnectionObserved, type ConnectionView } from "./integrations/connections-api";

const OBSERVED_KEYS: Record<ConnectionObserved, TKey> = {
  proxy: "connections.state.proxy",
  native: "connections.state.native",
  "remote-home": "connections.state.remote-home",
  foreign: "connections.state.foreign",
  missing: "connections.state.missing",
  unknown: "connections.state.unknown",
};

/**
 * Per-home first-party status (catch-up 010, G-002): the default Claude home the switch acts on
 * and every home registered in `claudeCode.extraConfigDirs`, read from the shared Connections
 * projection. Renders nothing until that read succeeds; the switch does not depend on it.
 */
export default function ClaudeHomesStatus({ apiBase }: { apiBase: string }) {
  const t = useT();
  const load = useCallback((signal: AbortSignal) => loadConnections(apiBase, signal), [apiBase]);
  const resource = useDataSurface<ConnectionView[]>(`connections-view:${apiBase}`, [apiBase], load, { isEmpty: rows => rows.length === 0 });
  const homes = (resource.state.data ?? []).filter(view => view.client === "claude-code");
  if (homes.length === 0) return null;
  return (
    <div className="setting-row claude-homes-status" data-claude-homes>
      <div className="setting-label">
        <span className="title">{t("connections.homesTitle")}</span>
        <span className="desc">{t("connections.homesHint")}</span>
        <ul className="connection-restore-list">
          {homes.map(view => (
            <li key={view.home ?? view.configPath} data-claude-home={view.homeSource}>
              <code>{view.home}</code>{" "}
              <span className="badge badge-muted">{view.homeSource === "extra"
                ? t("connections.homeExtra", { n: String(view.homeOrdinal ?? "") })
                : t("connections.homeDefault")}</span>{" "}
              <span className={view.driftReasons.length > 0 ? "badge badge-amber" : "badge badge-green"} data-claude-home-observed={view.observed}>
                {t(OBSERVED_KEYS[view.observed])}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
