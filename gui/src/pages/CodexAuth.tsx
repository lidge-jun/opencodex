import { useCallback, useEffect, useState } from "react";
import { useT } from "../i18n";
import CodexAccountPool from "../components/CodexAccountPool";
import { codexAccountModeState, type CodexAccountModeState } from "../codex-multi-state";

/**
 * Codex Auth page — a thin wrapper around CodexAccountPool (WP060 extraction).
 * The page owns the /api/config fetch feeding the account-mode banner and
 * passes the mode down so the pool renders mode-aware copy.
 */
export default function CodexAuth({ apiBase }: { apiBase: string }) {
  const t = useT();
  const [accountModeState, setAccountModeState] = useState<CodexAccountModeState | null>(null);

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

  const banner = (
    <div className="panel" style={{ marginBottom: 16 }}>
      <div className="row">
        <strong>{t("codexAuth.accountModeTitle")}</strong>
        {accountModeState === "pool" && <span className="badge badge-accent">{t("codexAuth.accountModePool")}</span>}
        {accountModeState === "direct" && <span className="badge badge-green">{t("codexAuth.accountModeDirect")}</span>}
      </div>
      {accountModeState === "pool" && (
        <p className="card-sub" style={{ margin: "6px 0 0" }}>{t("codexAuth.accountModePoolDesc")}</p>
      )}
      {accountModeState === "direct" && (
        <p className="card-sub" style={{ margin: "6px 0 0" }}>
          {t("codexAuth.accountModeDirectDesc")} <a href="#providers">{t("codexAuth.openProviders")}</a>
        </p>
      )}
      {accountModeState === "absent" && (
        <p className="card-sub" style={{ margin: "8px 0 0" }}>
          {t("codexAuth.openaiMissing")} <a href="#providers">{t("codexAuth.openProviders")}</a>
        </p>
      )}
      {accountModeState === "disabled" && (
        <p className="card-sub" style={{ margin: "8px 0 0" }}>
          {t("codexAuth.openaiDisabled")} <a href="#providers">{t("codexAuth.openProviders")}</a>
        </p>
      )}
    </div>
  );

  return <CodexAccountPool apiBase={apiBase} accountModeState={accountModeState} banner={banner} />;
}
