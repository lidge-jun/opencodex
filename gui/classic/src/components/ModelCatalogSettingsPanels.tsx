import type { ComponentProps } from "react";
import ModelPickerOrderEditor from "./ModelPickerOrderEditor";
import FastRowsSetting from "./FastRowsSetting";

type Props = ComponentProps<typeof ModelPickerOrderEditor> & {
  showOrderEditor: boolean;
  onSaved: () => void;
};

/** Keep conditional picker ordering and always-visible Fast rows as sibling panels. */
export default function ModelCatalogSettingsPanels({ showOrderEditor, onSaved, ...picker }: Props) {
  return <>
    {showOrderEditor && <ModelPickerOrderEditor key={picker.apiBase} {...picker} />}
    <FastRowsSetting apiBase={picker.apiBase} onSaved={onSaved} />
  </>;
}
