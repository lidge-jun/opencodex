import { useCallback, useEffect, useState } from "react";
import { useT } from "../i18n";
import CodexAccountPool from "../components/CodexAccountPool";
import { codexAccountModeState, type CodexAccountModeState } from "../codex-multi-state";
import { ensureOpenAiProvider } from "../provider-payload";

export function OpenAiAccountModeBanner({
  state,
  busy,
  onEnable,
}: {
  state: CodexAccountModeState | null;
  busy: boolean;
  onEnable: () => void;
}) {
  const t = useT();
  return (
    <div className="panel" style={{ marginBottom: 16 }}>
      <div className="row">
        <strong>{t("codexAuth.accountModeTitle")}</strong>
        {state === "pool" && <span className="badge badge-accent">{t("codexAuth.accountModePool")}</span>}
        {state === "direct" && <span className="badge badge-green">{t("codexAuth.accountModeDirect")}</span>}
      </div>
      {state === "pool" && (
        <p className="card-sub" style={{ margin: "6px 0 0" }}>{t("codexAuth.accountModePoolDesc")}</p>
      )}
      {state === "direct" && (
        <p className="card-sub" style={{ margin: "6px 0 0" }}>
          {t("codexAuth.accountModeDirectDesc")} <a href="#providers">{t("codexAuth.openProviders")}</a>
        </p>
      )}
      {(state === "absent" || state === "disabled") && (
        <div className="row" style={{ alignItems: "center", marginTop: 8 }}>
          <p className="card-sub" style={{ flex: 1, margin: 0 }}>{t("codexAuth.openaiUnavailableDesc")}</p>
          <button className="btn btn-primary btn-sm" disabled={busy} onClick={onEnable}>
            {busy ? t("codexAuth.enablingOpenai") : t("codexAuth.enableOpenai")}
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * Codex Auth page — a thin wrapper around CodexAccountPool (WP060 extraction).
 * The page owns the /api/config fetch feeding the account-mode banner and
 * passes the mode down so the pool renders mode-aware copy.
 */
export default function CodexAuth({ apiBase }: { apiBase: string }) {
  const t = useT();
  const [accountModeState, setAccountModeState] = useState<CodexAccountModeState | null>(null);
  const [enableBusy, setEnableBusy] = useState(false);
  const [enableError, setEnableError] = useState("");

  const loadMode = useCallback(async () => {
    try {
      const config = await fetch(`${apiBase}/api/config`).then(r => r.json());
      setAccountModeState(codexAccountModeState(config));
    } catch { /* banner degrades to no badge */ }
  }, [apiBase]);

  useEffect(() => {
    const timeout = window.setTimeout(() => { void loadMode(); }, 0);
    const iv = window.setInterval(() => { void loadMode(); }, 30_000);
    return () => { window.clearTimeout(timeout); window.clearInterval(iv); };
  }, [loadMode]);

  const enableOpenAi = async () => {
    setEnableBusy(true);
    setEnableError("");
    try {
      if (accountModeState !== "absent" && accountModeState !== "disabled") return;
      await ensureOpenAiProvider(apiBase, accountModeState);
      await loadMode();
    } catch (error) {
      setEnableError(error instanceof Error ? error.message : t("prov.saveFailed"));
    } finally {
      setEnableBusy(false);
    }
  };

  const banner = <>
    <OpenAiAccountModeBanner
      state={accountModeState}
      busy={enableBusy}
      onEnable={() => { void enableOpenAi(); }}
    />
    {enableError && <div className="notice notice-err" role="alert">{enableError}</div>}
  </>;

  return <CodexAccountPool apiBase={apiBase} accountModeState={accountModeState} banner={banner} />;
}
