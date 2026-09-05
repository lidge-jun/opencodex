/**
 * Declared inventory of every reachable management route.
 *
 * DECLARED, not harvested. A grep cannot see this surface: 18 routes are registered
 * through a regex, an `endsWith`, a `pathname.slice`, a prefix decode, a path constant, or a
 * negated `pathname !== "…"` guard, and two of those are live routes whose only textual
 * trace is the negated form. For `GET /api/storage` an equality scan finds solely the dead
 * shadowed copy in `logs-usage-routes.ts` and never the live one.
 *
 * This module is pure DATA and must stay that way. It is imported by
 * `src/server/management-api.ts`, which `tests/core-lab-boundary.test.ts` protects: a user
 * with one provider and no Lab must execute no Lab code. Route paths are strings, so
 * declaring `/api/lab/status` here creates no module edge. Never import a handler, and
 * never import anything from `src/lab/`. The `module` field names the owning file as text
 * for exactly this reason.
 *
 * The file is also the ADR-0008 Go-ownership ledger. A read route declares itself
 * Go-owned by carrying a `go` marker (see `GoOwnedRouteDeclaration`); the discriminated
 * union makes the marker impossible on a write route, `GO_OWNED_MANAGEMENT_ROUTES` is the
 * derived migrated surface, and the single forwarding branch in `management-api.ts` reads
 * that data. Migrating a read route is a marker flip here plus the Go handler and oracle
 * coverage -- never a dispatch edit.
 *
 * Reconciliation lives in `tests/management-route-registry.test.ts`, which resolves
 * `(method, path)` pairs from source and fails loudly on a route whose method it cannot
 * determine. Adding a route without declaring it here fails that test.
 */

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD";

/**
 * Why a route has no CLI verb. Every value is a claim about the route that a reviewer
 * can check, not a way to quiet the parity test.
 */
export type ExemptionReason =
  /** Requires a dashboard browser session. Includes the user-consent star boundary. */
  | "session-only"
  /** Deliberately returns 405; there is nothing to drive. */
  | "disabled"
  /** Gated on a process-scoped capability principal, not an operator action. */
  | "capability-principal"
  /** A test seam, not an operator capability. */
  | "test-seam"
  /** The CLI reaches the same data through a local transport instead of HTTP. */
  | "local-transport"
  /** Unreachable in the live dispatch order; delete rather than expose. */
  | "dead"
  /**
   * A verb is owed but belongs to a later work-phase. BOUNDED: requires `owner` and
   * `ownerDoc`, and the parity test asserts that tracked doc exists and names the route.
   * The doc is deliberately a repository file rather than the goalplan, which is
   * gitignored -- a test reading machine-local state passes here and finds nothing in CI.
   */
  | "deferred-verb";

export interface RouteExemption {
  readonly reason: ExemptionReason;
  /** Free text; required, because an exemption nobody justified is how a gate erodes. */
  readonly why: string;
  /** Work-phase that owes the verb. Required for `deferred-verb`. */
  readonly owner?: string;
  /** Tracked doc naming the route. Required for `deferred-verb`. */
  readonly ownerDoc?: string;
}

/** How a route is registered, for routes an equality scan cannot see. */
export type NonLiteralMechanism =
  | "negated-guard"
  | "path-constant"
  | "prefix-decode"
  | "slice"
  | "ends-with"
  | "regex";

/**
 * ADR-0008 Go-ownership declaration carried by a read route that the Go
 * ocx-sidecar has taken over (ticket #14: the ownership marker is typed so a
 * write route cannot carry it, and migration is a flip of this data marker).
 *
 * The declaration is per route, not per payload family, because the volatile
 * fields belong to the route's response contract: when the differential oracle
 * compares the in-process TypeScript response against the Go-served response it
 * normalises exactly these top-level JSON keys and nothing else, so a later
 * route can never silently widen what "equal" means.
 */
export interface GoOwnedRouteDeclaration {
  /**
   * Top-level JSON body keys of the route's response that may legitimately
   * differ between the two implementations (process-specific values such as
   * `pid` or `uptime`). Must be non-empty: a route that migrates while
   * declaring "nothing may differ" would demand byte equality the harness
   * cannot actually check, which is a vacuous pass.
   */
  readonly volatileFields: readonly string[];
}

interface ManagementWriteRoute {
  /** The route mutates state; it must stay in TypeScript until increment 3. */
  readonly mutates: true;
  /**
   * A write route cannot be declared Go-owned. The read/write split is a
   * discriminated union so the type system refuses `go` on this arm: only a
   * read route (`mutates: false`) may carry a GoOwnedRouteDeclaration.
   */
  readonly go?: never;
}

interface ManagementReadRoute {
  readonly mutates: false;
  /**
   * When present, the route is declared Go-owned: the single forwarding branch
   * in `management-api.ts` serves it from the attached ocx-sidecar, and the
   * in-process handler below remains the fallback and the differential oracle.
   */
  readonly go?: GoOwnedRouteDeclaration;
}

