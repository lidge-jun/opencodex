import type { HttpMethod } from "./route-registry";

/**
 * Pre-flip transition verdicts for every management read. The route registry
 * remains the inventory authority; this inert ledger makes each route either
 * Go-owned now with a wire fixture or explicitly deferred to the runtime flip.
 * A sidecar must not invent TypeScript process state.
 */
export const READ_SURFACE_DIFF_MATRIX_OWNER_DOC =
  "devlog/_plan/260905_go_sidecar_takeover/032_read_batches_decision_record.md";

export type ReadSurfaceStateSource =
  | "disk"
  | "environment"
  | "os"
  | "serving-process"
  | "external-state";

export type ReadSurfaceTransition = "go-now" | "go-at-flip";

export interface ReadSurfaceDiffMatrixEntry {
  readonly method: HttpMethod;
  readonly path: string;
  readonly module: string;
  readonly transition: ReadSurfaceTransition;
  readonly stateSources: readonly ReadSurfaceStateSource[];
  readonly parityFixture?: "default-get";
  readonly rationale?: string;
}

interface DeferredReadSurfaceFamily {
  readonly module: string;
  readonly stateSources: readonly ReadSurfaceStateSource[];
  readonly rationale: string;
  readonly routes: ReadonlyArray<readonly [HttpMethod, string]>;
}

const deferred = (families: readonly DeferredReadSurfaceFamily[]): readonly ReadSurfaceDiffMatrixEntry[] =>
  families.flatMap(family => family.routes.map(([method, path]) => ({
    method,
    path,
    module: family.module,
    transition: "go-at-flip" as const,
    stateSources: family.stateSources,
    rationale: family.rationale,
  })));

const flip = "The response includes TypeScript serving-process state, cached discovery, or an external subsystem whose byte contract belongs to the Go serving binary at the runtime flip; a pre-flip sidecar must not invent a snapshot.";
const lab = "Compatibility Lab parameterised reads remain at the runtime flip because exact route ownership cannot safely claim them; literal reads use the parent SQLite bridge so Go owns their public transport without a second projection implementation.";

