import type { ComboItem, ProviderQuotaStates } from "../combo-workspace-data";

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

export type ComboAddIntent = "blank" | "jev-auto";

export interface ComboWorkspaceProps {
  /** Management API target; enables the per-candidate path preview and JEV stats in the detail panel. */
  apiBase?: string;
  combos: ComboItem[];
  providerQuotaStates: ProviderQuotaStates;
  providers: ProviderOption[];
  models: ModelOption[];
  /** Combo ids currently present in the live catalog (`provider === "combo"`). */
  cataloguedComboIds?: ReadonlySet<string>;
  loading?: boolean;
  onRefresh: () => void;
  onSave: (item: ComboItem, isCreate: boolean, renameFrom?: string) => Promise<{ ok: boolean; error?: string }>;
  onRemove: (id: string) => Promise<{ ok: boolean; error?: string }>;
  onAdd: (intent?: ComboAddIntent) => void;
  adding: boolean;
  addIntent?: ComboAddIntent;
  onCloseAdd: () => void;
  onCreated: (id: string) => void;
}
