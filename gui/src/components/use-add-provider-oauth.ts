import { useCallback } from "react";
import type { TFn } from "../i18n/shared";
import { readJsonIfOk } from "../fetch-json";

export const OAUTH_LOGIN_POLL_INTERVAL_MS = 2_000;

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
  const loginOAuth = useCallback(async (
    providerId: string,
    setters: {
      setOauthBusy: (v: boolean) => void;
      setOauthMsg: (v: string) => void;
      setOauthMsgTone: (v: "ok" | "warn") => void;
      setOauthUrl: (url: string, providerId: string) => void;
      setManualCode: (v: string) => void;
      setManualCodeMsg: (v: string) => void;
      setManualCodeOk: (v: boolean) => void;
    },
  ) => {
    const { setOauthBusy, setOauthMsg, setOauthMsgTone, setOauthUrl, setManualCode, setManualCodeMsg, setManualCodeOk } = setters;
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
        body: JSON.stringify({ provider: providerId }),
      });
      if (!aliveRef.current) return;
      if (!res.ok) {
        const data = await res.json().catch(() => ({})) as { error?: string };
        setOauthMsgTone("warn");
        setOauthMsg(data.error === "unknown oauth provider"
          ? t("modal.oauthComingSoonShort")
          : (data.error || t("modal.loginFailStart")));
        return;
      }
      const data = await res.json() as { url?: string; instructions?: string; error?: string };
      if (data.url) { setOauthUrl(data.url, providerId); setOauthMsg(t("modal.waitingLogin")); }
      else { setOauthMsg(data.instructions || t("modal.loggingIn")); }
      for (let i = 0; i < 100; i++) {
        await new Promise(r => setTimeout(r, OAUTH_LOGIN_POLL_INTERVAL_MS));
        if (!aliveRef.current) return;
        const sRes = await fetch(`${apiBase}/api/oauth/status?provider=${providerId}`).catch(() => null);
        const s = sRes ? await readJsonIfOk<{ loggedIn?: boolean; error?: string }>(sRes) : null;
        if (!aliveRef.current) return;
        if (s?.error) {
          setOauthMsgTone("warn");
          setOauthMsg(t("modal.loginError", { error: s.error }));
          return;
        }
        if (s?.loggedIn) { onAdded(providerId); return; }
      }
      setOauthMsgTone("warn");
      setOauthMsg(t("modal.loginTimeout"));
    } catch {
      if (aliveRef.current) {
        setOauthMsgTone("warn");
        setOauthMsg(t("modal.networkError"));
      }
    } finally {
      if (aliveRef.current) setOauthBusy(false);
    }
  }, [aliveRef, apiBase, onAdded, t]);

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

  return { loginOAuth, submitManualCode };
}