/**
 * Every reachable management route. The union splits reads from writes so the
 * `go` ownership marker exists only on the read arm: a write route cannot be
 * migrated early, at compile time, without a comment or a cast to explain it.
 */
export type ManagementRoute = {
  readonly method: HttpMethod;
  readonly path: string;
  /** Owning source file, repo-relative without the `src/` prefix or `.ts` suffix. */
  readonly module: string;
  /** Set when the route is not recoverable from an equality scan of its own file. */
  readonly mechanism?: NonLiteralMechanism;
  readonly exempt?: RouteExemption;
} & (ManagementWriteRoute | ManagementReadRoute);

/** A read route that carries a Go-ownership declaration (ADR-0008). */
export type GoOwnedManagementRoute = ManagementRoute & {
  readonly mutates: false;
  readonly go: GoOwnedRouteDeclaration;
};


/** Every reachable management route. */
export const MANAGEMENT_ROUTES: readonly ManagementRoute[] = [
  // server/management-api
  { method: "POST", path: "/api/stop", module: "server/management-api", mutates: true },
  // codex/auth-api
  { method: "DELETE", path: "/api/codex-auth/accounts", module: "codex/auth-api", mutates: true },
  { method: "GET", path: "/api/codex-auth/accounts", module: "codex/auth-api", mutates: false },
  { method: "GET", path: "/api/codex-auth/active", module: "codex/auth-api", mutates: false },
  { method: "GET", path: "/api/codex-auth/login-status", module: "codex/auth-api", mutates: false },
  { method: "GET", path: "/api/codex-auth/quota", module: "codex/auth-api", mutates: false },
  { method: "GET", path: "/api/codex-auth/reset-credits", module: "codex/auth-api", mutates: false },
  { method: "PATCH", path: "/api/codex-auth/pool-strategy", module: "codex/auth-api", mutates: true },
  { method: "POST", path: "/api/codex-auth/accounts", module: "codex/auth-api", mutates: true },
  { method: "POST", path: "/api/codex-auth/accounts/clear-cooldown", module: "codex/auth-api", mutates: true },
  { method: "POST", path: "/api/codex-auth/login", module: "codex/auth-api", mutates: true },
  { method: "POST", path: "/api/codex-auth/login/cancel", module: "codex/auth-api", mutates: true },
  { method: "POST", path: "/api/codex-auth/login/code", module: "codex/auth-api", mutates: true },
  { method: "POST", path: "/api/codex-auth/reset-credits/consume", module: "codex/auth-api", mutates: true },
  { method: "PUT", path: "/api/codex-auth/accounts/alias", module: "codex/auth-api", mutates: true },
  { method: "PUT", path: "/api/codex-auth/accounts/pause", module: "codex/auth-api", mutates: true },
  { method: "PUT", path: "/api/codex-auth/accounts/pause-exhausted", module: "codex/auth-api", mutates: true },
  { method: "PUT", path: "/api/codex-auth/accounts/priority", module: "codex/auth-api", mutates: true },
  { method: "PUT", path: "/api/codex-auth/active", module: "codex/auth-api", mutates: true },
  { method: "PUT", path: "/api/codex-auth/auto-switch", module: "codex/auth-api", mutates: true },
  { method: "PUT", path: "/api/codex-auth/failover", module: "codex/auth-api", mutates: true },
  { method: "PUT", path: "/api/codex-auth/pool-strategy", module: "codex/auth-api", mutates: true },
  // codex/native-profile-api
  { method: "GET", path: "/api/native-main-profiles", module: "codex/native-profile-api", mutates: false },
  { method: "GET", path: "/api/native-main-profiles/doctor", module: "codex/native-profile-api", mutates: false },
  { method: "POST", path: "/api/native-main-profiles/recover", module: "codex/native-profile-api", mutates: true },
  { method: "POST", path: "/api/native-main-profiles/register", module: "codex/native-profile-api", mutates: true },
  { method: "POST", path: "/api/native-main-profiles/stage", module: "codex/native-profile-api", mutates: true },
  { method: "POST", path: "/api/native-main-profiles/stage/cancel", module: "codex/native-profile-api", mutates: true },
  { method: "POST", path: "/api/native-main-profiles/stage/finish", module: "codex/native-profile-api", mutates: true },
  { method: "POST", path: "/api/native-main-profiles/stage/heartbeat", module: "codex/native-profile-api", mutates: true },
  { method: "POST", path: "/api/native-main-profiles/switch", module: "codex/native-profile-api", mutates: true },
  // server/management/agent-settings-routes
  { method: "GET", path: "/api/claude-code", module: "server/management/agent-settings-routes", mutates: false },
  { method: "GET", path: "/api/claude-desktop", module: "server/management/agent-settings-routes", mutates: false },
  { method: "GET", path: "/api/claude-desktop/status", module: "server/management/agent-settings-routes", mutates: false },
  { method: "GET", path: "/api/codex-auth/features/default-mode-request-user-input", module: "server/management/agent-settings-routes", mutates: false },
  { method: "GET", path: "/api/effort-caps", module: "server/management/agent-settings-routes", mutates: false },
  { method: "GET", path: "/api/grok", module: "server/management/agent-settings-routes", mutates: false },
  { method: "GET", path: "/api/injection-model", module: "server/management/agent-settings-routes", mutates: false },
  { method: "GET", path: "/api/subagent-model-fallback", module: "server/management/agent-settings-routes", mutates: false },
  { method: "GET", path: "/api/subagent-models", module: "server/management/agent-settings-routes", mutates: false },
  { method: "GET", path: "/api/v2", module: "server/management/agent-settings-routes", mutates: false },
  { method: "POST", path: "/api/claude-desktop/apply", module: "server/management/agent-settings-routes", mutates: true },
  { method: "POST", path: "/api/grok/apply", module: "server/management/agent-settings-routes", mutates: true },
  { method: "PUT", path: "/api/claude-code", module: "server/management/agent-settings-routes", mutates: true },
  { method: "PUT", path: "/api/claude-desktop", module: "server/management/agent-settings-routes", mutates: true },
  { method: "PUT", path: "/api/codex-auth/features/default-mode-request-user-input", module: "server/management/agent-settings-routes", mutates: true },
  { method: "PUT", path: "/api/effort-caps", module: "server/management/agent-settings-routes", mutates: true },
  { method: "PUT", path: "/api/grok/selection", module: "server/management/agent-settings-routes", mutates: true },
  { method: "PUT", path: "/api/injection-model", module: "server/management/agent-settings-routes", mutates: true },
  { method: "PUT", path: "/api/subagent-model-fallback", module: "server/management/agent-settings-routes", mutates: true },
  { method: "PUT", path: "/api/subagent-models", module: "server/management/agent-settings-routes", mutates: true },
  { method: "PUT", path: "/api/v2", module: "server/management/agent-settings-routes", mutates: true },
  // server/management/codex-prompt-routes
  { method: "GET", path: "/api/codex-prompt", module: "server/management/codex-prompt-routes", mutates: false },
  { method: "GET", path: "/api/codex-prompt/text", module: "server/management/codex-prompt-routes", mutates: false },
  { method: "POST", path: "/api/codex-prompt/adopt", module: "server/management/codex-prompt-routes", mutates: true, exempt: { reason: "session-only", why: "Prompt adoption requires the gui-session principal (codex-prompt-routes.ts:298)." } },
  { method: "POST", path: "/api/codex-prompt/repair", module: "server/management/codex-prompt-routes", mutates: true, exempt: { reason: "session-only", why: "Prompt repair requires the gui-session principal (codex-prompt-routes.ts:298)." } },
  { method: "PUT", path: "/api/codex-prompt/base", module: "server/management/codex-prompt-routes", mutates: true, exempt: { reason: "session-only", why: "Base prompt write requires the gui-session principal (codex-prompt-routes.ts:298)." } },
  { method: "PUT", path: "/api/codex-prompt/base/select", module: "server/management/codex-prompt-routes", mutates: true, exempt: { reason: "session-only", why: "Base prompt selection requires the gui-session principal (codex-prompt-routes.ts:298)." } },
  { method: "PUT", path: "/api/codex-prompt/custom", module: "server/management/codex-prompt-routes", mutates: true, exempt: { reason: "session-only", why: "Custom prompt write requires the gui-session principal (codex-prompt-routes.ts:298)." } },
  { method: "PUT", path: "/api/codex-prompt/toggle", module: "server/management/codex-prompt-routes", mutates: true, exempt: { reason: "session-only", why: "Prompt toggle requires the gui-session principal (codex-prompt-routes.ts:298)." } },
  // server/management/combo-routes
  { method: "DELETE", path: "/api/combos", module: "server/management/combo-routes", mutates: true },
  { method: "GET", path: "/api/combos", module: "server/management/combo-routes", mutates: false },
  { method: "PUT", path: "/api/combos", module: "server/management/combo-routes", mutates: true },
  // server/management/config-routes
  { method: "GET", path: "/api/config", module: "server/management/config-routes", mutates: false },
  { method: "GET", path: "/api/diagnostics/project-config", module: "server/management/config-routes", mutates: false },
  { method: "GET", path: "/api/settings", module: "server/management/config-routes", mutates: false },
  { method: "GET", path: "/api/shadow-call-settings", module: "server/management/config-routes", mutates: false },
  { method: "GET", path: "/api/sidecar-settings", module: "server/management/config-routes", mutates: false },
  { method: "GET", path: "/api/startup-health", module: "server/management/config-routes", mutates: false },
  { method: "GET", path: "/api/update/check", module: "server/management/config-routes", mutates: false },
  { method: "GET", path: "/api/update/status", module: "server/management/config-routes", mutates: false },
  { method: "GET", path: "/api/windows-tray", module: "server/management/config-routes", mutates: false },
  { method: "POST", path: "/api/startup-action", module: "server/management/config-routes", mutates: true },
  { method: "POST", path: "/api/sync", module: "server/management/config-routes", mutates: true },
  { method: "POST", path: "/api/update/run", module: "server/management/config-routes", mutates: true },
  { method: "POST", path: "/api/windows-tray", module: "server/management/config-routes", mutates: true },
  { method: "PUT", path: "/api/config", module: "server/management/config-routes", mutates: true, exempt: { reason: "disabled", why: "Returns 405 by design; provider changes go through POST /api/providers." } },
  { method: "PUT", path: "/api/settings", module: "server/management/config-routes", mutates: true },
  { method: "PUT", path: "/api/shadow-call-settings", module: "server/management/config-routes", mutates: true },
  { method: "PUT", path: "/api/sidecar-settings", module: "server/management/config-routes", mutates: true },
  // server/management/integration-routes
  { method: "GET", path: "/api/client-integrations", module: "server/management/integration-routes", mutates: false },
  { method: "GET", path: "/api/client-integrations/journal", module: "server/management/integration-routes", mutates: false },
  { method: "POST", path: "/api/client-integrations/restore", module: "server/management/integration-routes", mutates: true },
  // server/management/lab-automation-routes
  { method: "GET", path: "/api/lab/automation", module: "server/management/lab-automation-routes", mutates: false, exempt: { reason: "local-transport", why: "ocx lab reads the same rows from the local SQLite projection; src/cli/lab.ts imports ../lab/query directly and never fetches /api/lab." } },
  { method: "GET", path: "/api/lab/automation/runs", module: "server/management/lab-automation-routes", mutates: false, exempt: { reason: "local-transport", why: "ocx lab reads the same rows from the local SQLite projection; src/cli/lab.ts imports ../lab/query directly and never fetches /api/lab." } },
  { method: "POST", path: "/api/lab/automation/run", module: "server/management/lab-automation-routes", mutates: true, exempt: { reason: "deferred-verb", why: "Lab automation run has no CLI verb yet. A local SQLite read cannot drive it, so local-transport does not apply.", owner: "wp7", ownerDoc: "devlog/_plan/260828_ocx_agentic_control/060_phase_gui_parity.md" } },
  { method: "PUT", path: "/api/lab/automation", module: "server/management/lab-automation-routes", mutates: true, exempt: { reason: "deferred-verb", why: "Lab automation config update has no CLI verb yet. A local SQLite read cannot drive it, so local-transport does not apply.", owner: "wp7", ownerDoc: "devlog/_plan/260828_ocx_agentic_control/060_phase_gui_parity.md" } },
  // server/management/lab-routes
  { method: "GET", path: "/api/lab/artifacts", module: "server/management/lab-routes", mutates: false, exempt: { reason: "local-transport", why: "ocx lab reads the same rows from the local SQLite projection; src/cli/lab.ts imports ../lab/query directly and never fetches /api/lab." } },
  { method: "GET", path: "/api/lab/catalog", module: "server/management/lab-routes", mutates: false, exempt: { reason: "local-transport", why: "ocx lab reads the same rows from the local SQLite projection; src/cli/lab.ts imports ../lab/query directly and never fetches /api/lab." } },
  { method: "GET", path: "/api/lab/events", module: "server/management/lab-routes", mutates: false, exempt: { reason: "local-transport", why: "ocx lab reads the same rows from the local SQLite projection; src/cli/lab.ts imports ../lab/query directly and never fetches /api/lab." } },
  { method: "GET", path: "/api/lab/observations", module: "server/management/lab-routes", mutates: false, exempt: { reason: "local-transport", why: "ocx lab reads the same rows from the local SQLite projection; src/cli/lab.ts imports ../lab/query directly and never fetches /api/lab." } },
  { method: "GET", path: "/api/lab/production-signals", module: "server/management/lab-routes", mutates: false, exempt: { reason: "local-transport", why: "ocx lab reads the same rows from the local SQLite projection; src/cli/lab.ts imports ../lab/query directly and never fetches /api/lab." } },
  { method: "GET", path: "/api/lab/public/community", module: "server/management/lab-routes", mutates: false, exempt: { reason: "local-transport", why: "ocx lab reads the same rows from the local SQLite projection; src/cli/lab.ts imports ../lab/query directly and never fetches /api/lab." } },
  { method: "GET", path: "/api/lab/status", module: "server/management/lab-routes", mutates: false, exempt: { reason: "local-transport", why: "ocx lab reads the same rows from the local SQLite projection; src/cli/lab.ts imports ../lab/query directly and never fetches /api/lab." } },
  { method: "GET", path: "/api/lab/subjects", module: "server/management/lab-routes", mutates: false, exempt: { reason: "local-transport", why: "ocx lab reads the same rows from the local SQLite projection; src/cli/lab.ts imports ../lab/query directly and never fetches /api/lab." } },
  { method: "GET", path: "/api/lab/verdicts", module: "server/management/lab-routes", mutates: false, exempt: { reason: "local-transport", why: "ocx lab reads the same rows from the local SQLite projection; src/cli/lab.ts imports ../lab/query directly and never fetches /api/lab." } },
  { method: "POST", path: "/api/lab/public/community/import", module: "server/management/lab-routes", mutates: true, exempt: { reason: "deferred-verb", why: "Community evidence import has no CLI verb yet. A local SQLite read cannot drive it, so local-transport does not apply.", owner: "wp7", ownerDoc: "devlog/_plan/260828_ocx_agentic_control/060_phase_gui_parity.md" } },
  { method: "POST", path: "/api/lab/public/export", module: "server/management/lab-routes", mutates: true, exempt: { reason: "deferred-verb", why: "Public evidence export has no CLI verb yet. A local SQLite read cannot drive it, so local-transport does not apply.", owner: "wp7", ownerDoc: "devlog/_plan/260828_ocx_agentic_control/060_phase_gui_parity.md" } },
  { method: "POST", path: "/api/lab/public/preview", module: "server/management/lab-routes", mutates: true, exempt: { reason: "deferred-verb", why: "Public evidence preview has no CLI verb yet. A local SQLite read cannot drive it, so local-transport does not apply.", owner: "wp7", ownerDoc: "devlog/_plan/260828_ocx_agentic_control/060_phase_gui_parity.md" } },
  { method: "POST", path: "/api/lab/public/verify", module: "server/management/lab-routes", mutates: true, exempt: { reason: "deferred-verb", why: "Public evidence verification has no CLI verb yet. A local SQLite read cannot drive it, so local-transport does not apply.", owner: "wp7", ownerDoc: "devlog/_plan/260828_ocx_agentic_control/060_phase_gui_parity.md" } },
  // server/management/logs-usage-routes
  { method: "GET", path: "/api/claude/inbound-debug", module: "server/management/logs-usage-routes", mutates: false },
  { method: "GET", path: "/api/debug", module: "server/management/logs-usage-routes", mutates: false },
  { method: "GET", path: "/api/debug/injection-logs", module: "server/management/logs-usage-routes", mutates: false },
  { method: "GET", path: "/api/debug/logs", module: "server/management/logs-usage-routes", mutates: false },
  { method: "GET", path: "/api/debug/usage-logs", module: "server/management/logs-usage-routes", mutates: false },
  { method: "GET", path: "/api/logs", module: "server/management/logs-usage-routes", mutates: false },
  { method: "GET", path: "/api/storage/cleanup-policy", module: "server/management/logs-usage-routes", mutates: false },
  { method: "GET", path: "/api/storage/cleanup-policy/test-stream", module: "server/management/logs-usage-routes", mutates: false, exempt: { reason: "test-seam", why: "Opt-in streaming seam declared at src/storage/policy-job.ts:71." } },
  { method: "GET", path: "/api/storage/trash", module: "server/management/logs-usage-routes", mutates: false },
  { method: "GET", path: "/api/storage/trash/restore/test-stream", module: "server/management/logs-usage-routes", mutates: false, exempt: { reason: "test-seam", why: "Opt-in streaming seam declared at src/storage/restore-job.ts:34." } },
  { method: "GET", path: "/api/usage", module: "server/management/logs-usage-routes", mutates: false },
  { method: "POST", path: "/api/storage/cleanup", module: "server/management/logs-usage-routes", mutates: true },
  { method: "POST", path: "/api/storage/cleanup-policy/run", module: "server/management/logs-usage-routes", mutates: true },
  { method: "POST", path: "/api/storage/cleanup/preview", module: "server/management/logs-usage-routes", mutates: true },
  { method: "POST", path: "/api/storage/trash/restore", module: "server/management/logs-usage-routes", mutates: true },
  { method: "PUT", path: "/api/debug", module: "server/management/logs-usage-routes", mutates: true },
  { method: "PUT", path: "/api/storage/cleanup-policy", module: "server/management/logs-usage-routes", mutates: true },
  // server/management/model-routes
  { method: "GET", path: "/api/aliases", module: "server/management/model-routes", mutates: false },
  { method: "GET", path: "/api/catalog", module: "server/management/model-routes", mutates: false },
  { method: "GET", path: "/api/client-config", module: "server/management/model-routes", mutates: false },
  { method: "GET", path: "/api/custom-models", module: "server/management/model-routes", mutates: false },
  { method: "GET", path: "/api/model-discovery", module: "server/management/model-routes", mutates: false },
  { method: "GET", path: "/api/model-presets", module: "server/management/model-routes", mutates: false },
  { method: "GET", path: "/api/models", module: "server/management/model-routes", mutates: false },
  { method: "GET", path: "/api/selected-models", module: "server/management/model-routes", mutates: false },
  { method: "POST", path: "/api/custom-models", module: "server/management/model-routes", mutates: true },
  { method: "POST", path: "/api/model-discovery/acknowledge", module: "server/management/model-routes", mutates: true },
  { method: "PUT", path: "/api/default-aliases", module: "server/management/model-routes", mutates: true },
  { method: "PUT", path: "/api/disabled-models", module: "server/management/model-routes", mutates: true },
  { method: "PUT", path: "/api/model-discovery", module: "server/management/model-routes", mutates: true },
  { method: "PUT", path: "/api/model-presets", module: "server/management/model-routes", mutates: true },
  { method: "PUT", path: "/api/model-visibility", module: "server/management/model-routes", mutates: true },
  { method: "PUT", path: "/api/selected-models", module: "server/management/model-routes", mutates: true },
  // server/management/native-integration-routes
  { method: "GET", path: "/api/native-integrations", module: "server/management/native-integration-routes", mutates: false },
  { method: "PUT", path: "/api/native-integrations/claude", module: "server/management/native-integration-routes", mutates: true },
  { method: "PUT", path: "/api/native-integrations/claude-desktop", module: "server/management/native-integration-routes", mutates: true },
  { method: "PUT", path: "/api/native-integrations/codex", module: "server/management/native-integration-routes", mutates: true },
  { method: "PUT", path: "/api/native-integrations/grok", module: "server/management/native-integration-routes", mutates: true },
  // server/management/cursor-integration-routes
  { method: "GET", path: "/api/native-integrations/cursor", module: "server/management/cursor-integration-routes", mutates: false },
  // server/management/oauth-account-routes
  { method: "DELETE", path: "/api/keys", module: "server/management/oauth-account-routes", mutates: true },
  { method: "DELETE", path: "/api/keys/rotate", module: "server/management/oauth-account-routes", mutates: true },
  { method: "DELETE", path: "/api/oauth/accounts", module: "server/management/oauth-account-routes", mutates: true },
  { method: "DELETE", path: "/api/providers/keys", module: "server/management/oauth-account-routes", mutates: true },
  { method: "GET", path: "/api/key-providers", module: "server/management/oauth-account-routes", mutates: false },
  { method: "GET", path: "/api/keys", module: "server/management/oauth-account-routes", mutates: false },
  { method: "GET", path: "/api/oauth/accounts", module: "server/management/oauth-account-routes", mutates: false },
  { method: "GET", path: "/api/oauth/accounts/pool", module: "server/management/oauth-account-routes", mutates: false },
  { method: "GET", path: "/api/oauth/providers", module: "server/management/oauth-account-routes", mutates: false },
  { method: "GET", path: "/api/oauth/status", module: "server/management/oauth-account-routes", mutates: false },
  { method: "GET", path: "/api/providers/keys", module: "server/management/oauth-account-routes", mutates: false },
  { method: "GET", path: "/api/providers/keychain", module: "server/management/oauth-account-routes", mutates: false },
  { method: "POST", path: "/api/providers/keychain", module: "server/management/oauth-account-routes", mutates: true },
  { method: "PATCH", path: "/api/keys", module: "server/management/oauth-account-routes", mutates: true },
  { method: "PATCH", path: "/api/oauth/accounts/pool", module: "server/management/oauth-account-routes", mutates: true },
  { method: "POST", path: "/api/keys", module: "server/management/oauth-account-routes", mutates: true },
  { method: "POST", path: "/api/keys/rotate", module: "server/management/oauth-account-routes", mutates: true },
  { method: "POST", path: "/api/keys/rotate/commit", module: "server/management/oauth-account-routes", mutates: true },
  { method: "POST", path: "/api/oauth/accounts/clear-cooldown", module: "server/management/oauth-account-routes", mutates: true },
  { method: "POST", path: "/api/oauth/accounts/import", module: "server/management/oauth-account-routes", mutates: true },
  { method: "POST", path: "/api/oauth/login", module: "server/management/oauth-account-routes", mutates: true },
  { method: "POST", path: "/api/oauth/login/cancel", module: "server/management/oauth-account-routes", mutates: true },
  { method: "POST", path: "/api/oauth/login/code", module: "server/management/oauth-account-routes", mutates: true },
  { method: "POST", path: "/api/oauth/logout", module: "server/management/oauth-account-routes", mutates: true },
  { method: "POST", path: "/api/providers/keys", module: "server/management/oauth-account-routes", mutates: true },
  { method: "PUT", path: "/api/oauth/accounts/active", module: "server/management/oauth-account-routes", mutates: true },
  { method: "PUT", path: "/api/oauth/accounts/alias", module: "server/management/oauth-account-routes", mutates: true },
  { method: "PUT", path: "/api/oauth/accounts/pool", module: "server/management/oauth-account-routes", mutates: true },
  { method: "PUT", path: "/api/providers/keys/active", module: "server/management/oauth-account-routes", mutates: true },
  { method: "PUT", path: "/api/providers/keys/alias", module: "server/management/oauth-account-routes", mutates: true },
  // server/management/provider-routes
  { method: "DELETE", path: "/api/providers", module: "server/management/provider-routes", mutates: true },
  { method: "GET", path: "/api/provider-context-caps", module: "server/management/provider-routes", mutates: false },
  { method: "GET", path: "/api/provider-presets", module: "server/management/provider-routes", mutates: false },
  { method: "GET", path: "/api/provider-quotas", module: "server/management/provider-routes", mutates: false },
  { method: "GET", path: "/api/provider-request-pacing", module: "server/management/provider-routes", mutates: false },
  { method: "GET", path: "/api/providers", module: "server/management/provider-routes", mutates: false },
  { method: "PATCH", path: "/api/providers", module: "server/management/provider-routes", mutates: true },
  { method: "POST", path: "/api/providers", module: "server/management/provider-routes", mutates: true },
  { method: "POST", path: "/api/providers/test", module: "server/management/provider-routes", mutates: true },
  { method: "PUT", path: "/api/providers", module: "server/management/provider-routes", mutates: true, exempt: { reason: "deferred-verb", why: "Issue #3280 scopes this atomic batch endpoint to the GUI JSON editor; a matching CLI verb is outside wp5 and remains owed.", owner: "wp5-followup", ownerDoc: "devlog/_plan/260903_bug_drawdown_bcda/050_phase5.md" } },
  { method: "PUT", path: "/api/provider-context-caps", module: "server/management/provider-routes", mutates: true },
  // server/management/request-history-routes
  { method: "GET", path: "/api/request-history", module: "server/management/request-history-routes", mutates: false },
  // server/management/routing-analytics-routes
  // server/management/routing-profile-routes
  { method: "DELETE", path: "/api/routing-profiles", module: "server/management/routing-profile-routes", mutates: true },
  { method: "GET", path: "/api/routing-profiles", module: "server/management/routing-profile-routes", mutates: false },
  { method: "POST", path: "/api/routing-profiles/dry-run", module: "server/management/routing-profile-routes", mutates: true },
  { method: "PUT", path: "/api/routing-profiles", module: "server/management/routing-profile-routes", mutates: true },
  // server/management/session-routes
  { method: "POST", path: "/api/session/logout", module: "server/management/session-routes", mutates: true, exempt: { reason: "session-only", why: "Logs out the CURRENT gui-session and requires its own Origin and CSRF. There is nothing for a CLI verb to log out of: the CLI holds an admin token, and the admin token is refused here precisely so it cannot end a consent session it never established." } },
  // server/management/sidebar-routes
  { method: "GET", path: "/api/github/star", module: "server/management/sidebar-routes", mutates: false },
  { method: "GET", path: "/api/update/badge", module: "server/management/sidebar-routes", mutates: false },
  { method: "POST", path: "/api/github/star", module: "server/management/sidebar-routes", mutates: true, exempt: { reason: "session-only", why: "User-consent boundary in AGENTS_INSTALL.md: starring spends the user's identity. Must never gain a CLI verb." } },
  // server/management/storage-log-guard-routes
  { method: "GET", path: "/api/storage/codex-logs", module: "server/management/storage-log-guard-routes", mutates: false },
  { method: "POST", path: "/api/storage/codex-logs/compact", module: "server/management/storage-log-guard-routes", mutates: true },
  { method: "POST", path: "/api/storage/codex-logs/protect", module: "server/management/storage-log-guard-routes", mutates: true },
  { method: "POST", path: "/api/storage/codex-logs/repair", module: "server/management/storage-log-guard-routes", mutates: true },
  { method: "POST", path: "/api/storage/codex-logs/unprotect", module: "server/management/storage-log-guard-routes", mutates: true },
  // server/management/system-routes
  // ADR-0008 ownership: GET /api/system/health is Go-owned (ticket #14). The typed marker below
  // is the migration act -- the single forwarding branch in management-api.ts serves this route
  // from the ocx-sidecar when it is attached (spawned from OPENCODEX_GO_SIDECAR_BIN) and the
  // in-process handler otherwise, so system-routes stays the declared owner for the default
  // install. volatileFields is the oracle's normalisation contract: pid and uptime are the
  // sidecar's own process values; everything else must be byte-identical.
  { method: "GET", path: "/api/system/health", module: "server/management/system-routes", mutates: false, go: { volatileFields: ["pid", "uptime"] } },
  { method: "GET", path: "/api/system/memory", module: "server/management/system-routes", mutates: false },
  { method: "GET", path: "/api/system/windows-replace-retries", module: "server/management/system-routes", mutates: false },
  { method: "POST", path: "/api/system/restart", module: "server/management/system-routes", mutates: true },
  // --- Routes an equality scan of their own file cannot see (18). ---
  // Each carries `mechanism`; the reconciliation test counts these separately.
  { method: "GET", path: "/api/storage", module: "server/management/storage-log-guard-routes", mutates: false, mechanism: "negated-guard" },
  { method: "GET", path: "/api/routing-analytics", module: "server/management/routing-analytics-routes", mutates: false, mechanism: "negated-guard" },
  { method: "GET", path: "/api/system/codex-app-server", module: "server/management/system-routes", mutates: false, mechanism: "path-constant" },
  { method: "POST", path: "/api/system/codex-restart", module: "server/management/system-routes", mutates: true, mechanism: "path-constant" },
  { method: "POST", path: "/api/providers/reload", module: "server/management/provider-routes", mutates: true, mechanism: "path-constant", exempt: { reason: "capability-principal", why: "Gated on the local-provider-reload-capability principal (provider-routes.ts:467), not an operator action." } },
  { method: "GET", path: "/api/client-integrations/{clientId}", module: "server/management/integration-routes", mutates: false, mechanism: "prefix-decode" },
  { method: "PUT", path: "/api/client-integrations/{clientId}", module: "server/management/integration-routes", mutates: true, mechanism: "prefix-decode" },
  { method: "GET", path: "/api/request-history/{id}", module: "server/management/request-history-routes", mutates: false, mechanism: "slice" },
  { method: "GET", path: "/api/request-history/{id}/route-decision", module: "server/management/request-history-routes", mutates: false, mechanism: "ends-with" },
  { method: "PUT", path: "/api/providers/{provider}/alias", module: "server/management/model-routes", mutates: true, mechanism: "regex" },
  { method: "PUT", path: "/api/providers/{provider}/model-aliases", module: "server/management/model-routes", mutates: true, mechanism: "regex" },
  { method: "PUT", path: "/api/custom-models/{id}", module: "server/management/model-routes", mutates: true, mechanism: "regex" },
  { method: "DELETE", path: "/api/custom-models/{id}", module: "server/management/model-routes", mutates: true, mechanism: "regex" },
  { method: "GET", path: "/api/lab/subjects/{id}", module: "server/management/lab-routes", mutates: false, mechanism: "regex", exempt: { reason: "local-transport", why: "ocx lab reads the same rows from the local SQLite projection; src/cli/lab.ts imports ../lab/query directly and never fetches /api/lab." } },
  { method: "GET", path: "/api/lab/events/{id}", module: "server/management/lab-routes", mutates: false, mechanism: "regex", exempt: { reason: "local-transport", why: "ocx lab reads the same rows from the local SQLite projection; src/cli/lab.ts imports ../lab/query directly and never fetches /api/lab." } },
  { method: "GET", path: "/api/lab/artifacts/{digest}", module: "server/management/lab-routes", mutates: false, mechanism: "regex", exempt: { reason: "local-transport", why: "ocx lab reads the same rows from the local SQLite projection; src/cli/lab.ts imports ../lab/query directly and never fetches /api/lab." } },
  { method: "POST", path: "/api/lab/automation/runs/{id}/cancel", module: "server/management/lab-automation-routes", mutates: true, mechanism: "regex", exempt: { reason: "deferred-verb", why: "Lab automation run cancellation has no CLI verb yet. A local SQLite read cannot drive it, so local-transport does not apply.", owner: "wp7", ownerDoc: "devlog/_plan/260828_ocx_agentic_control/060_phase_gui_parity.md" } },
];

/**
 * The declared Go-owned surface (ADR-0008): exactly the read routes whose
 * `go` marker is flipped. This is the single data source the forwarding branch
 * and the differential oracle read, so migrating another read route is a
 * marker flip here plus the matching Go handler and oracle coverage -- never a
 * second dispatch edit. Read-only by construction: the write arm of the union
 * cannot carry a `go` declaration, and this filter re-checks at runtime.
 */
export const GO_OWNED_MANAGEMENT_ROUTES: readonly GoOwnedManagementRoute[] = MANAGEMENT_ROUTES.filter(
  (route): route is GoOwnedManagementRoute => route.mutates === false && route.go !== undefined,
);

/**
 * Dispatch lookup for the single forwarding branch: the declared Go-owned
 * route for an exact (method, pathname), or undefined when the request is not
 * part of the migrated surface. Non-literal (parameterised) routes cannot be
 * Go-owned today, which is why the lookup is an exact-match scan over a list
 * that is at most a few entries long.
 */
export function findGoOwnedManagementRoute(
  method: HttpMethod,
  pathname: string,
): GoOwnedManagementRoute | undefined {
  return GO_OWNED_MANAGEMENT_ROUTES.find(route => route.method === method && route.path === pathname);
}
