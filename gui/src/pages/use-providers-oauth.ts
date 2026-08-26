import { useCallback, useRef } from "react";
import type { TFn } from "../i18n/shared";
import { readJsonIfOk } from "../fetch-json";
import { openBrowserRequestField } from "../oauth-open-browser-pref";
import type { OAuthAccount, OAuthStatus } from "./providers-shared";
import { oauthLabel } from "./providers-shared";

type AccountSet = { activeAccountId: string | null; accounts: OAuthAccount[] };

export function useProvidersOAuth({
  apiBase,
  t,
  aliveRef,
  accountSets,
  setAccountSets,
  setBusy,
  setStatus,
  setLoginInfo,
  setOauthStatus,
  notify,
  fetchConfig,
  fetchOauth,
  fetchAccountSets,
  fetchProviderQuotas,
  bumpModelsRefresh,
  onLoginSettled,
}: {
  apiBase: string;
  t: TFn;
  aliveRef: React.MutableRefObject<boolean>;
  accountSets: Record<string, AccountSet>;
  setAccountSets: React.Dispatch<React.SetStateAction<Record<string, AccountSet>>>;
  setBusy: React.Dispatch<React.SetStateAction<string | null>>;
  setStatus: React.Dispatch<React.SetStateAction<string>>;
  setLoginInfo: React.Dispatch<React.SetStateAction<{ provider: string; url?: string; instructions?: string; deviceCode?: string } | null>>;
  setOauthStatus: React.Dispatch<React.SetStateAction<Record<string, OAuthStatus>>>;
  notify: (msg: string, ok: boolean) => void;
  fetchConfig: () => Promise<void>;
  fetchOauth: () => Promise<void>;
  fetchAccountSets: (providers: string[]) => Promise<unknown>;
  fetchProviderQuotas: (refresh?: boolean) => Promise<void>;
  bumpModelsRefresh: () => void;
  /** Select the provider and open Accounts after a successful login. */
  onLoginSettled?: (provider: string) => void;
}) {
  const oauthLoginGenerationRef = useRef<Map<string, number> | null>(null);
  if (oauthLoginGenerationRef.current === null) oauthLoginGenerationRef.current = new Map();

  const bumpLoginGeneration = useCallback((provider: string) => {
    const gen = (oauthLoginGenerationRef.current!.get(provider) ?? 0) + 1;
    oauthLoginGenerationRef.current!.set(provider, gen);
    return gen;
  }, []);

  const cancelLoginOAuth = useCallback(async (provider: string) => {
    const gen = bumpLoginGeneration(provider);
    try {
      await fetch(`${apiBase}/api/oauth/login/cancel`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider }),
      });
    } catch { /* ignore */ }
    if (!aliveRef.current) return;
    if (oauthLoginGenerationRef.current!.get(provider) === gen) {
      setBusy(current => current === provider ? null : current);
      setLoginInfo(current => current?.provider === provider ? null : current);
    }
    notify(t("prov.loginCancelled", { provider: oauthLabel(provider) }), false);
  }, [aliveRef, apiBase, bumpLoginGeneration, notify, setBusy, setLoginInfo, t]);

  const loginOAuth = async (provider: string, addAccount = false, accountId?: string) => {
    const generation = bumpLoginGeneration(provider);
    const reauthTargetId = accountId?.trim() || undefined;
    setBusy(provider);
    setStatus("");
    setLoginInfo(null);
    try {
      const res = await fetch(`${apiBase}/api/oauth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider,
          // Explicit, never inferred, and omitted entirely when this operator has
          // expressed no preference — otherwise the request would permanently
          // overrule a persisted `oauthOpenBrowser: false`.
          ...openBrowserRequestField(),
          ...(addAccount || reauthTargetId ? { addAccount: true } : {}),
          ...(reauthTargetId ? { accountId: reauthTargetId, reauth: true } : {}),
        }),
      });
      if (oauthLoginGenerationRef.current!.get(provider) !== generation || !aliveRef.current) return;
      if (!res.ok) {
        const data = await res.json().catch(() => ({})) as { error?: string };
        notify(data.error || t("prov.loginFailStart", { provider: oauthLabel(provider) }), false);
        return;
      }
      const data = await res.json() as { url?: string; instructions?: string; deviceCode?: string };
      if (data.url || data.instructions || data.deviceCode) {
        setLoginInfo({ provider, url: data.url, instructions: data.instructions, deviceCode: data.deviceCode });
      }
      const baselineCount = accountSets[provider]?.accounts.length ?? 0;
      let finished = false;
      for (let i = 0; i < 150 && aliveRef.current && oauthLoginGenerationRef.current!.get(provider) === generation; i++) {
        await new Promise(r => setTimeout(r, 2000));
        if (oauthLoginGenerationRef.current!.get(provider) !== generation || !aliveRef.current) return;
        const sRes = await fetch(`${apiBase}/api/oauth/status?provider=${provider}`).catch(() => null);
        const s: (OAuthStatus & { accounts?: OAuthAccount[]; activeAccountId?: string | null }) | null = sRes
          ? ((await readJsonIfOk<OAuthStatus & { accounts?: OAuthAccount[]; activeAccountId?: string | null }>(sRes)) ?? null)
          : null;
        if (!s) continue;
        if (s.error) {
          setOauthStatus(prev => ({ ...prev, [provider]: s }));
          const cancelled = /cancel/i.test(s.error);
          notify(
            cancelled
              ? t("prov.loginCancelled", { provider: oauthLabel(provider) })
              : t("prov.loginError", { provider: oauthLabel(provider), error: s.error }),
            false,
          );
          setLoginInfo(null);
          finished = true;
          break;
        }
        const statusCount = s.accounts?.length ?? 0;
        const completed = addAccount || reauthTargetId
          ? (statusCount > baselineCount || s.done === true)
          : (s.loggedIn || s.done === true);
        if (completed) {
          setOauthStatus(prev => ({ ...prev, [provider]: s }));
          const target = reauthTargetId
            ? s.accounts?.find(a => a.id === reauthTargetId)
            : s.accounts?.find(a => a.active) ?? s.accounts?.find(a => a.id === s.activeAccountId);
          if (reauthTargetId && !target) {
            notify(t("prov.loginError", { provider: oauthLabel(provider), error: t("prov.reauthAccountMissing") }), false);
            setLoginInfo(null);
            finished = true;
            break;
          }
          if (target?.needsReauth) {
            notify(t("prov.loginError", { provider: oauthLabel(provider), error: t("prov.reauthIdentityMismatch") }), false);
            setLoginInfo(null);
            finished = true;
            break;
          }
          // Seed the account list from the status poll immediately so Accounts does not
          // briefly render empty while the follow-up /api/oauth/accounts round-trip runs.
          if (s.accounts) {
            const activeFromRow = s.accounts.find(a => a.active)?.id ?? null;
            setAccountSets(current => ({
              ...current,
              [provider]: {
                activeAccountId: s.activeAccountId ?? activeFromRow,
                accounts: s.accounts!,
              },
            }));
          }
          setLoginInfo(null);
          onLoginSettled?.(provider);
          const knownProviders = Object.keys(accountSets);
          const knownSet = new Set(knownProviders);
          await fetchAccountSets(knownSet.has(provider) ? knownProviders : [...knownProviders, provider]);
          if (!aliveRef.current || oauthLoginGenerationRef.current!.get(provider) !== generation) return;
          const sameIdentityAdd = addAccount && !reauthTargetId && statusCount <= baselineCount;
          if (sameIdentityAdd) {
            notify(t("prov.loginSameAccount", { provider: oauthLabel(provider) }), false);
          } else {
            notify(t("prov.loginOk", { provider: oauthLabel(provider), cmd: "ocx sync" }), true);
          }
          void fetchConfig();
          void fetchProviderQuotas(true);
          bumpModelsRefresh();
          finished = true;
          break;
        }
      }
      if (!finished && oauthLoginGenerationRef.current!.get(provider) === generation && aliveRef.current) {
        await fetch(`${apiBase}/api/oauth/login/cancel`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ provider }),
        }).catch(() => {});
        notify(t("prov.loginTimeout", { provider: oauthLabel(provider) }), false);
        setLoginInfo(null);
      }
    } catch {
      if (oauthLoginGenerationRef.current!.get(provider) === generation) {
        notify(t("prov.loginRequestFail", { provider: oauthLabel(provider) }), false);
      }
    } finally {
      if (aliveRef.current && oauthLoginGenerationRef.current!.get(provider) === generation) setBusy(null);
    }
  };

  const logoutOAuth = async (provider: string) => {
    // Invalidate any in-flight login poll so a late completion cannot reseed accounts.
    bumpLoginGeneration(provider);
    setBusy(current => current === provider ? null : current);
    setLoginInfo(current => current?.provider === provider ? null : current);
    try {
      const res = await fetch(`${apiBase}/api/oauth/logout?provider=${encodeURIComponent(provider)}`, { method: "POST" });
      if (!res.ok) {
        notify(t("prov.logoutFail", { provider: oauthLabel(provider) }), false);
        return;
      }
      await Promise.all([
        fetchAccountSets([provider]),
        fetchOauth(),
        fetchConfig(),
        fetchProviderQuotas(true),
      ]);
      bumpModelsRefresh();
      notify(t("prov.logoutOk", { provider: oauthLabel(provider) }), true);
    } catch {
      notify(t("prov.logoutFail", { provider: oauthLabel(provider) }), false);
    }
  };

  return { cancelLoginOAuth, loginOAuth, logoutOAuth };
}
