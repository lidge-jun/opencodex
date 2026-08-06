import type { OcxConfig } from "../../types";
import type { NativeProfileApiDeps } from "../../codex/native-profile-api";
import type { StartupInstallAction } from "../startup-action-control";
import type { ManagementPrincipal } from "../management-auth";
import type { CatalogModel } from "../../codex/catalog";
import type { injectGrokConfig } from "../../grok/inject";
import type { RuntimePortState } from "../../config";
import type { CatalogDisposition, ConvergeCodex } from "../../codex/convergence-types";

export interface ManagementApiDeps {
  toggleCodexMultiAgentV2?: (enabled: boolean) => void;
  toggleDefaultModeRequestUserInput?: (enabled: boolean) => void;
  createManagementConvergeCodex?: (config: Readonly<OcxConfig>) => ConvergeCodex;
  /**
   * Persistence seam for route-level tests. Production leaves this unset and uses
   * `saveConfigPreservingClaudeCode`; tests that pass an in-memory fixture config
   * MUST inject a no-op/spy so the fixture can never overwrite the user's real
   * OPENCODEX_HOME (incident: devlog 260730.../070).
   */
  saveConfigPreservingClaudeCode?: (config: OcxConfig) => void;
  /**
   * Catalog seam for the Grok toggle (WP2, devlog 260803_integrations_toggle_all
   * Rev 3 N2). Production leaves this unset and the route dynamic-imports the
   * real one — a static import would close a cycle with management-api.ts.
   * Tests stub it to orphan the fixture file mid-fetch (the r7 recheck test).
   */
  fetchAllModels?: (config: OcxConfig) => Promise<CatalogModel[]>;
  /**
   * Writer seam for the Grok toggle: lets a test place the file in any state
   * between the pre-write recheck and the write itself (the r8 post-inspection
   * tests). Production leaves this unset and uses the real writer.
   */
  injectGrokConfig?: typeof injectGrokConfig;
  /**
   * Runtime-state seam: the fence must name the host/port the RUNNING process
   * bound (agent-settings-routes.ts:99-103 pattern), and a test must not depend
   * on the developer's real runtime state file.
   */
  readRuntimePort?: (pid: number) => RuntimePortState | null;
  clearThreadAccountMap?: () => void;
  clearProviderQuotaCache?: () => void;
  primeCodexPoolQuotas?: (config: OcxConfig, reason: string) => Promise<void> | void;
  runStartupInstallAction?: (
    action: StartupInstallAction,
    options?: { repair?: boolean },
  ) => Promise<{ message: string }>;
  /**
   * Native-main profile persistence seam for server-boundary tests. Production
   * leaves this unset, so the route creates its normal NativeProfileManager.
   */
  nativeProfileApi?: NativeProfileApiDeps;
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
  convergeCodexCatalog: () => Promise<CatalogDisposition>;
  syncClaudeAgentDefsBestEffort: () => Promise<void>;
}
