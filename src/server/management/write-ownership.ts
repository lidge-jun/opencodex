import type { HttpMethod } from "./route-registry";

/**
 * Write-ownership ledger: family-level deferral verdicts for the mutating
 * routes that are neither Go-owned nor exempted in the registry (devlog 035).
 *
 * The registry records the two "claimed" states (a `go` marker, an `exempt`
 * reason). This module records the third state explicitly: DEFERRED, one
 * family per owning module, with the reason at family granularity -- the same
 * deferral shape the read surface keeps in devlog 032, made machine-checked
 * here so a mutating route can never be silently plain again.
 *
 * tests/write-surface-ownership.test.ts proves the ledger exactly covers the
 * mutating set that carries neither a `go` marker nor an `exempt`: adding a
 * mutating route without a verdict row fails there, and flipping a deferred
 * route to `go` while its row still exists fails too (the row is no longer
 * "plain"). This module is inert data on the core path: nothing under
 * `management-api.ts` imports it, and it imports nothing but a type.
 */
export const WRITE_SURFACE_DEFERRAL_OWNER_DOC =
  "devlog/_plan/260905_go_sidecar_takeover/035_write_surface_full_parity_gate.md";

export interface WriteSurfaceDeferralFamily {
  readonly module: string;
  readonly why: string;
  readonly routes: ReadonlyArray<{ readonly method: HttpMethod; readonly path: string }>;
}
export const WRITE_SURFACE_DEFERRED_FAMILIES: readonly WriteSurfaceDeferralFamily[] = [
  {
    module: "codex/auth-api",
    why: "Codex-auth account/login surface outside the account-pool verbs batch #23 claimed (active, pool-strategy, clear-cooldown, reset-credits/consume). Login/code/cancel drive device-code + browser sessions whose state lives in the TS process (codexAuthLoginState map, oauth store); accounts CRUD/alias/pause/priority/auto-switch/failover mutate persisted codexAccounts through in-process reconciliation (reconcileCodexActiveAfterExclusion, persistPausedAccounts). The session + reconciliation state is TS-process-owned, so the flip owns this family; the read face of the same module defers for the same reason (devlog 032/030). Deferred explicitly; batch #23 did not claim it and #26 does not migrate.",
    routes: [
      { method: "DELETE", path: "/api/codex-auth/accounts" },
      { method: "POST", path: "/api/codex-auth/accounts" },
      { method: "PUT", path: "/api/codex-auth/accounts/alias" },
      { method: "PUT", path: "/api/codex-auth/accounts/pause" },
      { method: "PUT", path: "/api/codex-auth/accounts/pause-exhausted" },
      { method: "PUT", path: "/api/codex-auth/accounts/priority" },
      { method: "PUT", path: "/api/codex-auth/auto-switch" },
      { method: "PUT", path: "/api/codex-auth/failover" },
      { method: "POST", path: "/api/codex-auth/login" },
      { method: "POST", path: "/api/codex-auth/login/cancel" },
      { method: "POST", path: "/api/codex-auth/login/code" },
    ],
  },
  {
    module: "codex/native-profile-api",
    why: "Native-main profile takeover is a staged state machine living in the TS process: stage/heartbeat/finish/cancel carry stageId + writerToken against an in-process manager, and register/recover/switch orchestrate the running CLI's profile layout (subprocess + file actions). Ownership of the staged-install state machine is the flip's; the read face of this module defers on the same grounds (devlog 032). Deferred explicitly.",
    routes: [
      { method: "POST", path: "/api/native-main-profiles/recover" },
      { method: "POST", path: "/api/native-main-profiles/register" },
      { method: "POST", path: "/api/native-main-profiles/stage" },
      { method: "POST", path: "/api/native-main-profiles/stage/cancel" },
      { method: "POST", path: "/api/native-main-profiles/stage/finish" },
      { method: "POST", path: "/api/native-main-profiles/stage/heartbeat" },
      { method: "POST", path: "/api/native-main-profiles/switch" },
    ],
  },
  {
    module: "server/management-api",
    why: "POST /api/stop terminates the serving process itself; its observable effect is the lifecycle of the TS runtime, which is exactly the state that only the serving process owns. It becomes Go-native at the flip, when the Go binary is the serving process. Deferred explicitly.",
    routes: [
      { method: "POST", path: "/api/stop" },
    ],
  },
  {
    module: "server/management/agent-settings-routes",
    why: "Agent-settings PUTs/apply verbs persist config.json and then fan out into process-owned convergence (convergeCodexCatalog, syncClaudeAgentDefsBestEffort, autoApplyDesktopBestEffort, runCodexFeaturesCommand) whose result several responses report as catalogRefresh — live convergence the read face of this family defers to the catalog/flip line (devlog 032). These routes were not part of the config-write batch #21 claim set (settings/shadow-call/sidecar-settings), and the catalog-refresh response residue keeps them with the catalog line rather than the pure-config writes. Deferred explicitly.",
    routes: [
      { method: "PUT", path: "/api/claude-code" },
      { method: "PUT", path: "/api/claude-desktop" },
      { method: "POST", path: "/api/claude-desktop/apply" },
      { method: "PUT", path: "/api/codex-auth/features/default-mode-request-user-input" },
      { method: "PUT", path: "/api/effort-caps" },
      { method: "POST", path: "/api/grok/apply" },
      { method: "PUT", path: "/api/grok/selection" },
      { method: "PUT", path: "/api/injection-model" },
      { method: "PUT", path: "/api/subagent-model-fallback" },
      { method: "PUT", path: "/api/subagent-models" },
      { method: "PUT", path: "/api/v2" },
    ],
  },
  {
    module: "server/management/combo-routes",
    why: "Combo PUT/DELETE persist config.combos and validate against the live providers + combo model space (comboConfigError with requireEnabledTarget, normalizeComboConfig, clearComboTargetCooldowns, clearComboSelectionState); migration renames resolve through config.providers/model structures the read face still treats as registry/live data (devlog 032). Not claimed by a write batch (#21 config writes claimed the settings trio only); the combo family migrates with the catalog/provider line. Deferred explicitly.",
    routes: [
      { method: "DELETE", path: "/api/combos" },
      { method: "PUT", path: "/api/combos" },
    ],
  },
  {
    module: "server/management/config-routes",
    why: "These four POSTs are process or OS actions, not config writes: startup-action runs OS startup-install actions (runStartupInstallAction), windows-tray drives tray actions (runWindowsTrayAction), update/run executes the updater state machine (update/job), and sync triggers convergeCodexCatalog + syncClaudeAgentDefsBestEffort live convergence. Their effects live in the TS process or the OS; the read face defers the same family (devlog 032: update/status job table, windows-tray platform probe). Deferred explicitly.",
    routes: [
      { method: "POST", path: "/api/startup-action" },
      { method: "POST", path: "/api/sync" },
      { method: "POST", path: "/api/update/run" },
      { method: "POST", path: "/api/windows-tray" },
    ],
  },
  {
    module: "server/management/integration-routes",
    why: "Client-integration mutations run through the mutation-flight subsystem (src/integrations/mutation-flight): journaled multi-step transactions with busy/refusal semantics, undo tags, and persisted per-client journal state that later GETs advertise. A write's effect spans config, an in-process journal, and a busy lock — TS-process-owned transaction state. The module's read side defers for the same reason. Deferred explicitly.",
    routes: [
      { method: "PUT", path: "/api/client-integrations/{clientId}" },
      { method: "POST", path: "/api/client-integrations/restore" },
    ],
  },
  {
    module: "server/management/logs-usage-routes",
    why: "Storage cleanup/preview/policy and trash-restore verbs drive in-process job machinery (runArchivedCleanupJob, previewArchivedCleanup, runRestoreTrashEntryJob, policy-job) mutating the archive filesystem and reporting busy/pinned-thread/fs codes from live job state; debug PUT toggles in-process diagnostics. There is no config post-state to compare and the job/fs semantics are TS-process-owned; the read face already defers the storage family (devlog 032). Deferred explicitly.",
    routes: [
      { method: "PUT", path: "/api/debug" },
      { method: "POST", path: "/api/storage/cleanup" },
      { method: "PUT", path: "/api/storage/cleanup-policy" },
      { method: "POST", path: "/api/storage/cleanup-policy/run" },
      { method: "POST", path: "/api/storage/cleanup/preview" },
      { method: "POST", path: "/api/storage/trash/restore" },
    ],
  },
  {
    module: "server/management/model-routes",
    why: "Model-surface writes persist config.json and then rerun live catalog convergence (convergeCodexCatalog), with several responses reporting catalogRefresh (model-routes.ts). custom-models, presets, visibility, discovery, aliases, disabled/subagent/selected models all resolve through the live converged catalog and provider rows that the read face defers to the catalog store (devlog 032). These are config writes with live-catalog residue, not the pure-config trio batch #21 claimed; they migrate with the catalog line. Deferred explicitly.",
    routes: [
      { method: "POST", path: "/api/custom-models" },
      { method: "DELETE", path: "/api/custom-models/{id}" },
      { method: "PUT", path: "/api/custom-models/{id}" },
      { method: "PUT", path: "/api/default-aliases" },
      { method: "PUT", path: "/api/disabled-models" },
      { method: "PUT", path: "/api/model-discovery" },
      { method: "POST", path: "/api/model-discovery/acknowledge" },
      { method: "PUT", path: "/api/model-presets" },
      { method: "PUT", path: "/api/model-visibility" },
      { method: "PUT", path: "/api/providers/{provider}/alias" },
      { method: "PUT", path: "/api/providers/{provider}/model-aliases" },
      { method: "PUT", path: "/api/selected-models" },
    ],
  },
  {
    module: "server/management/native-integration-routes",
    why: "Native-integration PUTs persist a desired state (setCodexIntegrationEnabled / setGrokIntegrationEnabled) that the process and the external agent's own config reader later converge; the module's own comment documents persist-then-converge ordering so a crash mid-flight still converges on next start. The effect spans config intent, in-process convergence, and external agent state — not a single byte-comparable write, and not claimed by any write batch. Deferred explicitly.",
    routes: [
      { method: "PUT", path: "/api/native-integrations/claude" },
      { method: "PUT", path: "/api/native-integrations/claude-desktop" },
      { method: "PUT", path: "/api/native-integrations/codex" },
      { method: "PUT", path: "/api/native-integrations/grok" },
    ],
  },
  {
    module: "server/management/oauth-account-routes",
    why: "OAuth account/credential surface outside the account-pool verbs batch #23 claimed (oauth accounts active/pool/clear-cooldown). The rest binds TS-process identity state: oauth login/cancel/code run the device-code + browser flow, import and accounts CRUD + logout touch the OAuth account store and live credential state (removeCredential + reconcileLiveStateStores), keys CRUD/rotate/commit and providers/keys + keychain verbs operate OS-keychain-backed secrets with rotation-commit semantics, and accounts/alias mutates the in-process account set. Session/keychain state is the flip's; the module's read face defers for the same reason (devlog 032). Deferred explicitly.",
    routes: [
      { method: "DELETE", path: "/api/keys" },
      { method: "PATCH", path: "/api/keys" },
      { method: "POST", path: "/api/keys" },
      { method: "DELETE", path: "/api/keys/rotate" },
      { method: "POST", path: "/api/keys/rotate" },
      { method: "POST", path: "/api/keys/rotate/commit" },
      { method: "DELETE", path: "/api/oauth/accounts" },
      { method: "PUT", path: "/api/oauth/accounts/alias" },
      { method: "POST", path: "/api/oauth/accounts/import" },
      { method: "POST", path: "/api/oauth/login" },
      { method: "POST", path: "/api/oauth/login/cancel" },
      { method: "POST", path: "/api/oauth/login/code" },
      { method: "POST", path: "/api/oauth/logout" },
      { method: "POST", path: "/api/providers/keychain" },
      { method: "DELETE", path: "/api/providers/keys" },
      { method: "POST", path: "/api/providers/keys" },
      { method: "PUT", path: "/api/providers/keys/active" },
      { method: "PUT", path: "/api/providers/keys/alias" },
    ],
  },
  {
    module: "server/management/provider-routes",
    why: "Provider CRUD writes config.providers and then reloads live provider state through the local-provider-reload contract (capability-principal gated, conflict/namespace validation against the running router); /api/providers/test exercises a live provider. The observable result includes in-process router/provider state the read face still treats as registry data (devlog 032: /api/providers defer-registry/live). Not claimed by a write batch; migrates with the provider/registry line. Deferred explicitly.",
    routes: [
      { method: "PUT", path: "/api/provider-context-caps" },
      { method: "DELETE", path: "/api/providers" },
      { method: "PATCH", path: "/api/providers" },
      { method: "POST", path: "/api/providers" },
      { method: "POST", path: "/api/providers/test" },
    ],
  },
  {
    module: "server/management/routing-profile-routes",
    why: "Routing-profile PUT/DELETE persist config.profiles and validate against the live provider/model selection surface (modelMap, disabled/subagent references, migrateReferences); dry-run evaluates deterministically over that same live surface. The validation model is registry/live data the read face defers (devlog 032). Not claimed by a write batch; migrates with the router-config line. Deferred explicitly.",
    routes: [
      { method: "DELETE", path: "/api/routing-profiles" },
      { method: "PUT", path: "/api/routing-profiles" },
      { method: "POST", path: "/api/routing-profiles/dry-run" },
    ],
  },
  {
    module: "server/management/storage-log-guard-routes",
    why: "Codex-log protect/unprotect/repair/compact mutate filesystem protection state (Codex Log Guard — protectCodexLogs, unprotectCodexLogs, repairCodexLogGuardProtection, compaction) with status codes derived from guard mutation results, not from config. There is no config post-state; the guard's file/protection state is the flip's. Deferred explicitly.",
    routes: [
      { method: "POST", path: "/api/storage/codex-logs/compact" },
      { method: "POST", path: "/api/storage/codex-logs/protect" },
      { method: "POST", path: "/api/storage/codex-logs/repair" },
      { method: "POST", path: "/api/storage/codex-logs/unprotect" },
    ],
  },
  {
    module: "server/management/system-routes",
    why: "System restart and codex-restart orchestrate the running TS server / Codex app-server process lifecycle (CODEX_RESTART_PATH, app-server process management). The mutation's effect is the process lifecycle itself, which only the serving process owns; like POST /api/stop these become Go-native at the flip. Deferred explicitly.",
    routes: [
      { method: "POST", path: "/api/system/codex-restart" },
      { method: "POST", path: "/api/system/restart" },
    ],
  },
];
