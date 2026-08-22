import type { OcxConfig } from "../../types";
import type { NativeProfileApiDeps } from "../../codex/native-profile-api";
import type { CodexLogGuardProtectionDeps } from "../../codex/log-guard/protection";
import type { CodexLogGuardMaintenanceDeps } from "../../codex/log-guard/maintenance";
import type { StartupHealth } from "../../codex/autostart-health";
import type { StartupInstallAction } from "../startup-action-control";
import type { ManagementPrincipal } from "../management-auth";
import type { CatalogModel } from "../../codex/catalog";
import type { injectGrokConfig } from "../../grok/inject";
import type { removeDesktop3pStandardPivot, writeDesktop3pConfig } from "../../claude/desktop-3p";
import type { RuntimePortState } from "../../config";
import type { CatalogDisposition, ConvergeCodex } from "../../codex/convergence-types";
import type {
  performCodexRestart,
  readCodexAppServerState,
} from "../../codex/app-server-restart-service";

export interface ManagementApiDeps {
  /** Platform seam for capability projections; does not alter host-level startup behavior. */
  platform?: NodeJS.Platform;
  toggleCodexMultiAgentV2?: (enabled: boolean) => void;
  toggleDefaultModeRequestUserInput?: (enabled: boolean) => void;
  createManagementConvergeCodex?: (config: Readonly<OcxConfig>) => ConvergeCodex;
  /** Startup-health seam keeps route tests from launching platform probes. */
  getCachedStartupHealth?: (config: Pick<OcxConfig, "codexAutoStart">) => Promise<StartupHealth>;
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
  /** Desktop mutation seams keep route tests inside temporary config libraries. */
  removeDesktop3pStandardPivot?: typeof removeDesktop3pStandardPivot;
  writeDesktop3pConfig?: typeof writeDesktop3pConfig;
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
  /**
   * Codex app-server restart seam (devlog/_fin/260815_gui_codex_restart).
   * Grouped rather than three separate fields: the route is an adapter over one
   * service, and a route test that could not stub it would really terminate the
   * developer's own Codex app-servers.
   */
  codexRestartService?: {
    readState: typeof readCodexAppServerState;
    performRestart: typeof performCodexRestart;
  };
  nativeProfileApi?: NativeProfileApiDeps;
  /**
   * Log Guard mutation seam. Production leaves this unset and therefore uses the
   * owner-verified process enumerator, trusted L namespace and real config store.
   * Route tests inject all three so they cannot depend on local Codex processes
   * or create lock/config state outside the fixture.
   */
  codexLogGuardProtectionDeps?: CodexLogGuardProtectionDeps;
  /**
   * Log Guard maintenance seam. Production reuses the same fail-closed process
   * enumerator and L namespace as Protect; route tests keep all maintenance
   * state inside their temporary Codex home.
   */
  codexLogGuardMaintenanceDeps?: CodexLogGuardMaintenanceDeps;
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
