import { navigateHash } from "../hash-routing";
import { sectionAnchorId } from "../section-anchors";
import { writeSettingsOpen } from "./models-settings-summary";

export const CLIENT_PICKER_ANCHOR = sectionAnchorId("models", "client-picker");

/** One-shot: the next client picker section to mount scrolls itself into view. */
let pendingJump = false;

/** Opens the Models catalog with its settings panel expanded at the client model picker. */
export function jumpToClientPicker(): void {
  writeSettingsOpen(true);
  pendingJump = true;
  navigateHash("models");
}

export function takeClientPickerJump(): boolean {
  const pending = pendingJump;
  pendingJump = false;
  return pending;
}
