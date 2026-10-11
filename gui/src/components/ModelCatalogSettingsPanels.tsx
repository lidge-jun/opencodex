import type { ComponentProps } from "react";
import ModelPickerOrderEditor from "./ModelPickerOrderEditor";
import FastRowsSetting from "./FastRowsSetting";
import UltraFastTierSetting from "./UltraFastTierSetting";

type Props = ComponentProps<typeof ModelPickerOrderEditor> & {
  showOrderEditor: boolean;
  onSaved: () => void;
};

/** Keep speed-tier controls available regardless of the chosen picker ordering. */
export default function ModelCatalogSettingsPanels({ showOrderEditor, onSaved, ...picker }: Props) {
  return <>
    {showOrderEditor && <ModelPickerOrderEditor key={picker.apiBase} {...picker} />}
    <FastRowsSetting apiBase={picker.apiBase} onSaved={onSaved} />
    <UltraFastTierSetting apiBase={picker.apiBase} />
  </>;
}
