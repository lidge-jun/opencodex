import { useCallback, useEffect, useRef, useState } from "react";
import { useT } from "../i18n";
import CodexAccountPool from "../components/CodexAccountPool";
import CodexAccountPickerSetting from "../components/CodexAccountPickerSetting";
import { codexAccountModeState, type CodexAccountModeState } from "../codex-multi-state";

/**
 * Codex Auth page — a thin wrapper around CodexAccountPool (WP060 extraction).
 * The page owns the /api/config fetch feeding the account-mode banner and
 * passes the mode down so the pool renders mode-aware copy.
 */
export default function CodexAuth({ apiBase }: { apiBase: string }) {
  const t = useT();
  const [accountModeState, setAccountModeState] = useState<CodexAccountModeState | null>(null);
  const [namespacesEnabled, setNamespacesEnabled] = useState<boolean | null>(null);
  const [namespaceSaving, setNamespaceSaving] = useState(false);
  const [namespaceFeedback, setNamespaceFeedback] = useState<{ tone: "ok" | "err"; message: string } | null>(null);
  const namespaceMutationInFlightRef = useRef(false);

  const loadMode = useCallback(async () => {
    try {
      const response = await fetch(`${apiBase}/api/config`);
      if (!response.ok) throw new Error("failed to load config");
      const config = await response.json() as {
        codexAccountPickerEnabled?: boolean;
      };
      setAccountModeState(codexAccountModeState(config));
      if (!namespaceMutationInFlightRef.current) {
        setNamespacesEnabled(config.codexAccountPickerEnabled === true);
      }
    } catch { /* banner degrades to no badge */ }
  }, [apiBase]);

  useEffect(() => {
    const timeout = window.setTimeout(() => { void loadMode(); }, 0);
    const iv = window.setInterval(() => { void loadMode(); }, 30_000);
    return () => { window.clearTimeout(timeout); window.clearInterval(iv); };
  }, [loadMode]);

  const saveNamespacesEnabled = async (next: boolean) => {
    if (namespaceMutationInFlightRef.current || namespaceSaving
      || namespacesEnabled === null || namespacesEnabled === next) return;
    const previousEnabled = namespacesEnabled;
    namespaceMutationInFlightRef.current = true;
    setNamespaceSaving(true);
    setNamespacesEnabled(next);
    setNamespaceFeedback(null);
    try {
      const response = await fetch(`${apiBase}/api/settings`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ codexAccountPickerEnabled: next }),
      });
      const result = await response.json().catch(() => ({})) as {
        error?: string;
        codexAccountPickerEnabled?: boolean;
      };
      if (!response.ok) throw new Error(result.error ?? "save failed");
      setNamespacesEnabled(result.codexAccountPickerEnabled === true);
      setNamespaceFeedback({ tone: "ok", message: t("codexAuth.namespacesSaved") });
    } catch {
      setNamespacesEnabled(previousEnabled);
      setNamespaceFeedback({ tone: "err", message: t("codexAuth.namespacesSaveFailed") });
    } finally {
      namespaceMutationInFlightRef.current = false;
      setNamespaceSaving(false);
    }
  };

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
      <CodexAccountPickerSetting
        enabled={namespacesEnabled}
        saving={namespaceSaving}
        feedback={namespaceFeedback}
        onToggle={() => {
          if (namespacesEnabled !== null) void saveNamespacesEnabled(!namespacesEnabled);
        }}
      />
    </div>
  );

  return <CodexAccountPool apiBase={apiBase} accountModeState={accountModeState} banner={banner} />;
}
