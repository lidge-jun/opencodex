import { useT } from "../i18n";

export interface CodexAccountPickerSettingProps {
  enabled: boolean | null;
  saving: boolean;
  feedback: { tone: "ok" | "err"; message: string } | null;
  onToggle(): void;
}

export function CodexAccountPickerSetting({
  enabled,
  saving,
  feedback,
  onToggle,
}: CodexAccountPickerSettingProps) {
  const t = useT();
  if (enabled === null) return null;

  return (
    <div style={{ borderTop: "1px solid var(--border)", marginTop: 12, paddingTop: 12 }}>
      <div className="row" style={{ justifyContent: "space-between", gap: 12 }}>
        <div>
          <strong>{t("codexAuth.namespacesTitle")}</strong>
          <p className="card-sub" style={{ margin: "6px 0 0" }}>
            {t(enabled ? "codexAuth.namespacesOnDesc" : "codexAuth.namespacesOffDesc")}
          </p>
          {enabled && (
            <p className="card-sub faint" style={{ margin: "6px 0 0" }}>
              {t("codexAuth.namespacesCompatibilityNote")}
            </p>
          )}
        </div>
        <button
          type="button"
          className={`toggle ${enabled ? "on" : ""}`}
          disabled={saving}
          aria-pressed={enabled}
          aria-label={t("codexAuth.namespacesTitle")}
          onClick={onToggle}
        >
          <span className="toggle-knob" />
        </button>
      </div>
      {feedback && (
        <p
          className="card-sub"
          role={feedback.tone === "err" ? "alert" : "status"}
          style={{ margin: "6px 0 0", color: feedback.tone === "err" ? "var(--red)" : "var(--green)" }}
        >
          {feedback.message}
        </p>
      )}
    </div>
  );
}

export default CodexAccountPickerSetting;
