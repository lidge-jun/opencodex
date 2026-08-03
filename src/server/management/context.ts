import type { OcxConfig } from "../../types";
import type { StartupInstallAction } from "../startup-action-control";
import type { ManagementPrincipal } from "../management-auth";

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
  /**
   * Which credential authorized this request, resolved by the auth gate before
   * dispatch. Routes that spend the USER's identity (not just the proxy's) must
   * branch on this instead of on request headers: the admin token is readable by
   * anything running as the user, so a token holder can forge any header a route
   * might otherwise treat as browser evidence. Undefined only in direct-dispatch
   * tests, which are treated as the untrusted `admin-token` case.
   */
  principal?: ManagementPrincipal;
  refreshCodexCatalogBestEffort: () => Promise<void>;
  syncClaudeAgentDefsBestEffort: () => Promise<void>;
}
