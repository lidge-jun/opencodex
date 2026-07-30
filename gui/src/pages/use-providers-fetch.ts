import { useCallback } from "react";
import type { TFn } from "../i18n/shared";
import { readJsonIfOk, readJsonOrThrow } from "../fetch-json";
import { writeSessionListCache } from "../session-list-cache";
import type { OAuthStatus, ProviderQuotaReport, ProvidersConfig } from "./providers-shared";

export function useProvidersFetch({
  apiBase,
  t,
  setConfig,
  setOauthProviders,
  setOauthStatus,
  setQuotaReports,
  notify,
  configCacheKey,
}: {
  apiBase: string;
  t: TFn;
  setConfig: React.Dispatch<React.SetStateAction<ProvidersConfig | null>>;
  setOauthProviders: React.Dispatch<React.SetStateAction<string[]>>;
  setOauthStatus: React.Dispatch<React.SetStateAction<Record<string, OAuthStatus>>>;
  setQuotaReports: React.Dispatch<React.SetStateAction<Record<string, ProviderQuotaReport>>>;
  notify: (msg: string, ok: boolean) => void;
  /** Session seed key for instant Providers shell paint (no secrets — hasApiKey flags only). */
  configCacheKey?: string;
}) {
  const fetchConfig = useCallback(async () => {
    try {
      const res = await fetch(`${apiBase}/api/config`);
      const data = await readJsonOrThrow<ProvidersConfig>(res);
      setConfig(data ?? null);
      if (configCacheKey && data) writeSessionListCache(configCacheKey, data);
    } catch {
      notify(t("prov.loadConfigFail"), false);
    }
  }, [apiBase, configCacheKey, notify, setConfig, t]);

  const fetchOauth = useCallback(async () => {
    try {
      // Codex openai status is owned by useCodexAccountPool — do not duplicate /accounts.
      const provRes = await fetch(`${apiBase}/api/oauth/providers`);
      const provData = await readJsonOrThrow<{ providers?: string[] }>(provRes);
      const provs: string[] = provData?.providers ?? [];
      setOauthProviders(provs);
      const oauthEntries = await Promise.all(provs.map(async p => {
        const sRes = await fetch(`${apiBase}/api/oauth/status?provider=${encodeURIComponent(p)}`).catch(() => null);
        const s = sRes ? (await readJsonIfOk<OAuthStatus>(sRes) ?? { loggedIn: false }) : { loggedIn: false };
        return [p, s] as const;
      }));
      setOauthStatus(Object.fromEntries(oauthEntries));
    } catch { /* ignore */ }
  }, [apiBase, setOauthProviders, setOauthStatus]);

  const fetchProviderQuotas = useCallback(async (refresh = false) => {
    try {
      const res = await fetch(`${apiBase}/api/provider-quotas${refresh ? "?refresh=1" : ""}`);
      const data = await readJsonIfOk<{ reports?: ProviderQuotaReport[] }>(res);
      if (!data) return;
      setQuotaReports(prev => {
        const next = { ...prev };
        for (const report of data.reports ?? []) {
          if (report?.provider) next[report.provider] = report;
        }
        return next;
      });
    } catch { /* keep last-good */ }
  }, [apiBase, setQuotaReports]);

  return { fetchConfig, fetchOauth, fetchProviderQuotas };
}
