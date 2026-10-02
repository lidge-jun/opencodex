import { useEffect, useRef, useState } from "react";
import { EmptyState } from "../ui";
import { IconClaude, IconLock } from "../icons";
import { useT } from "../i18n/shared";
import { LoginHint } from "../components/login-url-block";
import { useAddProviderOAuth } from "../components/use-add-provider-oauth";
import type { ScopedProviderLogin } from "./Providers";

/**
 * Claude Account tab before Anthropic exists. The button starts the same login the Add
 * provider dialog's "Anthropic (Claude)" row starts (the terms warning included). The
 * provider is saved only once that login completes, so until then this slot is the only
 * place the authorization URL and the paste-code field can appear.
 */
export default function ClaudeAccountEmpty({ apiBase, provider, login }: { apiBase: string; provider: string; login: ScopedProviderLogin }) {
  const t = useT();
  const aliveRef = useRef(true);
  useEffect(() => {
    aliveRef.current = true;
    return () => { aliveRef.current = false; };
  }, []);
  const { submitManualCode } = useAddProviderOAuth({ apiBase, t, aliveRef, onAdded: () => {} });
  const [code, setCode] = useState("");
  const [codeBusy, setCodeBusy] = useState(false);
  const [codeMessage, setCodeMessage] = useState("");
  const [codeOk, setCodeOk] = useState(false);
  return (
    <EmptyState className="claude-account-empty" icon={<IconClaude className="claude-account-empty-icon" aria-hidden="true" />} title={t("claude.accountEmptyTitle")}>
      <p>{t("claude.accountEmpty")}</p>
      <div className="claude-account-empty-actions">
        <button type="button" className="btn btn-primary" disabled={login.busy} onClick={login.onSignIn}>
          {login.busy ? <span className="pwi-spin-inline" aria-hidden="true" /> : <IconLock aria-hidden="true" />}
          {login.busy ? t("prov.waitingBrowser") : t("claude.addAnthropic")}
        </button>
        {login.busy && <button type="button" className="btn btn-ghost" onClick={login.onCancel}>{t("common.cancel")}</button>}
      </div>
      {login.busy && login.hint && (
        <div className="claude-account-empty-hint">
          <LoginHint
            hint={{ url: login.hint.url, deviceCode: login.hint.deviceCode, instructions: login.hint.instructions, browserLaunch: login.hint.browserLaunch }}
            paste={{
              value: code,
              busy: codeBusy,
              message: codeMessage,
              ok: codeOk,
              onChange: setCode,
              onSubmit: () => {
                void submitManualCode(provider, code, codeBusy, {
                  setManualCodeBusy: setCodeBusy,
                  setManualCode: setCode,
                  setManualCodeOk: setCodeOk,
                  setManualCodeMsg: setCodeMessage,
                });
              },
            }}
          />
        </div>
      )}
    </EmptyState>
  );
}
