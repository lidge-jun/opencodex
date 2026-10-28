import { useT } from "../i18n/shared";
import { IconInfo } from "../icons";
import { Select, Switch, Tooltip, type SelectOption } from "../ui";
import { SettingsRow } from "./models-settings-panel";
import { shadowBackgroundModelBadge, shadowSourceModelLabel } from "./shadow-call-source";
import { ShadowCallSourceToggles } from "./shadow-call-source-toggles";
import type { ShadowCallData } from "./models-shared";

/** The Models workspace's shadow-call row, including the source toggles. */
export function ShadowCallSettingsRow({
  shadowCall,
  saving,
  modelOptions,
  onSave,
}: {
  shadowCall: ShadowCallData | null;
  saving: boolean;
  modelOptions: SelectOption[];
  onSave: (patch: Partial<ShadowCallData>) => void;
}) {
  const t = useT();
  const hint = t("models.shadowCallInterceptHint", {
    models: shadowSourceModelLabel(shadowCall?.sourceModels),
  });
  return (
    <>
      <SettingsRow
        label={t("models.shadowCallIntercept")}
        hint={<Tooltip content={hint} side="top" maxWidth={320}><span style={{ cursor: "help" }} aria-label={hint}><IconInfo width={13} height={13} aria-hidden="true" /></span></Tooltip>}
        busy={!shadowCall}
      >
        <code className="text-caption models-shadow-warning" style={{ opacity: 0.6 }}>
          {t("models.shadowCallOriginal", {
            models: shadowBackgroundModelBadge(shadowCall?.sourceModels, t("shadowCall.memoryLabel")),
          })}
        </code>
        <Switch
          on={shadowCall?.enabled ?? false}
          onClick={() => onSave({ enabled: !shadowCall?.enabled })}
          disabled={!shadowCall || saving}
          label={t("models.shadowCallIntercept")}
        />
        <div className="models-shadow-model-slot">
          <Select
            value={shadowCall?.model ?? ""}
            options={modelOptions}
            onChange={model => onSave({ model })}
            disabled={!shadowCall || saving || !shadowCall.enabled}
            label={t("models.shadowCallIntercept")}
          />
        </div>
      </SettingsRow>
      <ShadowCallSourceToggles
        className="models-shadow-sources"
        options={shadowCall?.sourceModelOptions}
        sourceModels={shadowCall?.sourceModels}
        disabled={!shadowCall?.enabled}
        saving={saving}
        onChange={sourceModels => onSave({ sourceModels })}
      />
    </>
  );
}
