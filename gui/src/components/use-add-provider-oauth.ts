import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
import type { TFn } from "../i18n/shared";
import { readJsonIfOk } from "../fetch-json";
import { openBrowserRequestField } from "../oauth-open-browser-pref";
import { afterOAuthCancellation, cancelOAuthLogin } from "../oauth-cancellation-barrier";
import type { LoginHintData } from "./login-url-block";
import { parseBrowserLaunch, type BrowserLaunch } from "../oauth-browser-launch";
import { loginPollAttempts } from "../oauth-login-budget";
import { isApiTargetCaptureCurrent, targetFetch, type ApiTargetCapture } from "../api";
import { useRenderTargetCapture } from "../use-render-target-capture";

export const OAUTH_LOGIN_POLL_INTERVAL_MS = 2_000;

type OAuthLoginSetters = {
  setOauthBusy: (v: boolean) => void;
  setOauthMsg: (v: string) => void;
  setOauthMsgTone: (v: "ok" | "warn") => void;
  setOauthUrl: (url: string, providerId: string, deviceCode?: string, instructions?: string, browserLaunch?: BrowserLaunch) => void;
  setManualCode: (v: string) => void;
  setManualCodeMsg: (v: string) => void;
  setManualCodeOk: (v: boolean) => void;
};

export function useAddProviderOAuth({
  apiBase,
  targetKey,
  t,
  aliveRef,
  onAdded,
}: {
  apiBase: string;
  targetKey?: string;
  t: TFn;
  aliveRef: React.MutableRefObject<boolean>;
  onAdded: (name: string) => void;
}) {
  const loginGenerationRef = useRef(new Map<string, number>());
  // The hook's render owns the target for a login started from this surface.
  const renderCapture = useRenderTargetCapture(apiBase, targetKey);
  const activeProvidersRef = useRef(new Map<string, OAuthLoginSetters>());
  const activeCapturesRef = useRef(new Map<string, ApiTargetCapture>());
  const targetKeyRef = useRef(targetKey);
  useLayoutEffect(() => { targetKeyRef.current = targetKey; }, [targetKey]);
  useEffect(() => {
    const active = [...activeProvidersRef.current];
    const captures = [...activeCapturesRef.current];
    activeProvidersRef.current.clear();
    activeCapturesRef.current.clear();
    loginGenerationRef.current.clear();
    // The old target's busy spinner and device URL must not survive under the new label.
    // A login started on the new target registers after this reset.
    for (const [providerId, setters] of active) {
      setters.setOauthBusy(false);
      setters.setOauthUrl("", providerId);
      setters.setOauthMsg("");
    }
    // Cancel each abandoned login on the target it started against.
    for (const [providerId, capture] of captures) void cancelOAuthLogin(capture, providerId);
  }, [targetKey]);

  const bumpLoginGeneration = useCallback((providerId: string) => {
    const generation = (loginGenerationRef.current.get(providerId) ?? 0) + 1;
    loginGenerationRef.current.set(providerId, generation);
    return generation;
  }, []);

  /**
   * Cancel a login on the target it started against. A missing capture fails closed:
   * falling back to the live target would send an old login's cancel to the new server.
   */
  const cancelServerLogin = useCallback((capture: ApiTargetCapture, providerId: string) =>
    cancelOAuthLogin(capture, providerId), []);

  useEffect(() => {
    const cancelActiveLogins = (clearUi: boolean) => {
      const providers = [...activeProvidersRef.current];
      const captures = new Map(activeCapturesRef.current);
      activeProvidersRef.current.clear();
      activeCapturesRef.current.clear();
      for (const [providerId, setters] of providers) {
        bumpLoginGeneration(providerId);
        if (clearUi) {
          setters.setOauthBusy(false);
          setters.setOauthUrl("", providerId);
          setters.setOauthMsg("");
        }
        const capture = captures.get(providerId);
        if (capture) void cancelServerLogin(capture, providerId);
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
    const capture = activeCapturesRef.current.get(providerId);
    activeProvidersRef.current.delete(providerId);
    activeCapturesRef.current.delete(providerId);
    if (capture) await cancelServerLogin(capture, providerId);
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
    // A per-login clone keeps the render target while letting the capture map tell an
    // older login's cleanup from its replacement.
    const capture = { ...renderCapture };
    activeCapturesRef.current.set(providerId, capture);
    const { setOauthBusy, setOauthMsg, setOauthMsgTone, setOauthUrl, setManualCode, setManualCodeMsg, setManualCodeOk } = setters;
    const generation = bumpLoginGeneration(providerId);
    const isCurrent = () => loginGenerationRef.current.get(providerId) === generation
      && (targetKey === undefined || targetKeyRef.current === targetKey)
      && isApiTargetCaptureCurrent(capture);
    // Only the login that still owns the surface may remove its setters; an older login's
    // completion must not erase the replacement that superseded it.
    const releaseSetters = () => {
      if (activeProvidersRef.current.get(providerId) === setters) activeProvidersRef.current.delete(providerId);
    };
    activeProvidersRef.current.set(providerId, setters);
    setOauthBusy(true);
    setOauthMsg("");
    setOauthMsgTone("ok");
    setOauthUrl("", providerId);
    setManualCode("");
    setManualCodeMsg("");
    setManualCodeOk(true);
    try {
      const res = await afterOAuthCancellation(capture, providerId, () => {
        if (!aliveRef.current || !isCurrent()) return;
        return targetFetch(capture, `${apiBase}/api/oauth/login`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ provider: providerId, ...openBrowserRequestField() }),
        });
      });
      if (!res || !aliveRef.current || !isCurrent()) return;
      if (!res.ok) {
        releaseSetters();
        const data = await res.json().catch(() => ({})) as { error?: string };
        if (!aliveRef.current || !isCurrent()) return;
        setOauthMsgTone("warn");
        setOauthMsg(data.error === "target_changed"
          ? t("prov.targetChanged")
          : data.error === "unknown oauth provider"
            ? t("modal.oauthComingSoonShort")
            : (data.error || t("modal.loginFailStart")));
        return;
      }
      // A device flow may return a user code with no URL, and `instructions` may
      // carry the only human-readable step. Keep all three: the hint renderer
      // decides what to show, rather than this hook deciding what to discard.
      const data = await res.json() as { url?: string; instructions?: string; deviceCode?: string; error?: string; browserLaunch?: unknown };
      if (!aliveRef.current || !isCurrent()) return;
      setOauthUrl(data.url ?? "", providerId, data.deviceCode, data.instructions, parseBrowserLaunch(data.browserLaunch));
      if (data.url || data.deviceCode) setOauthMsg(t("modal.waitingLogin"));
      else setOauthMsg(data.instructions || t("modal.loggingIn"));
      // A device grant outlives the browser budget; see oauth-login-budget.ts.
      let deviceFlow = Boolean(data.deviceCode);
      for (let i = 0; i < loginPollAttempts(deviceFlow, OAUTH_LOGIN_POLL_INTERVAL_MS, 100); i++) {
        await new Promise(r => setTimeout(r, OAUTH_LOGIN_POLL_INTERVAL_MS));
        if (!aliveRef.current || !isCurrent()) return;
        const sRes = await targetFetch(capture, `${apiBase}/api/oauth/status?provider=${providerId}`).catch(() => null);
        const s = sRes ? await readJsonIfOk<{ loggedIn?: boolean; error?: string; hint?: LoginHintData }>(sRes) : null;
        if (!aliveRef.current || !isCurrent()) return;
        if (s?.error) {
          releaseSetters();
          setOauthMsgTone("warn");
          setOauthMsg(s.error === "target_changed"
            ? t("prov.targetChanged")
            : t("modal.loginError", { error: s.error }));
          return;
        }
        if (s?.loggedIn) {
          releaseSetters();
          setOauthMsg("");
          onAdded(providerId);
          return;
        }
        const hint = s?.hint;
        if (hint) {
          if (hint.deviceCode) deviceFlow = true;
          setOauthUrl(hint.url ?? "", providerId, hint.deviceCode, hint.instructions);
          setOauthMsg(hint.url || hint.deviceCode
            ? t("modal.waitingLogin")
            : (hint.instructions || t("modal.loggingIn")));
        }
      }
      await cancelServerLogin(capture, providerId);
      if (!aliveRef.current || !isCurrent()) return;
      releaseSetters();
      setOauthMsgTone("warn");
      setOauthMsg(t("modal.loginTimeout"));
    } catch {
      if (isCurrent()) await cancelServerLogin(capture, providerId);
      if (isCurrent()) releaseSetters();
      if (aliveRef.current && isCurrent()) {
        setOauthMsgTone("warn");
        setOauthMsg(t("modal.networkError"));
      }
    } finally {
      if (activeCapturesRef.current.get(providerId) === capture) activeCapturesRef.current.delete(providerId);
      if (aliveRef.current && isCurrent()) {
        setOauthBusy(false);
        setOauthUrl("", providerId);
      }
    }
  }, [aliveRef, apiBase, bumpLoginGeneration, cancelServerLogin, onAdded, renderCapture, t, targetKey]);

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
    // The code belongs to the login that produced the device URL. Without its capture the
    // flow is gone (target changed or it ended), so refuse instead of posting to the live
    // target — a stale code must never reach another server.
    const capture = activeCapturesRef.current.get(providerId);
    if (!capture) {
      setManualCodeBusy(false);
      setManualCodeOk(false);
      setManualCodeMsg(t("prov.targetChanged"));
      return;
    }
    try {
      const res = await targetFetch(capture, `${apiBase}/api/oauth/login/code`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: providerId, input }),
      });
      if (!aliveRef.current) return;
      if (!isApiTargetCaptureCurrent(capture)) {
        setManualCodeOk(false);
        setManualCodeMsg(t("prov.targetChanged"));
        return;
      }
      if (!res.ok) {
        const data = await res.json().catch(() => ({})) as { error?: string };
        setManualCodeOk(false);
        setManualCodeMsg(data.error === "target_changed"
          ? t("prov.targetChanged")
          : t("prov.pasteFail", { error: data.error || res.statusText }));
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
