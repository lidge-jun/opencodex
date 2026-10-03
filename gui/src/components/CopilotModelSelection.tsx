import { useT } from "../i18n/shared";

export type CopilotSelection = "detect" | "auto" | "manual";

/** Shared creation/settings control; the saved mode is a routing preference, not a verified plan. */
export function CopilotModelSelection({ value, onChange, disabled }: {
  value: CopilotSelection;
  onChange: (value: CopilotSelection) => void;
  disabled?: boolean;
}) {
  const t = useT();
  return (
    <label className="pwi-settings-field">
      <span className="pwi-settings-label">{t("pws.copilotSelection")}</span>
      <select className="input" value={value} disabled={disabled} onChange={e => onChange(e.target.value as CopilotSelection)}>
        <option value="detect">{t("pws.copilotSelectionDetect")}</option>
        <option value="auto">{t("pws.copilotSelectionAuto")}</option>
        <option value="manual">{t("pws.copilotSelectionManual")}</option>
      </select>
      <span className="pwi-settings-hint">{t("pws.copilotSelectionHint")}</span>
    </label>
  );
}
