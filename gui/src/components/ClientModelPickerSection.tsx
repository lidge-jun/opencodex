/**
 * Everything that shapes the model picker Codex and Claude Code show: the pinned roster at the
 * top, the order of the rest, and the Fast rows. The order mode itself is Models page state;
 * this section only renders its controls.
 */
import { useEffect, useId, useRef, useState } from "react";
import { useT, type TKey } from "../i18n/shared";
import { Select } from "../ui";
import { InfoHint } from "../pages/models-settings-panel";
import type { ModelPickerOrderMode, PickerModelIdentity, PickerOrderSaved, PickerOrderSettings } from "../model-picker-order";
import { CLIENT_PICKER_ANCHOR, takeClientPickerJump } from "../pages/client-picker-jump";
import PickerPinnedRoster from "./PickerPinnedRoster";
import ModelPickerOrderEditor from "./ModelPickerOrderEditor";
import FastRowsSetting from "./FastRowsSetting";

const ORDER_MODES: readonly { value: ModelPickerOrderMode; label: TKey }[] = [
  { value: "default", label: "models.pickerOrder.default" },
  { value: "alphabetical", label: "models.pickerOrder.alphabetical" },
  { value: "provider", label: "models.pickerOrder.provider" },
  { value: "most-used", label: "models.pickerOrder.mostUsed" },
  { value: "custom", label: "models.pickerOrder.custom" },
];

interface Props {
  apiBase: string;
  active: boolean;
  identities: readonly PickerModelIdentity[];
  /** Last-read picker settings; undefined until the first read lands. */
  settings: PickerOrderSettings | undefined;
  loadFailed: boolean;
  refreshing: boolean;
  mode: ModelPickerOrderMode;
  busy: boolean;
  onModeChange: (mode: ModelPickerOrderMode) => void;
  onApply: () => void;
  onRetry: () => void;
  onBusyChange: (busy: boolean) => void;
  onAccepted: (receipt: PickerOrderSaved & { catalogRefresh?: unknown }) => void;
  onFastSaved: () => void;
}

export default function ClientModelPickerSection({
  apiBase, active, identities, settings, loadFailed, refreshing, mode, busy,
  onModeChange, onApply, onRetry, onBusyChange, onAccepted, onFastSaved,
}: Props) {
  const t = useT();
  const ref = useRef<HTMLElement>(null);
  const titleId = useId();
  // The custom order editor reads the pinned rows once; a saved roster change remounts it so
  // its fixed rows match the server again.
  const [rosterRevision, setRosterRevision] = useState(0);
  const locked = busy || !settings || loadFailed;

  useEffect(() => {
    if (takeClientPickerJump()) ref.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, []);

  return (
    <section ref={ref} id={CLIENT_PICKER_ANCHOR} className="client-model-picker flex scroll-mt-[72px] flex-col gap-3"
      aria-labelledby={titleId}>
      <h3 id={titleId} className="m-0 text-[14px] leading-5 font-semibold text-fg">
        {t("modelsV2.clientPicker")}
      </h3>
      <PickerPinnedRoster apiBase={apiBase} onSaved={() => setRosterRevision(n => n + 1)} />
      <div className="row models-cap-row" aria-busy={busy || refreshing}>
        <span className="muted text-control">{t("models.pickerOrder.label")}</span>
        <Select
          value={mode}
          options={ORDER_MODES.map(option => ({ value: option.value, label: t(option.label) }))}
          onChange={value => onModeChange(value as ModelPickerOrderMode)}
          disabled={locked}
          label={t("models.pickerOrder.label")}
        />
        <button type="button" className="btn btn-ghost btn-sm" onClick={onApply}
          disabled={locked || mode === "custom" || (mode !== "default" && settings?.pickerAvailable.length === 0)}>
          {t(busy ? "models.pickerOrder.applying" : "models.pickerOrder.apply")}
        </button>
        {loadFailed && <>
          <span role="alert">{t("models.pickerOrder.loadFailed")}</span>
          <button type="button" className="btn btn-ghost btn-sm" onClick={onRetry}>
            {t("models.pickerOrder.retry")}
          </button>
        </>}
        <InfoHint text={t("models.pickerOrder.hint")} />
      </div>
      {mode === "custom" && (
        <ModelPickerOrderEditor key={`${apiBase}:${rosterRevision}`} apiBase={apiBase} active={active}
          identities={identities} onBusyChange={onBusyChange} onAccepted={onAccepted} />
      )}
      <FastRowsSetting apiBase={apiBase} onSaved={onFastSaved} />
    </section>
  );
}
