import { navigateHash, normalizeHashPath } from "../../hash-routing";

export type GuardrailsTab = "overview" | "rules" | "tester" | "activity" | "settings";

export const GUARDRAILS_TABS: readonly GuardrailsTab[] = [
  "overview",
  "rules",
  "tester",
  "activity",
  "settings",
];

export function guardrailsTabHash(tab: GuardrailsTab): string {
  return tab === "overview" ? "guardrails" : `guardrails/${tab}`;
}
export function readGuardrailsTab(hash = window.location.hash): GuardrailsTab {
  const path = normalizeHashPath(hash);
  const candidate = path.startsWith("guardrails/") ? path.slice("guardrails/".length) : "";
  return GUARDRAILS_TABS.includes(candidate as GuardrailsTab) ? candidate as GuardrailsTab : "overview";
}

export function selectGuardrailsTab(tab: GuardrailsTab): void {
  navigateHash(guardrailsTabHash(tab));
}

export function guardrailsTabDomId(tab: GuardrailsTab): string {
  return `guardrails-tab-${tab}`;
}

export function guardrailsPanelDomId(tab: GuardrailsTab): string {
  return `guardrails-panel-${tab}`;
}
