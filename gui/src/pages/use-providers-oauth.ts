import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
import type { TFn } from "../i18n/shared";
import { readJsonIfOk } from "../fetch-json";
import { openBrowserRequestField } from "../oauth-open-browser-pref";
import { afterOAuthCancellation, cancelOAuthLogin } from "../oauth-cancellation-barrier";
import { parseBrowserLaunch, type BrowserLaunch } from "../oauth-browser-launch";
import { loginPollAttempts } from "../oauth-login-budget";
import type { OAuthAccount, OAuthStatus } from "./providers-shared";
import { oauthLabel } from "./providers-shared";
import { isApiTargetCaptureCurrent, targetFetch, type ApiTargetCapture } from "../api";
import { errorMessageFrom } from "../api-error";
import { useRenderTargetCapture } from "../use-render-target-capture";

type AccountSet = { activeAccountId: string | null; accounts: OAuthAccount[] };

export function useProvidersOAuth({
  apiBase,
  targetKey,
  t,
  aliveRef,
  accountSets,
  setAccountSets,
  setBusy,
  setStatus,
  setLoginInfo,
  setOauthStatus,
  invalidateOauthStatusReads,
  captureOauthStatusRead,
  beginAccountLogout,
  notify,
  fetchConfig,
  fetchOauth,
  fetchAccountSets,
  fetchProviderQuotas,
  bumpModelsRefresh,
  onLoginSettled,
}: {
  apiBase: string;
  /** Stable logical target; a relay apiBase can stay the same across a re-pair. */
  targetKey?: string;
  t: TFn;
  aliveRef: React.MutableRefObject<boolean>;
  accountSets: Record<string, AccountSet>;
  setAccountSets: React.Dispatch<React.SetStateAction<Record<string, AccountSet>>>;
  setBusy: React.Dispatch<React.SetStateAction<string | null>>;
  setStatus: React.Dispatch<React.SetStateAction<string>>;
  setLoginInfo: React.Dispatch<React.SetStateAction<{ provider: string; url?: string; instructions?: string; deviceCode?: string; browserLaunch?: BrowserLaunch } | null>>;
  setOauthStatus: React.Dispatch<React.SetStateAction<Record<string, OAuthStatus>>>;
  invalidateOauthStatusReads?: (provider: string, blocked?: boolean) => boolean;
  captureOauthStatusRead?: (provider: string) => () => boolean;
  beginAccountLogout?: (provider: string) => (() => void) | null;
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
  // The hook's render owns the target for login and logout actions.
  const renderCapture = useRenderTargetCapture(apiBase, targetKey);
  const targetKeyRef = useRef(targetKey ?? apiBase);
  useLayoutEffect(() => { targetKeyRef.current = targetKey ?? apiBase; }, [apiBase, targetKey]);
  const activeLoginGenerationsRef = useRef(new Map<string, number>());
  const activeLoginCapturesRef = useRef(new Map<string, ApiTargetCapture>());
  useEffect(() => {
    // The old target's busy state and device URL must not survive under the new label.
    // Cancel each active login on the target it actually started against; the map is the
    // only place that capture survives once the target key changes.
    const active = [...activeLoginCapturesRef.current];
    activeLoginGenerationsRef.current.clear();
    activeLoginCapturesRef.current.clear();
    setBusy(null);
    setLoginInfo(null);
    setStatus("");
    for (const [provider, capture] of active) void cancelOAuthLogin(capture, provider);
  }, [setBusy, setLoginInfo, setStatus, targetKey]);

  const bumpLoginGeneration = useCallback((provider: string) => {
    const gen = (oauthLoginGenerationRef.current!.get(provider) ?? 0) + 1;
    oauthLoginGenerationRef.current!.set(provider, gen);
    return gen;
  }, []);

  /**
   * Cancel a login on the target it started against. A missing capture fails closed:
   * falling back to the live target would send an old login's cancel to the new server.
   */
  const cancelServerLogin = useCallback((capture: ApiTargetCapture, provider: string) =>
    cancelOAuthLogin(capture, provider), []);

  const reloadAccountsAfterLogin = useCallback(async (provider: string) => {
    const knownProviders = Object.keys(accountSets);
    const knownSet = new Set(knownProviders);
    await fetchAccountSets(knownSet.has(provider) ? knownProviders : [...knownProviders, provider]);
  }, [accountSets, fetchAccountSets]);

  const refreshDerivedAfterLogin = useCallback(() => {
    void fetchConfig();
    void fetchProviderQuotas(true);
    bumpModelsRefresh();
  }, [fetchConfig, fetchProviderQuotas, bumpModelsRefresh]);

  const onNativeLoginSettled = useCallback(async (provider: string, outcome: "added" | "ended" | "failed") => {
    if (!aliveRef.current) return;
    if (outcome === "added") onLoginSettled?.(provider);
    try { await reloadAccountsAfterLogin(provider); } catch {
      // A failed roster read must not hide a confirmed device outcome. The
      // account loader owns its own error state; derived reads can still heal it.
    }
    if (!aliveRef.current) return;
    if (outcome === "added") notify(t("prov.loginOk", { provider: oauthLabel(provider), cmd: "ocx sync" }), true);
    else if (outcome === "ended") notify(t("kiroLogin.ended"), false);
    else notify(t("prov.loginError", { provider: oauthLabel(provider), error: t("kiroLogin.failed") }), false);
    refreshDerivedAfterLogin();
  }, [aliveRef, onLoginSettled, reloadAccountsAfterLogin, notify, t, refreshDerivedAfterLogin]);

  useEffect(() => {
    const cancelActiveLogins = (clearUi: boolean) => {
      const active = [...activeLoginGenerationsRef.current];
      activeLoginGenerationsRef.current.clear();
      for (const [provider, generation] of active) {
        const capture = activeLoginCapturesRef.current.get(provider);
        activeLoginCapturesRef.current.delete(provider);
        if (oauthLoginGenerationRef.current!.get(provider) === generation) bumpLoginGeneration(provider);
        if (clearUi) {
          setBusy(current => current === provider ? null : current);
          setLoginInfo(current => current?.provider === provider ? null : current);
        }
        // Fail closed when the capture is gone: never cancel on whatever target is live now.
        if (capture) void cancelServerLogin(capture, provider);
      }
    };
    const onPageHide = () => cancelActiveLogins(true);
    window.addEventListener("pagehide", onPageHide);
    return () => {
      window.removeEventListener("pagehide", onPageHide);
      cancelActiveLogins(false);
    };
  }, [bumpLoginGeneration, cancelServerLogin, setBusy, setLoginInfo]);

  const cancelLoginOAuth = useCallback(async (provider: string) => {
    const gen = bumpLoginGeneration(provider);
    const cancelTarget = targetKey ?? apiBase;
    const capture = activeLoginCapturesRef.current.get(provider);
    activeLoginGenerationsRef.current.delete(provider);
    activeLoginCapturesRef.current.delete(provider);
    // Clear the local UI at the click, even if the captured target has already changed.
    setBusy(current => current === provider ? null : current);
    setLoginInfo(current => current?.provider === provider ? null : current);
    if (capture) await cancelServerLogin(capture, provider);
    if (targetKeyRef.current !== cancelTarget || !aliveRef.current
      || (capture !== undefined && !isApiTargetCaptureCurrent(capture))
      || oauthLoginGenerationRef.current!.get(provider) !== gen) return;
    notify(t("prov.loginCancelled", { provider: oauthLabel(provider) }), false);
  }, [aliveRef, apiBase, bumpLoginGeneration, cancelServerLogin, notify, setBusy, setLoginInfo, t, targetKey]);

  const loginOAuth = async (provider: string, addAccount = false, accountId?: string) => {
    const capture = renderCapture;
    activeLoginCapturesRef.current.set(provider, capture);
    const generation = bumpLoginGeneration(provider);
    const targetId = targetKey ?? apiBase;
    // The key alone cannot tell A from A again after A-B-A; the capture generation does.
    const targetCurrent = () => aliveRef.current && targetKeyRef.current === targetId
      && isApiTargetCaptureCurrent(capture);
    activeLoginGenerationsRef.current.set(provider, generation);
    const reauthTargetId = accountId?.trim() || undefined;
    setBusy(provider);
    setStatus("");
    setLoginInfo(null);
    try {
      const res = await afterOAuthCancellation(capture, provider, () => {
        if (!targetCurrent() || oauthLoginGenerationRef.current!.get(provider) !== generation) return;
        return targetFetch(capture, `${apiBase}/api/oauth/login`, {
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
      });
      if (!res || oauthLoginGenerationRef.current!.get(provider) !== generation || !targetCurrent()) return;
      if (!res.ok) {
        const data = await res.json().catch(() => ({})) as { error?: string };
        if (!targetCurrent() || oauthLoginGenerationRef.current!.get(provider) !== generation) return;
        notify(errorMessageFrom(
          data,
          t("prov.loginFailStart", { provider: oauthLabel(provider) }),
          t("prov.targetChanged"),
        ), false);
        return;
      }
      const data = await res.json() as { url?: string; instructions?: string; deviceCode?: string; browserLaunch?: unknown };
      if (!targetCurrent() || oauthLoginGenerationRef.current!.get(provider) !== generation) return;
      const browserLaunch = parseBrowserLaunch(data.browserLaunch);
      if (data.url || data.instructions || data.deviceCode) {
        setLoginInfo({ provider, url: data.url, instructions: data.instructions, deviceCode: data.deviceCode, browserLaunch });
      }
      const baselineCount = accountSets[provider]?.accounts.length ?? 0;
      let finished = false;
      // A device code can arrive with the POST or with a later status hint; either one stretches
      // the budget to the grant's lifetime (see oauth-login-budget.ts).
      let deviceFlow = Boolean(data.deviceCode);
      for (let i = 0; i < loginPollAttempts(deviceFlow, 2000, 150) && targetCurrent() && oauthLoginGenerationRef.current!.get(provider) === generation; i++) {
        await new Promise(r => setTimeout(r, 2000));
        if (oauthLoginGenerationRef.current!.get(provider) !== generation || !targetCurrent()) return;
        const isCurrentStatusRead = captureOauthStatusRead?.(provider);
        const sRes = await targetFetch(capture, `${apiBase}/api/oauth/status?provider=${provider}`).catch(() => null);
        const s: (OAuthStatus & { accounts?: OAuthAccount[]; activeAccountId?: string | null }) | null = sRes
          ? ((await readJsonIfOk<OAuthStatus & { accounts?: OAuthAccount[]; activeAccountId?: string | null }>(sRes)) ?? null)
          : null;
        if (!targetCurrent() || oauthLoginGenerationRef.current!.get(provider) !== generation) return;
        if (isCurrentStatusRead && !isCurrentStatusRead()) continue;
        if (!s) continue;
        if (s.error) {
          if (invalidateOauthStatusReads?.(provider) === false) return;
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
          if (invalidateOauthStatusReads?.(provider) === false) return;
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
          // Seed only a missing roster. This status read can predate a manual selection;
          // an existing roster is reconciled by the guarded /accounts read below.
          if (s.accounts) {
            const activeFromRow = s.accounts.find(a => a.active)?.id ?? null;
            setAccountSets(current => current[provider] ? current : ({
              ...current,
              [provider]: {
                activeAccountId: s.activeAccountId ?? activeFromRow,
                accounts: s.accounts!,
              },
            }));
          }
          setLoginInfo(null);
          onLoginSettled?.(provider);
          await reloadAccountsAfterLogin(provider);
          if (!targetCurrent() || oauthLoginGenerationRef.current!.get(provider) !== generation) return;
          const sameIdentityAdd = addAccount && !reauthTargetId && statusCount <= baselineCount;
          if (sameIdentityAdd) {
            notify(t("prov.loginSameAccount", { provider: oauthLabel(provider) }), false);
          } else {
            notify(t("prov.loginOk", { provider: oauthLabel(provider), cmd: "ocx sync" }), true);
          }
          refreshDerivedAfterLogin();
          finished = true;
          break;
        }
        // A later provider step replaces the initial POST hint (including an
        // absent device code); generation checks above keep old polls out.
        // The launch outcome belongs to the POST, so a status hint keeps it.
        if (s.hint) {
          if (s.hint.deviceCode) deviceFlow = true;
          setLoginInfo({ provider, url: s.hint.url, instructions: s.hint.instructions, deviceCode: s.hint.deviceCode, browserLaunch });
        }
      }
      if (!finished && oauthLoginGenerationRef.current!.get(provider) === generation && aliveRef.current) {
        // The cancel belongs to the login's own target, never to whatever is live now.
        await cancelServerLogin(capture, provider);
        if (!targetCurrent() || oauthLoginGenerationRef.current!.get(provider) !== generation) return;
        notify(t("prov.loginTimeout", { provider: oauthLabel(provider) }), false);
        setLoginInfo(null);
      }
    } catch {
      if (oauthLoginGenerationRef.current!.get(provider) === generation) {
        await cancelServerLogin(capture, provider);
        if (!targetCurrent() || oauthLoginGenerationRef.current!.get(provider) !== generation) return;
        notify(t("prov.loginRequestFail", { provider: oauthLabel(provider) }), false);
      }
    } finally {
      if (activeLoginGenerationsRef.current.get(provider) === generation) {
        activeLoginGenerationsRef.current.delete(provider);
        activeLoginCapturesRef.current.delete(provider);
      }
      if (targetCurrent() && oauthLoginGenerationRef.current!.get(provider) === generation) setBusy(current => current === provider ? null : current);
    }
  };

  const logoutOAuth = async (provider: string) => {
    const capture = renderCapture;
    const logoutTarget = targetKey ?? apiBase;
    const finishLogout = beginAccountLogout?.(provider);
    if (beginAccountLogout && !finishLogout) {
      if (aliveRef.current) notify(t("prov.logoutBusy"), false);
      return;
    }
    if (invalidateOauthStatusReads?.(provider, true) === false) { finishLogout?.(); return; }
    const clearStatus = () => setOauthStatus(current => {
      if (!(provider in current)) return current;
      const next = { ...current };
      delete next[provider];
      return next;
    });
    clearStatus();
    // Invalidate any in-flight login poll so a late completion cannot reseed accounts.
    bumpLoginGeneration(provider);
    setBusy(current => current === provider ? null : current);
    setLoginInfo(current => current?.provider === provider ? null : current);
    let success = false;
    let failed = false;
    try {
      const res = await targetFetch(capture, `${apiBase}/api/oauth/logout?provider=${encodeURIComponent(provider)}`, { method: "POST" });
      if (res.ok) success = true;
      else failed = true;
    } catch {
      failed = true;
    } finally {
      finishLogout?.();
    }
    // A failure that arrives after the dashboard moved belongs to the old target: no toast,
    // no status clear and no roster read on the new one.
    if (targetKeyRef.current !== logoutTarget || !isApiTargetCaptureCurrent(capture)) return;
    if (failed) notify(t("prov.logoutFail", { provider: oauthLabel(provider) }), false);
    // A read started while the server was processing logout can still describe
    // the old account. Only a read started after settlement can verify status.
    if (invalidateOauthStatusReads?.(provider, false) === false) return;
    clearStatus();
    if (!success) {
      void fetchAccountSets([provider]).catch(() => {});
      void fetchOauth();
      return;
    }
    try {
      await Promise.all([
        fetchAccountSets([provider]), fetchOauth(), fetchConfig(), fetchProviderQuotas(true),
      ]);
      bumpModelsRefresh();
      if (targetKeyRef.current === logoutTarget && isApiTargetCaptureCurrent(capture))
        notify(t("prov.logoutOk", { provider: oauthLabel(provider) }), true);
    } catch {
      if (targetKeyRef.current === logoutTarget && isApiTargetCaptureCurrent(capture))
        notify(t("prov.logoutFail", { provider: oauthLabel(provider) }), false);
    }
  };

  return {
    cancelLoginOAuth, loginOAuth, logoutOAuth, onNativeLoginSettled,
    loginCapture: (provider: string) => activeLoginCapturesRef.current.get(provider),
  };
}
