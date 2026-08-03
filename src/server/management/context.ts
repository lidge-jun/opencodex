import type { OcxConfig } from "../../types";
import type { StartupInstallAction } from "../startup-action-control";

export interface ManagementApiDeps {
  toggleCodexMultiAgentV2?: (enabled: boolean) => void;
  toggleDefaultModeRequestUserInput?: (enabled: boolean) => void;
  refreshCodexCatalog?: () => Promise<void>;
  /**
   * Persistence seam for route-level tests. Production leaves this unset and uses
   * `saveConfigPreservingClaudeCode`; tests that pass an in-memory fixture config
   * MUST inject a no-op/spy so the fixture can never overwrite the user's real
   * OPENCODEX_HOME (incident: devlog 260730.../070).
   */
  saveConfigPreservingClaudeCode?: (config: OcxConfig) => void;
  clearThreadAccountMap?: () => void;
  clearProviderQuotaCache?: () => void;
  primeCodexPoolQuotas?: (config: OcxConfig, reason: string) => Promise<void> | void;
  runStartupInstallAction?: (
    action: StartupInstallAction,
    options?: { repair?: boolean },
  ) => Promise<{ message: string }>;
}


export interface ManagementContext {
  req: Request;
  url: URL;
  config: OcxConfig;
  deps: ManagementApiDeps;
  refreshCodexCatalogBestEffort: () => Promise<void>;
  syncClaudeAgentDefsBestEffort: () => Promise<void>;
}
