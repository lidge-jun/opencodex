import { useT } from "../i18n/shared";

export function ResponsesReasoningReplayControl({ checked, onChange }: {
  checked: boolean; onChange: (checked: boolean) => void;
}) {
  const t = useT();
  return (
    <label className="pwi-settings-field" style={{ flexDirection: "row", alignItems: "flex-start", gap: 8 }}>
      <input name="preserveResponsesReasoningContent" type="checkbox" checked={checked} onChange={event => onChange(event.target.checked)} />
      <span>
        <span className="pwi-settings-label">{t("pws.responsesReasoningReplay")}</span>
        <span className="muted text-label" style={{ display: "block", marginTop: 2 }}>{t("pws.responsesReasoningReplayHint")}</span>
      </span>
    </label>
  );
}
