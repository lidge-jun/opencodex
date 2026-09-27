/**
 * State behind the Models settings panel: its persisted open flag and the summary line
 * that names every folded control. Kept apart from the component file so Fast Refresh
 * sees a components-only module there.
 */
import type { TFn, TKey } from "../i18n/shared";
import type { StorageLike } from "./collapse-store";
import { fmtK } from "./models-shared";

export const SETTINGS_OPEN_KEY = "ocx.models.settingsOpen.v1";

export interface SettingsSummaryItem {
  id: string;
  label: string;
  value: string;
}

function resolveStorage(storage?: StorageLike): StorageLike | undefined {
  if (storage) return storage;
  return typeof localStorage === "undefined" ? undefined : localStorage;
}

export function readSettingsOpen(storage?: StorageLike): boolean {
  try {
    return resolveStorage(storage)?.getItem(SETTINGS_OPEN_KEY) === "1";
  } catch {
    return false;
  }
}

export function writeSettingsOpen(open: boolean, storage?: StorageLike): void {
  try {
    resolveStorage(storage)?.setItem(SETTINGS_OPEN_KEY, open ? "1" : "0");
  } catch {
    /* quota / private mode: the fold is a preference, never a failure */
  }
}

export interface ModelsSettingsState {
  multiAgentMode?: "v1" | "default" | "v2";
  /** Explicit per-session thread cap; null/undefined means Codex's default. */
  v2Threads?: number | null;
  keepNativeOnV1?: boolean;
  shadowEnabled: boolean;
  shadowModel?: string;
  windowOn: boolean;
  windowValue: number;
  /** The SAVED picker mode — an unapplied draft is not the catalog's state. */
  pickerMode: string;
  newModelsOff: boolean;
  aliasesOn: boolean;
}

const PICKER_MODE_KEYS: Record<string, TKey> = {
  default: "models.pickerOrder.default",
  alphabetical: "models.pickerOrder.alphabetical",
  provider: "models.pickerOrder.provider",
  "most-used": "models.pickerOrder.mostUsed",
  custom: "models.pickerOrder.custom",
};

/**
 * Ordered by how much each control changes request behaviour. The four core controls
 * always appear; the rest appear only when they differ from their default, so the line
 * stays short while nothing that changes behaviour is hidden by the fold.
 */
export function modelsSettingsSummary(t: TFn, state: ModelsSettingsState): SettingsSummaryItem[] {
  const off = t("models.settingsPanel.off");
  const items: SettingsSummaryItem[] = [];
  if (state.multiAgentMode) {
    items.push({ id: "subagent", label: t("models.v2Label"), value: t(`models.v2Mode_${state.multiAgentMode}` as TKey) });
  }
  if (state.multiAgentMode === "v2" && typeof state.v2Threads === "number") {
    items.push({ id: "threads", label: t("models.v2ThreadsLabel"), value: String(state.v2Threads) });
  }
  if (state.multiAgentMode === "v2" && state.keepNativeOnV1) {
    items.push({ id: "keep-native", label: t("models.keepNativeOnV1"), value: "" });
  }
  items.push({
    id: "shadow",
    label: t("models.shadowCallIntercept"),
    value: state.shadowEnabled && state.shadowModel ? state.shadowModel : off,
  });
  items.push({ id: "window", label: t("models.contextCapLabel"), value: state.windowOn ? fmtK(state.windowValue) : off });
  const pickerKey = PICKER_MODE_KEYS[state.pickerMode];
  items.push({ id: "order", label: t("models.pickerOrder.label"), value: pickerKey ? t(pickerKey) : state.pickerMode });
  if (state.newModelsOff) items.push({ id: "new-models", label: t("models.newPolicyGlobal"), value: "" });
  if (state.aliasesOn) items.push({ id: "aliases", label: t("models.useDefaultAliasesGlobal"), value: "" });
  return items;
}
