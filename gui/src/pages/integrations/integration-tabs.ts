/**
 * The Integrations tab strip and the set of tabs backed by a file client.
 *
 * A separate module rather than exports on Integrations.tsx, because a file that
 * exports both a component and constants breaks React fast refresh
 * (react/only-export-components). These need to be importable: they are the only
 * client lists in the GUI that neither tests/integrations-invariants.test.ts
 * compares nor the compiler forces, so a client added everywhere else still gets
 * no tab and nothing fails. gui/tests/integrations-tab-coverage.test.ts stands in
 * that gap and reads them from here.
 */
import type { TKey } from "../../i18n/shared";
import type { FileIntegrationClientId } from "./FileIntegrationPage";

export type IntegrationTab =
  | "overview"
  | "keys"
  | "codex"
  | "claude"
  | "grok"
  | "cursor"
  | FileIntegrationClientId;

export interface TabDefinition {
  id: IntegrationTab;
  hash: string;
  labelKey: TKey;
}

export const TABS: readonly TabDefinition[] = [
  { id: "overview", hash: "integrations", labelKey: "integrations.tab.overview" },
  { id: "keys", hash: "integrations/keys", labelKey: "integrations.tab.keys" },
  { id: "codex", hash: "integrations/codex", labelKey: "integrations.tab.codex" },
  { id: "claude", hash: "integrations/claude", labelKey: "integrations.tab.claude" },
  { id: "grok", hash: "integrations/grok", labelKey: "integrations.tab.grok" },
  { id: "cursor", hash: "integrations/cursor", labelKey: "integrations.tab.cursor" },
  { id: "opencode", hash: "integrations/opencode", labelKey: "integrations.tab.opencode" },
  { id: "pi", hash: "integrations/pi", labelKey: "integrations.tab.pi" },
  { id: "omp", hash: "integrations/omp", labelKey: "integrations.tab.omp" },
  { id: "hermes", hash: "integrations/hermes", labelKey: "integrations.tab.hermes" },
  { id: "openclaw", hash: "integrations/openclaw", labelKey: "integrations.tab.openclaw" },
  { id: "kimi", hash: "integrations/kimi", labelKey: "integrations.tab.kimi" },
  { id: "gajae", hash: "integrations/gajae", labelKey: "integrations.tab.gajae" },
  { id: "dsh", hash: "integrations/dsh", labelKey: "integrations.tab.dsh" },
  { id: "mcode", hash: "integrations/mcode", labelKey: "integrations.tab.mcode" },
  { id: "zcode", hash: "integrations/zcode", labelKey: "integrations.tab.zcode" },
  { id: "prime", hash: "integrations/prime", labelKey: "integrations.tab.prime" },
  { id: "aside", hash: "integrations/aside", labelKey: "integrations.tab.aside" },
] as const;

export const FILE_CLIENTS = new Set<FileIntegrationClientId>([
  "opencode",
  "pi",
  "omp",
  "hermes",
  "openclaw",
  "kimi",
  "gajae",
  "dsh",
  "mcode",
  "zcode",
  "prime",
  "aside",
]);
