import type { ComboItem } from "../combo-workspace-data";

export type ProviderOption = {
  name: string;
  disabled?: boolean;
  hiddenFromPicker?: boolean;
  authMode?: string;
  adapter?: string;
  baseUrl?: string;
};
export type ModelOption = {
  provider: string;
  id: string;
  namespaced?: string;
  reasoningEfforts?: string[];
  inputModalities?: string[];
};

export interface ComboWorkspaceProps {
  combos: ComboItem[];
  providers: ProviderOption[];
  models: ModelOption[];
  /** Combo ids currently present in the live catalog (`provider === "combo"`). */
  cataloguedComboIds?: ReadonlySet<string>;
  loading?: boolean;
  onRefresh: () => void;
  onSave: (item: ComboItem, isCreate: boolean, renameFrom?: string) => Promise<{ ok: boolean; error?: string }>;
  onRemove: (id: string) => Promise<{ ok: boolean; error?: string }>;
  onAdd: () => void;
  adding: boolean;
  onCloseAdd: () => void;
  onCreated: (id: string) => void;
}
