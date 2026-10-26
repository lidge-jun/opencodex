import { useCallback, useState } from "react";
import { useT } from "../../i18n/shared";
import { useDataSurface } from "../../data-surface";
import { Notice } from "../../ui";
import IntegrationStateBadge from "./IntegrationStateBadge";
import FileIntegrationPage from "./FileIntegrationPage";
import { loadHermesProfiles } from "./hermes-profile-api";

/**
 * Hermes keeps one config.yaml per profile (#7674). With only the default
 * profile this page is the plain Hermes page; with named profiles it adds a
 * picker, and the controls below act on the selected profile alone.
 */
export default function HermesProfilesPage({ apiBase, active = true }: { apiBase: string; active?: boolean }) {
  const t = useT();
  const [chosen, setSelected] = useState("default");
  const fetchProfiles = useCallback((signal: AbortSignal) => loadHermesProfiles(apiBase, signal), [apiBase]);
  const resource = useDataSurface(`hermes-profiles:${apiBase}`, [apiBase], fetchProfiles, {
    enabled: active,
    isEmpty: rows => rows.length === 0,
    sessionCacheKey: `ocx.integrations.hermes-profiles.v1:${apiBase}`,
  });
  const profiles = resource.state.data ?? [];
  // Only a listed profile can be selected; one deleted elsewhere falls back to the default profile.
  const selected = profiles.some(row => row.hermesProfile === chosen) ? chosen : "default";
  const label = (name: string) => name === "default" ? t("integrations.hermes.defaultProfile") : name;
  const named = selected === "default" ? undefined : selected;

  return (
    <section className="integration-client-page">
      {profiles.length > 1 && (
        <>
          <h3>{t("integrations.hermes.profilesTitle")}</h3>
          <p className="page-sub">{t("integrations.hermes.profilesHint")}</p>
          <ul className="aside-profile-list hermes-profile-list">
            {profiles.map(profile => (
              <li className="aside-profile-row" key={profile.hermesProfile}>
                <div className="aside-profile-info">
                  <button
                    type="button"
                    className="btn btn-ghost aside-profile-name"
                    aria-pressed={profile.hermesProfile === selected}
                    aria-label={t("integrations.hermes.select", { name: label(profile.hermesProfile) })}
                    onClick={() => setSelected(profile.hermesProfile)}
                  >
                    {label(profile.hermesProfile)}
                  </button>
                  <div className="aside-profile-meta"><code>{profile.configPath}</code></div>
                  {profile.error && <span className="text-caption muted">{profile.error}</span>}
                </div>
                <div className="aside-profile-controls">
                  <IntegrationStateBadge state={profile.state} installed={profile.installed}
                    id={`hermes-profile-state-${profile.hermesProfile}`} />
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
      {resource.state.showError && (
        <Notice tone="err">
          <span>{t("integrations.hermes.loadError")}</span>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => void resource.refresh()} disabled={resource.state.refreshing}>
            {t("common.retry")}
          </button>
        </Notice>
      )}
      <FileIntegrationPage
        apiBase={apiBase}
        client="hermes"
        active={active}
        hermesProfile={named}
        profileLabel={named === undefined ? undefined : t("integrations.hermes.profileTitle", { name: named })}
        onRefresh={() => void resource.refresh()}
      />
    </section>
  );
}
