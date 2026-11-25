import type { ComboItem, ProviderQuotaStates } from "../combo-workspace-data";
import type { ComboProviderBilling } from "../../../src/combos/suggestion-channel";

export type ProviderOption = {
  name: string;
  alias?: string;
  comboBilling?: ComboProviderBilling;
  disabled?: boolean;
  hiddenFromPicker?: boolean;
  authMode?: string;
  adapter?: string;
  baseUrl?: string;
  /** Decision-service rows need a model; see jevDecisionRowIssue. */
  defaultModel?: string;
  models?: string[];
};
export type ModelOption = {
  provider: string;
  id: string;
  namespaced?: string;
  reasoningEfforts?: string[];
  inputModalities?: string[];
  /** Operator-declared modalities; beats the (sidecar-widened) catalog view on reload. */
  inputModalitiesDeclared?: string[];
  /** Authoritative runtime verdict from /api/models: the Vision Sidecar describes this model's images. */
  visionSidecarConsumer?: boolean;
};

export type QuotaComboPreset = "openai-first" | "claude-first";
export type ComboAddIntent = "blank" | "jev-auto" | QuotaComboPreset;

import type { ReactNode } from "react";

export interface ComboWorkspaceProps {
  renderSuggestions?: (lockedComboId: string | null) => ReactNode;
  /** Management API target; enables the per-candidate path preview and JEV stats in the detail panel. */
  apiBase?: string;
  routingRevision?: string;
  combos: ComboItem[];
  providerQuotaStates: ProviderQuotaStates;
  providers: ProviderOption[];
  models: ModelOption[];
  /** Full catalog metadata, including rows hidden from the new-member picker. */
  capabilityModels?: ModelOption[];
  /** Combo ids currently present in the live catalog (`provider === "combo"`). */
  cataloguedComboIds?: ReadonlySet<string>;
  /** Vision Sidecar enabled state from /api/sidecar-settings; undefined = unknown, no warning. */
  visionEnabled?: boolean;
  loading?: boolean;
  onRefresh: () => void;
  /** `stored` is the combo as loaded when editing began, or null for a new combo (see `toPutBody`). */
  onSave: (item: ComboItem, isCreate: boolean, renameFrom?: string, stored?: ComboItem | null) => Promise<{ ok: boolean; error?: string; item?: ComboItem }>;
  onRemove: (id: string) => Promise<{ ok: boolean; error?: string }>;
  onAdd: (intent?: ComboAddIntent) => void;
  adding: boolean;
  addIntent?: ComboAddIntent;
  /** Decision service a `jev-auto` add pre-fills; null keeps canonical TypeSafe JEV. */
  addDecisionProvider?: string | null;
  onCloseAdd: () => void;
  onCreated: (id: string) => void;
}
