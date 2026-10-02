import { Notice } from "../ui";
import { useT } from "../i18n/shared";
import { navigateHash } from "../hash-routing";
import { useDataSurface } from "../data-surface";
import { readJsonOrThrow } from "../fetch-json";
import { loadNativeIntegrations } from "./integrations/native-api";

type InterceptStatus = { firstParty?: { interceptEnabled: boolean; interceptRunning: boolean; proxyPort: number } };

/** Value not known yet: the shared skeleton block at badge size, so rows do not jump. */
function Pending() {
  return <span className="data-surface-skeleton__block claude-status-pending" aria-hidden="true" />;
}

/**
 * Read-only status. The Claude connection switch lives on the Code tab only: two switches
 * writing one value read as two settings.
 */
export default function ClaudeSettings({ apiBase, active }: { apiBase: string; active: boolean }) {
  const t = useT();
  const native = useDataSurface(`claude-settings-native:${apiBase}`, [apiBase], async signal => {
    const status = await loadNativeIntegrations(apiBase, signal);
    if (!status) throw new Error("native status unavailable");
    return status.clients.find(client => client.clientId === "claude") ?? null;
  }, { enabled: active, isEmpty: value => value === null });
  const desktop = useDataSurface(`claude-settings-intercept:${apiBase}`, [apiBase], async signal =>
    readJsonOrThrow<InterceptStatus>(await fetch(`${apiBase}/api/claude-desktop/status`, { signal })),
  { enabled: active, isEmpty: () => false, pollMs: 30_000 });
  const connection = native.state.data;
  const firstParty = desktop.state.data?.firstParty;
  const openCode = () => navigateHash("claude/code");
  return (
    <div className="claude-settings">
      {native.state.showError && (
        <Notice tone="err">
          <span>{t("claude.routingLoadFail")}</span>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => native.refresh()}>{t("common.retry")}</button>
        </Notice>
      )}
      {desktop.state.showError && (
        <Notice tone="err">
          <span>{t("claude.interceptLoadFail")}</span>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => desktop.refresh()}>{t("common.retry")}</button>
        </Notice>
      )}
      <div className="card">
        <div className="setting-row">
          <div className="setting-label">
            <span className="title">{t("claude.enabledLabel")}</span>
            <span className="desc">{t("claude.subtitle")}</span>
          </div>
          <div className="setting-controls">
            {connection ? (
              <span className={`badge ${connection.desiredEnabled ? "badge-green" : "badge-muted"}`} data-claude-connection-status>
                {t(connection.desiredEnabled ? "claude.stateOn" : "claude.stateOff")}
              </span>
            ) : <Pending />}
          </div>
        </div>
        <div className="setting-row">
          <div className="setting-label">
            <span className="title">{t("claude.interceptStatus")}</span>
            <span className="desc">{t("claude.interceptDesc")}</span>
          </div>
          <div className="setting-controls">
            {firstParty ? (
              <span className={`badge ${firstParty.interceptRunning ? "badge-green" : "badge-muted"}`}>
                {t(firstParty.interceptRunning ? "claude.interceptRunning" : "claude.interceptStopped")}
              </span>
            ) : <Pending />}
          </div>
        </div>
        <div className="setting-row">
          <div className="setting-label">
            <span className="title">{t("claude.interceptPort")}</span>
            <span className="desc">{t("claude.interceptPortDesc")}</span>
          </div>
          <div className="setting-controls">{firstParty ? <code className="claude-settings-port">{firstParty.proxyPort}</code> : <Pending />}</div>
        </div>
        {/* Follow-up integration slot: ClaudeInterceptStart is supplied by the intercept branch. */}
        <div data-claude-intercept-start-slot />
      </div>
      <div className="card">
        <div className="setting-row">
          <div className="setting-label">
            <span className="desc">{t("claude.settingsHint")}</span>
          </div>
          <div className="setting-controls">
            <button type="button" className="btn btn-ghost btn-sm" onClick={openCode}>{t("claude.changeOnCode", { tab: t("claude.tabCode") })}</button>
          </div>
        </div>
      </div>
    </div>
  );
}
