import { useCallback, useEffect, useRef, useState } from "react";
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
  const [namespacesEnabled, setNamespacesEnabled] = useState<boolean | null>(null);
  const [pickerMode, setPickerMode] = useState<"additive" | "replace-native" | null>(null);
  const [namespaceCount, setNamespaceCount] = useState(0);
  const [namespaceSaving, setNamespaceSaving] = useState(false);
  const [namespaceFeedback, setNamespaceFeedback] = useState<{ tone: "ok" | "err"; message: string } | null>(null);
  const [pickerSaving, setPickerSaving] = useState(false);
  const [pickerFeedback, setPickerFeedback] = useState<{ tone: "ok" | "err"; message: string } | null>(null);
  const pickerMutationInFlightRef = useRef(false);

  const loadMode = useCallback(async () => {
    try {
      const config = await fetch(`${apiBase}/api/config`).then(r => r.json()) as {
        codexAccountNamespacesEnabled?: boolean;
        codexAccountNamespaceCount?: number;
        codexAccountNamespacePickerMode?: "additive" | "replace-native";
      };
      setAccountModeState(codexAccountModeState(config));
      if (!pickerMutationInFlightRef.current) {
        setNamespacesEnabled(config.codexAccountNamespacesEnabled === true);
        setNamespaceCount(config.codexAccountNamespaceCount ?? 0);
        setPickerMode(config.codexAccountNamespacePickerMode ?? "additive");
      }
    } catch { /* banner degrades to no badge */ }
  }, [apiBase]);

  useEffect(() => {
    const timeout = window.setTimeout(() => { void loadMode(); }, 0);
    const iv = window.setInterval(() => { void loadMode(); }, 30_000);
    return () => { window.clearTimeout(timeout); window.clearInterval(iv); };
  }, [loadMode]);

  const saveNamespacesEnabled = async (next: boolean) => {
    if (namespaceSaving || namespacesEnabled === null || namespacesEnabled === next) return;
    const previousEnabled = namespacesEnabled;
    const previousCount = namespaceCount;
    const previousPickerMode = pickerMode;
    pickerMutationInFlightRef.current = true;
    setNamespaceSaving(true);
    setNamespacesEnabled(next);
    setNamespaceFeedback(null);
    try {
      const response = await fetch(`${apiBase}/api/settings`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ codexAccountNamespacesEnabled: next }),
      });
      const result = await response.json().catch(() => ({})) as {
        error?: string;
        codexAccountNamespacesEnabled?: boolean;
        codexAccountNamespaceCount?: number;
        codexAccountNamespacePickerMode?: "additive" | "replace-native";
      };
      if (!response.ok) throw new Error(result.error ?? "save failed");
      setNamespacesEnabled(result.codexAccountNamespacesEnabled === true);
      setNamespaceCount(result.codexAccountNamespaceCount ?? 0);
      setPickerMode(result.codexAccountNamespacePickerMode ?? "additive");
      setNamespaceFeedback({ tone: "ok", message: t("codexAuth.namespacesSaved") });
    } catch {
      setNamespacesEnabled(previousEnabled);
      setNamespaceCount(previousCount);
      setPickerMode(previousPickerMode);
      setNamespaceFeedback({ tone: "err", message: t("codexAuth.namespacesSaveFailed") });
    } finally {
      pickerMutationInFlightRef.current = false;
      setNamespaceSaving(false);
    }
  };

  const savePickerMode = async (next: "additive" | "replace-native") => {
    if (pickerSaving || pickerMode === next) return;
    const previous = pickerMode;
    pickerMutationInFlightRef.current = true;
    setPickerSaving(true);
    setPickerMode(next);
    setPickerFeedback(null);
    try {
      const response = await fetch(`${apiBase}/api/settings`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ codexAccountNamespacePickerMode: next }),
      });
      const result = await response.json().catch(() => ({})) as {
        error?: string;
        codexAccountNamespacePickerMode?: "additive" | "replace-native";
      };
      if (!response.ok) throw new Error(result.error ?? "save failed");
      setPickerMode(result.codexAccountNamespacePickerMode ?? next);
      setPickerFeedback({ tone: "ok", message: t("codexAuth.pickerModeSaved") });
    } catch {
      setPickerMode(previous);
      setPickerFeedback({ tone: "err", message: t("codexAuth.pickerModeSaveFailed") });
    } finally {
      pickerMutationInFlightRef.current = false;
      setPickerSaving(false);
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
      {namespacesEnabled !== null && (
      <div style={{ borderTop: "1px solid var(--border)", marginTop: 12, paddingTop: 12 }}>
        <div className="row" style={{ justifyContent: "space-between", gap: 12 }}>
          <div>
            <strong>{t("codexAuth.namespacesTitle")}</strong>
            <p className="card-sub" style={{ margin: "6px 0 0" }}>
              {t(namespacesEnabled ? "codexAuth.namespacesOnDesc" : "codexAuth.namespacesOffDesc")}
            </p>
          </div>
          <button
            type="button"
            className={`toggle ${namespacesEnabled ? "on" : ""}`}
            disabled={namespaceSaving}
            aria-pressed={namespacesEnabled}
            aria-label={t("codexAuth.namespacesTitle")}
            onClick={() => void saveNamespacesEnabled(!namespacesEnabled)}
          >
            <span className="toggle-knob" />
          </button>
        </div>
        {namespaceFeedback && (
          <p
            className="card-sub"
            role={namespaceFeedback.tone === "err" ? "alert" : "status"}
            style={{ margin: "6px 0 0", color: namespaceFeedback.tone === "err" ? "var(--red)" : "var(--green)" }}
          >
            {namespaceFeedback.message}
          </p>
        )}
      </div>
      )}
      {namespacesEnabled && namespaceCount > 0 && pickerMode && (
        <div style={{ borderTop: "1px solid var(--border)", marginTop: 12, paddingTop: 12 }}>
          <div className="row" style={{ justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
            <strong>{t("codexAuth.pickerModeTitle")}</strong>
            <div className="usage-segmented" role="radiogroup" aria-label={t("codexAuth.pickerModeTitle")}>
              {(["additive", "replace-native"] as const).map(mode => (
                <button
                  key={mode}
                  type="button"
                  role="radio"
                  aria-checked={pickerMode === mode}
                  className={`usage-segmented-btn${pickerMode === mode ? " active" : ""}`}
                  disabled={pickerSaving}
                  onClick={() => void savePickerMode(mode)}
                >
                  {t(mode === "additive" ? "codexAuth.pickerModeAdditive" : "codexAuth.pickerModeReplace")}
                </button>
              ))}
            </div>
          </div>
          <p className="card-sub" style={{ margin: "6px 0 0" }}>
            {t(pickerMode === "replace-native" ? "codexAuth.pickerModeReplaceDesc" : "codexAuth.pickerModeAdditiveDesc")}
          </p>
          {pickerFeedback && (
            <p
              className="card-sub"
              role={pickerFeedback.tone === "err" ? "alert" : "status"}
              style={{ margin: "6px 0 0", color: pickerFeedback.tone === "err" ? "var(--red)" : "var(--green)" }}
            >
              {pickerFeedback.message}
            </p>
          )}
        </div>
      )}
    </div>
  );

  return <CodexAccountPool apiBase={apiBase} accountModeState={accountModeState} banner={banner} />;
}
