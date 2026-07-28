import { useCallback } from "react";
import type { TFn } from "../i18n/shared";
import { readJsonIfOk, readJsonOrThrow } from "../fetch-json";
import type { OAuthStatus, ProviderQuotaReport, ProvidersConfig } from "./providers-shared";

export function useProvidersFetch({
  apiBase,
  t,
  setConfig,
  setOauthProviders,
  setOauthStatus,
  setQuotaReports,
  notify,
}: {
  apiBase: string;
  t: TFn;
  setConfig: React.Dispatch<React.SetStateAction<ProvidersConfig | null>>;
  setOauthProviders: React.Dispatch<React.SetStateAction<string[]>>;
  setOauthStatus: React.Dispatch<React.SetStateAction<Record<string, OAuthStatus>>>;
  setQuotaReports: React.Dispatch<React.SetStateAction<Record<string, ProviderQuotaReport>>>;
  notify: (msg: string, ok: boolean) => void;
}) {
  const fetchConfig = useCallback(async () => {
    try {
      const res = await fetch(`${apiBase}/api/config`);
      const data = await readJsonOrThrow<ProvidersConfig>(res);
      setConfig(data ?? null);
    } catch {
      notify(t("prov.loadConfigFail"), false);
    }
  }, [apiBase, notify, setConfig, t]);

  const fetchOauth = useCallback(async () => {
    try {
      // Kick oauth provider list and Codex account probes in parallel — accounts do
      // not depend on the oauth/providers response, so a serial await was pure latency.
      const [provRes, codexAccounts, codexActive] = await Promise.all([
        fetch(`${apiBase}/api/oauth/providers`),
        fetch(`${apiBase}/api/codex-auth/accounts`)
          .then(r => readJsonIfOk<{ accounts?: Array<{ id?: string; email?: string; isMain?: boolean; hasCredential?: boolean; needsReauth?: boolean }> }>(r))
          .catch(() => null),
        fetch(`${apiBase}/api/codex-auth/active`)
          .then(r => readJsonIfOk<{ activeCodexAccountId?: string | null }>(r))
          .catch(() => null),
      ]);
      const provData = await readJsonOrThrow<{ providers?: string[] }>(provRes);
      const provs: string[] = provData?.providers ?? [];
      setOauthProviders(provs);
      const oauthEntries = await Promise.all(provs.map(async p => {
        const sRes = await fetch(`${apiBase}/api/oauth/status?provider=${p}`).catch(() => null);
        const s = sRes ? (await readJsonIfOk<OAuthStatus>(sRes) ?? { loggedIn: false }) : { loggedIn: false };
        return [p, s] as const;
      }));
      const next: Record<string, OAuthStatus> = Object.fromEntries(oauthEntries);
      const accounts = codexAccounts?.accounts ?? [];
      const main = accounts.find(a => a.isMain) ?? accounts[0];
      const mainIsReal = !!main && !!main.email && main.email !== "Codex App login";
      const poolLoggedIn = accounts.some(a => !a.isMain && (a.hasCredential || a.email));
      const codexLoggedIn = mainIsReal || poolLoggedIn;
      const codexEmail = mainIsReal ? main.email : (accounts.find(a => !a.isMain && a.email)?.email ?? undefined);
      const activeId = codexActive?.activeCodexAccountId ?? null;
      const activePoolAccount = activeId && activeId !== "__main__"
        ? accounts.find(a => a.id === activeId)
        : null;
      const codexNeedsReauth = activePoolAccount
        ? Boolean(activePoolAccount.needsReauth)
        : Boolean(main?.needsReauth);
      next.openai = {
        loggedIn: codexLoggedIn,
        email: codexEmail,
        ...(codexNeedsReauth ? { needsReauth: true } : {}),
      };
      setOauthStatus(next);
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