export const READ_SURFACE_DIFF_MATRIX: readonly ReadSurfaceDiffMatrixEntry[] = [
  { method: "GET", path: "/api/system/health", module: "server/management/system-routes", transition: "go-now", stateSources: ["environment", "serving-process"], parityFixture: "default-get" },
  { method: "GET", path: "/api/shadow-call-settings", module: "server/management/config-routes", transition: "go-now", stateSources: ["disk"], parityFixture: "default-get" },
  { method: "GET", path: "/api/custom-models", module: "server/management/model-routes", transition: "go-now", stateSources: ["disk"], parityFixture: "default-get" },
  { method: "GET", path: "/api/model-discovery", module: "server/management/model-routes", transition: "go-now", stateSources: ["disk"], parityFixture: "default-get" },
  // The Go handler owns the public route but bridges the parent-owned quota
  // cache until the flip; ticket #20's dedicated parity vectors cover refresh.
  { method: "GET", path: "/api/provider-quotas", module: "server/management/provider-routes", transition: "go-now", stateSources: ["serving-process", "external-state"], parityFixture: "default-get" },
  { method: "GET", path: "/api/usage", module: "server/management/logs-usage-routes", transition: "go-now", stateSources: ["disk", "serving-process"], parityFixture: "default-get" },
  ...["/api/lab/automation", "/api/lab/automation/runs"].map(path => ({ method: "GET" as const, path, module: "server/management/lab-automation-routes", transition: "go-now" as const, stateSources: ["disk", "serving-process"] as const, parityFixture: "default-get" as const })),
  ...["/api/lab/artifacts", "/api/lab/catalog", "/api/lab/events", "/api/lab/observations", "/api/lab/production-signals", "/api/lab/public/community", "/api/lab/status", "/api/lab/subjects", "/api/lab/verdicts"].map(path => ({ method: "GET" as const, path, module: "server/management/lab-routes", transition: "go-now" as const, stateSources: ["disk", "serving-process"] as const, parityFixture: "default-get" as const })),
  ...deferred([
    { module: "codex/auth-api", stateSources: ["disk", "serving-process", "external-state"], rationale: flip, routes: [["GET", "/api/codex-auth/accounts"], ["GET", "/api/codex-auth/active"], ["GET", "/api/codex-auth/login-status"], ["GET", "/api/codex-auth/quota"], ["GET", "/api/codex-auth/reset-credits"]] },
    { module: "codex/native-profile-api", stateSources: ["disk", "os", "serving-process"], rationale: flip, routes: [["GET", "/api/native-main-profiles"], ["GET", "/api/native-main-profiles/doctor"]] },
    { module: "server/management/agent-settings-routes", stateSources: ["disk", "serving-process", "external-state"], rationale: flip, routes: [["GET", "/api/claude-code"], ["GET", "/api/claude-desktop"], ["GET", "/api/claude-desktop/status"], ["GET", "/api/codex-auth/features/default-mode-request-user-input"], ["GET", "/api/effort-caps"], ["GET", "/api/grok"], ["GET", "/api/injection-model"], ["GET", "/api/subagent-model-fallback"], ["GET", "/api/subagent-models"], ["GET", "/api/v2"]] },
    { module: "server/management/codex-prompt-routes", stateSources: ["disk", "serving-process"], rationale: flip, routes: [["GET", "/api/codex-prompt"], ["GET", "/api/codex-prompt/text"]] },
    { module: "server/management/combo-routes", stateSources: ["disk", "serving-process"], rationale: flip, routes: [["GET", "/api/combos"]] },
    { module: "server/management/config-routes", stateSources: ["disk", "os", "serving-process", "external-state"], rationale: flip, routes: [["GET", "/api/config"], ["GET", "/api/diagnostics/project-config"], ["GET", "/api/settings"], ["GET", "/api/sidecar-settings"], ["GET", "/api/startup-health"], ["GET", "/api/update/check"], ["GET", "/api/update/status"], ["GET", "/api/windows-tray"]] },
    { module: "server/management/integration-routes", stateSources: ["disk", "serving-process", "external-state"], rationale: flip, routes: [["GET", "/api/client-integrations"], ["GET", "/api/client-integrations/journal"], ["GET", "/api/client-integrations/{clientId}"]] },
    { module: "server/management/lab-routes", stateSources: ["disk", "serving-process"], rationale: lab, routes: [["GET", "/api/lab/subjects/{id}"], ["GET", "/api/lab/events/{id}"], ["GET", "/api/lab/artifacts/{digest}"]] },
    { module: "server/management/logs-usage-routes", stateSources: ["disk", "serving-process"], rationale: flip, routes: [["GET", "/api/claude/inbound-debug"], ["GET", "/api/debug"], ["GET", "/api/debug/injection-logs"], ["GET", "/api/debug/logs"], ["GET", "/api/debug/usage-logs"], ["GET", "/api/logs"], ["GET", "/api/storage/cleanup-policy"], ["GET", "/api/storage/cleanup-policy/test-stream"], ["GET", "/api/storage/trash"], ["GET", "/api/storage/trash/restore/test-stream"]] },
    { module: "server/management/model-routes", stateSources: ["disk", "serving-process", "external-state"], rationale: flip, routes: [["GET", "/api/aliases"], ["GET", "/api/catalog"], ["GET", "/api/client-config"], ["GET", "/api/model-presets"], ["GET", "/api/models"], ["GET", "/api/selected-models"]] },
    { module: "server/management/native-integration-routes", stateSources: ["disk", "serving-process", "external-state"], rationale: flip, routes: [["GET", "/api/native-integrations"]] },
    { module: "server/management/cursor-integration-routes", stateSources: ["disk", "serving-process", "external-state"], rationale: flip, routes: [["GET", "/api/native-integrations/cursor"]] },
    { module: "server/management/oauth-account-routes", stateSources: ["disk", "os", "serving-process", "external-state"], rationale: flip, routes: [["GET", "/api/key-providers"], ["GET", "/api/keys"], ["GET", "/api/oauth/accounts"], ["GET", "/api/oauth/accounts/pool"], ["GET", "/api/oauth/providers"], ["GET", "/api/oauth/status"], ["GET", "/api/providers/keys"], ["GET", "/api/providers/keychain"]] },
    { module: "server/management/provider-routes", stateSources: ["disk", "serving-process", "external-state"], rationale: flip, routes: [["GET", "/api/provider-context-caps"], ["GET", "/api/provider-presets"], ["GET", "/api/provider-request-pacing"], ["GET", "/api/providers"]] },
    { module: "server/management/request-history-routes", stateSources: ["disk", "serving-process"], rationale: flip, routes: [["GET", "/api/request-history"], ["GET", "/api/request-history/{id}"], ["GET", "/api/request-history/{id}/route-decision"]] },
    { module: "server/management/routing-profile-routes", stateSources: ["disk", "serving-process"], rationale: flip, routes: [["GET", "/api/routing-profiles"]] },
    { module: "server/management/sidebar-routes", stateSources: ["serving-process", "external-state"], rationale: flip, routes: [["GET", "/api/github/star"], ["GET", "/api/update/badge"]] },
    { module: "server/management/storage-log-guard-routes", stateSources: ["disk", "os", "serving-process"], rationale: flip, routes: [["GET", "/api/storage/codex-logs"], ["GET", "/api/storage"]] },
    { module: "server/management/system-routes", stateSources: ["os", "serving-process"], rationale: flip, routes: [["GET", "/api/system/memory"], ["GET", "/api/system/windows-replace-retries"], ["GET", "/api/system/codex-app-server"]] },
    { module: "server/management/routing-analytics-routes", stateSources: ["disk", "serving-process"], rationale: flip, routes: [["GET", "/api/routing-analytics"]] },
  ]),
];
