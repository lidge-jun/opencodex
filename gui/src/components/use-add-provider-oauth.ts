import { useCallback, useEffect, useRef } from "react";
import type { TFn } from "../i18n/shared";
import { readJsonIfOk } from "../fetch-json";
import { openBrowserRequestField } from "../oauth-open-browser-pref";

export const OAUTH_LOGIN_POLL_INTERVAL_MS = 2_000;

type OAuthLoginSetters = {
  setOauthBusy: (v: boolean) => void;
  setOauthMsg: (v: string) => void;
  setOauthMsgTone: (v: "ok" | "warn") => void;
  setOauthUrl: (url: string, providerId: string, deviceCode?: string, instructions?: string) => void;
  setManualCode: (v: string) => void;
  setManualCodeMsg: (v: string) => void;
  setManualCodeOk: (v: boolean) => void;
};

export function useAddProviderOAuth({
  apiBase,
  t,
  aliveRef,
  onAdded,
}: {
  apiBase: string;
  t: TFn;
  aliveRef: React.MutableRefObject<boolean>;
  onAdded: (name: string) => void;
}) {
  const loginGenerationRef = useRef(new Map<string, number>());
  const activeProvidersRef = useRef(new Map<string, OAuthLoginSetters>());

  const bumpLoginGeneration = useCallback((providerId: string) => {
    const generation = (loginGenerationRef.current.get(providerId) ?? 0) + 1;
    loginGenerationRef.current.set(providerId, generation);
    return generation;
  }, []);

  const cancelServerLogin = useCallback(async (providerId: string) => {
    await fetch(`${apiBase}/api/oauth/login/cancel`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: providerId }),
      keepalive: true,
    }).catch(() => undefined);
  }, [apiBase]);

  useEffect(() => {
    const cancelActiveLogins = (clearUi: boolean) => {
      const providers = [...activeProvidersRef.current];
      activeProvidersRef.current.clear();
      for (const [providerId, setters] of providers) {
        bumpLoginGeneration(providerId);
        if (clearUi) {
          setters.setOauthBusy(false);
          setters.setOauthUrl("", providerId);
          setters.setOauthMsg("");
        }
        void cancelServerLogin(providerId);
      }
    };
    const onPageHide = () => cancelActiveLogins(true);
    window.addEventListener("pagehide", onPageHide);
    return () => {
      window.removeEventListener("pagehide", onPageHide);
      cancelActiveLogins(false);
    };
  }, [bumpLoginGeneration, cancelServerLogin]);

  const cancelLoginOAuth = useCallback(async (
    providerId: string,
    setters: OAuthLoginSetters,
    providerLabel = providerId,
  ) => {
    const generation = bumpLoginGeneration(providerId);
    activeProvidersRef.current.delete(providerId);
    await cancelServerLogin(providerId);
    if (!aliveRef.current || loginGenerationRef.current.get(providerId) !== generation) return;
    setters.setOauthBusy(false);
    setters.setOauthUrl("", providerId);
    setters.setOauthMsgTone("warn");
    setters.setOauthMsg(t("prov.loginCancelled", { provider: providerLabel }));
  }, [aliveRef, bumpLoginGeneration, cancelServerLogin, t]);

  const loginOAuth = useCallback(async (
    providerId: string,
    setters: OAuthLoginSetters,
  ) => {
    const { setOauthBusy, setOauthMsg, setOauthMsgTone, setOauthUrl, setManualCode, setManualCodeMsg, setManualCodeOk } = setters;
    const generation = bumpLoginGeneration(providerId);
    const isCurrent = () => loginGenerationRef.current.get(providerId) === generation;
    activeProvidersRef.current.set(providerId, setters);
    setOauthBusy(true);
    setOauthMsg("");
    setOauthMsgTone("ok");
    setOauthUrl("", providerId);
    setManualCode("");
    setManualCodeMsg("");
    setManualCodeOk(true);
    try {
      const res = await fetch(`${apiBase}/api/oauth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: providerId, ...openBrowserRequestField() }),
      });
      if (!aliveRef.current || !isCurrent()) return;
      if (!res.ok) {
        activeProvidersRef.current.delete(providerId);
        const data = await res.json().catch(() => ({})) as { error?: string };
        setOauthMsgTone("warn");
        setOauthMsg(data.error === "unknown oauth provider"
          ? t("modal.oauthComingSoonShort")
          : (data.error || t("modal.loginFailStart")));
        return;
      }
      // A device flow may return a user code with no URL, and `instructions` may
      // carry the only human-readable step. Keep all three: the hint renderer
      // decides what to show, rather than this hook deciding what to discard.
      const data = await res.json() as { url?: string; instructions?: string; deviceCode?: string; error?: string };
      setOauthUrl(data.url ?? "", providerId, data.deviceCode, data.instructions);
      if (data.url || data.deviceCode) setOauthMsg(t("modal.waitingLogin"));
      else setOauthMsg(data.instructions || t("modal.loggingIn"));
      for (let i = 0; i < 100; i++) {
        await new Promise(r => setTimeout(r, OAUTH_LOGIN_POLL_INTERVAL_MS));
        if (!aliveRef.current || !isCurrent()) return;
        const sRes = await fetch(`${apiBase}/api/oauth/status?provider=${providerId}`).catch(() => null);
        const s = sRes ? await readJsonIfOk<{ loggedIn?: boolean; error?: string }>(sRes) : null;
        if (!aliveRef.current || !isCurrent()) return;
        if (s?.error) {
          activeProvidersRef.current.delete(providerId);
          setOauthMsgTone("warn");
          setOauthMsg(t("modal.loginError", { error: s.error }));
          return;
        }
        if (s?.loggedIn) {
          activeProvidersRef.current.delete(providerId);
          onAdded(providerId);
          return;
        }
      }
      await cancelServerLogin(providerId);
      if (!aliveRef.current || !isCurrent()) return;
      activeProvidersRef.current.delete(providerId);
      setOauthMsgTone("warn");
      setOauthMsg(t("modal.loginTimeout"));
    } catch {
      if (isCurrent()) await cancelServerLogin(providerId);
      activeProvidersRef.current.delete(providerId);
      if (aliveRef.current && isCurrent()) {
        setOauthMsgTone("warn");
        setOauthMsg(t("modal.networkError"));
      }
    } finally {
      if (aliveRef.current && isCurrent()) setOauthBusy(false);
    }
  }, [aliveRef, apiBase, bumpLoginGeneration, cancelServerLogin, onAdded, t]);

  const submitManualCode = useCallback(async (
    providerId: string,
    manualCode: string,
    manualCodeBusy: boolean,
    setters: {
      setManualCodeBusy: (v: boolean) => void;
      setManualCode: (v: string) => void;
      setManualCodeOk: (v: boolean) => void;
      setManualCodeMsg: (v: string) => void;
    },
  ) => {
    const input = manualCode.trim();
    if (!input || manualCodeBusy) return;
    const { setManualCodeBusy, setManualCode, setManualCodeOk, setManualCodeMsg } = setters;
    setManualCodeBusy(true);
    setManualCodeMsg("");
    try {
      const res = await fetch(`${apiBase}/api/oauth/login/code`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: providerId, input }),
      });
      if (!aliveRef.current) return;
      if (!res.ok) {
        const data = await res.json().catch(() => ({})) as { error?: string };
        setManualCodeOk(false);
        setManualCodeMsg(t("prov.pasteFail", { error: data.error || res.statusText }));
        return;
      }
      setManualCode("");
      setManualCodeOk(true);
      setManualCodeMsg(t("prov.pasteOk"));
    } catch {
      if (aliveRef.current) {
        setManualCodeOk(false);
        setManualCodeMsg(t("modal.networkError"));
      }
    } finally {
      if (aliveRef.current) setManualCodeBusy(false);
    }
  }, [aliveRef, apiBase, t]);

  return { cancelLoginOAuth, loginOAuth, submitManualCode };
}
