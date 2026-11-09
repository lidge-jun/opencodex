/** Production native adapters for the common Home/Child local intent controller. */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExportModel } from "../clients/config-export";
import { loadConfig, mutatePersistedConfig, withConfigMutationLockSync } from "../config";
import { readConfigForAdmittedMutation } from "../config/persisted-mutation";
import { commitClaudeCodeBlock } from "../claude/claude-code-block";
import { localInferenceDestination } from "../lib/local-destinations";
import { persistCommittedDesktopGateway } from "../claude/desktop-gateway-state";
import { captureDesktopAppliedMarker, commitDesktopAppliedMarker } from "../claude/desktop-applied-marker";
import { localClientSyncAllowed } from "../codex/desired-state";
import { materializeRouteIntent, type RouteClientOutcome, type RouteIntentApplyInput, type RouteIntentReceipt } from "../integrations/route-intent";
import type { HomeRouteIntentDocument, RouteClientId, RouteClientIntent } from "../link/route-intent";
import type { OcxConfig } from "../types";
import { assertNoClientDisconnectPending, readClientConnectionState, sameClientConnectionOwner } from "./state";
import { withClientLifecycle, withClientLifecycleSync, type ClientLifecycleLockDeps } from "./lifecycle-lock";
import { assertRouteIntentPort } from "./sync-runtime";
import { resolveApiSurfaceSettings } from "../protocols/settings";
import { nativeIntentFields, prepareNativeIntentWrite, publishNativeIntentWrite } from "./route-intent-native-originals";

export interface LocalRouteIntentOptions extends Pick<RouteIntentApplyInput,
  "overwriteConflict" | "overwriteClient" | "beforeWrite" | "statePath" | "store" | "home" | "env" | "now" | "onlyClients" | "retainSkippedOutcomes"> {
  /** Connect/sync already applied the Home's Codex settings through the existing injector. */
  codexApplied?: boolean;
  lifecycleLockDeps?: ClientLifecycleLockDeps;
  /** The native client a Home write is deciding; only it may change a Home native switch. */
  decidedClient?: RouteClientId;
}

/**
 * The Home's own native switch, read rather than decided by this apply (a sync, or a write for
 * another client). It is never rewritten here; only the client's owned artifacts follow it.
 */
function liveHomeSwitch(document: HomeRouteIntentDocument, client: RouteClientId, options: LocalRouteIntentOptions): boolean {
  return document.sources[client] === "native" && options.decidedClient !== client && readClientConnectionState().kind !== "connected";
}

/**
 * An enabled Home Grok or Desktop switch nobody is deciding right now gets exactly the startup
 * behavior: Grok follows the startup gate and Desktop only refreshes a gateway profile OpenCodex
 * already owns. The outcome is "current": the switch is satisfied without creating anything.
 */
function implicitHomeIntent(document: HomeRouteIntentDocument, client: RouteClientId, intent: RouteClientIntent, options: LocalRouteIntentOptions): boolean {
  return intent.enabled && liveHomeSwitch(document, client, options);
}
const IMPLICIT_DESKTOP_MESSAGE = "No OpenCodex-owned Claude Desktop profile to refresh; choose ocx route to claude-desktop on to create one";

/**
 * First-party Desktop already routes through OpenCodex, so an enabled intent is satisfied without
 * a write. Turning it off changes the Desktop mode, which only its own transaction may do.
 */
function firstPartyDesktopOutcome(enabled: boolean, target?: string): RouteClientOutcome {
  const base = { client: "claude-desktop" as const, ...(target === undefined ? {} : { target }) };
  if (enabled) return { ...base, outcome: "current", message: "Claude Desktop first-party mode already routes through OpenCodex" };
  const command = readClientConnectionState().kind === "connected"
    ? "switch modes with ocx claude desktop apply --gateway, then run ocx route to sync"
    : "turn it off with ocx integrations native claude-desktop off";
  return { ...base, outcome: "conflict", message: `Claude Desktop is in first-party mode; ${command}` };
}

/**
 * Caller holds the lifecycle fence; the config coordinator rechecks guard before each commit.
 * `recordStandalone` is true only for a Child's link write: it records the standalone value
 * write-ahead so disconnect or a failed enrollment can restore it. Home writes are the
 * operator's own decisions and are not recorded.
 */
export function persistNativeRouteIntent(client: "codex" | "claude" | "claude-desktop" | "grok", enabled: boolean, guard: () => void, snapshot: OcxConfig,
  recordStandalone: boolean): OcxConfig {
  const now = new Date();
  const apply = (config: OcxConfig): boolean => {
    const previous = client === "claude" ? config.claudeCode?.enabled !== false : config.clientIntegrations?.[client] !== false;
    if (previous === enabled) return false;
    if (client === "claude") {
      // The legacy flag also supplied the shared Messages API default. A local opt-out
      // must preserve that preexisting exposure for other devices and Desktop clients.
      if (!enabled && resolveApiSurfaceSettings(config).messages.source === "claude-code-legacy") {
        config.apiSurfaces = { ...config.apiSurfaces, messages: { enabled: resolveApiSurfaceSettings(config).messages.enabled } };
      }
      commitClaudeCodeBlock(config, { ...config.claudeCode, enabled }, now);
    }
    else config.clientIntegrations = { ...config.clientIntegrations, [client]: enabled };
    return true;
  };
  const result = withConfigMutationLockSync(() => {
    let recorded = false;
    if (recordStandalone) {
      guard();
      const base = readConfigForAdmittedMutation(), planned = structuredClone(base);
      if (apply(planned)) recorded = prepareNativeIntentWrite(nativeIntentFields(base), nativeIntentFields(planned));
    }
    const outcome = mutatePersistedConfig(config => {
      guard();
      return { changed: apply(config), value: config };
    });
    if (outcome.status !== "unavailable" && recorded) publishNativeIntentWrite(nativeIntentFields(outcome.value));
    return outcome;
  });
  if (result.status === "unavailable") throw new Error(`Local native route intent could not be persisted (${result.reason})`);
  if (client === "claude") {
    snapshot.claudeCode = { ...snapshot.claudeCode, enabled,
      ...(result.value.claudeCode?.authModeMigratedAt ? { authModeMigratedAt: result.value.claudeCode.authModeMigratedAt } : {}) };
    if (result.value.apiSurfaces?.messages !== undefined) snapshot.apiSurfaces = { ...snapshot.apiSurfaces, messages: { ...result.value.apiSurfaces.messages } };
  }
  else if (result.value.clientIntegrations) snapshot.clientIntegrations = { ...result.value.clientIntegrations };
  else delete snapshot.clientIntegrations;
  return result.value;
}

async function applyNative(
  input: RouteIntentApplyInput, options: LocalRouteIntentOptions, client: "codex" | "claude" | "claude-desktop" | "grok", intent: RouteClientIntent,
): Promise<RouteClientOutcome> {
  const guard = input.beforeWrite!;
  const home = input.home ?? homedir();
  const env = input.env ?? process.env;
  const desktopMode = client === "claude-desktop" ? await import("../claude/desktop-first-party") : undefined;
  const homeSwitch = liveHomeSwitch(input.document, client, options);
  // The committed flag reaches the caller's working snapshot too. The management owner mirrors
  // these individual flags onto its live config; a copied request config cannot do that for it.
  const committedConfig = withClientLifecycleSync(() => withConfigMutationLockSync(() => {
    guard();
    if (desktopMode) {
      const current = loadConfig();
      if (desktopMode.resolveClaudeDesktopMode(current, desktopMode.observeClaudeDesktopMode(current)) === "first-party") return null;
    }
    if (homeSwitch) return loadConfig();
    // Only a connected Child's write displaces a standalone value; the Home owns its own flags.
    return persistNativeRouteIntent(client, intent.enabled, guard, input.config, readClientConnectionState().kind === "connected");
  }), options.lifecycleLockDeps);
  if (committedConfig === null) return firstPartyDesktopOutcome(intent.enabled);
  if (client === "codex") {
    const { getCodexHome, CODEX_CONFIG_PATH, DEFAULT_CATALOG_PATH } = await import("../codex/paths");
    const { injectCodexConfig, restoreNativeCodexAsync, currentExternalCodexModelProvider, isCodexRoutingInjected } = await import("../codex/inject");
    const target = CODEX_CONFIG_PATH;
    guard();
    if (!existsSync(getCodexHome())) return { client, target, outcome: intent.enabled ? "not_installed" : "current" };
    if (intent.enabled && options.codexApplied) return { client, target, outcome: "current" };
    const externalProvider = currentExternalCodexModelProvider();
    if (externalProvider) {
      const { approvedCodexProviders } = await import("../codex/provider-routing");
      if (!approvedCodexProviders().includes(externalProvider)) return { client, target, outcome: intent.enabled ? "conflict" : "current", message: "Codex has an external provider" };
    }
    if (!intent.enabled && !isCodexRoutingInjected()) return { client, target, outcome: "current" };
    const config = committedConfig;
    if (!intent.enabled) {
      const result = await restoreNativeCodexAsync({ withWriteGuard: work => withConfigMutationLockSync(() => { guard(); return work(); }) });
      return { client, target, outcome: result.success ? "current" : "failed", message: result.message };
    }
    const state = readClientConnectionState();
    const result = await injectCodexConfig(input.config.port, { ...config, syncResumeHistory: false }, {
      catalogPath: DEFAULT_CATALOG_PATH, beforeClientWrite: guard,
      ...(state.kind === "connected" ? { journalOwner: { kind: "client" as const, apiKeyId: state.value.apiKeyId },
        routingTarget: { baseUrl: `http://127.0.0.1:${input.config.port}/v1`, requiresAdmissionToken: false, tokenEnv: "OPENCODEX_API_AUTH_TOKEN" as const } } : {}),
    });
    return { client, target, outcome: result.success && result.status !== "skipped" ? "current" : "failed", message: result.message };
  }
  if (client === "claude") {
    const target = env.CLAUDE_CONFIG_DIR || join(home, ".claude");
    if (!existsSync(target)) return { client, target, outcome: intent.enabled ? "not_installed" : "current" };
    if (!intent.enabled) {
      const { injectClaudeAgentDefs } = await import("../claude/agents-inject");
      const cleaned = withClientLifecycleSync(() => { guard(); return injectClaudeAgentDefs(committedConfig, {}, target); }, options.lifecycleLockDeps);
      if (cleaned === null) return { client, target, outcome: "failed", message: "Owned Claude agent definitions could not be removed" };
    }
    // Claude Code uses the existing launcher and selectedClients gate; no foreign config is copied.
    return { client, target, outcome: "current" };
  }
  if (client === "grok") {
    const { injectGrokConfig, stripGrokConfig } = await import("../grok/inject");
    const { inspectGrokConfig } = await import("../grok/inspect");
    const grokHome = env.GROK_HOME || join(home, ".grok");
    const target = join(grokHome, "config.toml");
    if (implicitHomeIntent(input.document, client, intent, options) && !localClientSyncAllowed(input.config)) {
      return { client, target, outcome: "current", message: "Grok sync is gated on this Home, as it is at startup" };
    }
    return withClientLifecycleSync(() => withConfigMutationLockSync(() => {
      guard();
      const state = inspectGrokConfig({ grokHome });
      if (state.kind === "not_installed") return { client, target, outcome: intent.enabled ? "not_installed" : "current" };
      if (state.kind === "orphaned_marker") return { client, target, outcome: "conflict", message: "Grok managed block is incomplete" };
      if (!intent.enabled && state.kind === "absent") return { client, target, outcome: "current" };
      const destination = localInferenceDestination(input.config, input.config.port);
      if (intent.enabled && destination.requiresAdmissionToken) return { client, target, outcome: "failed", message: "Grok requires a credential-free local listener" };
      const result = intent.enabled ? injectGrokConfig(destination.port, input.models.map(model => ({
        id: model.namespaced, name: model.displayName, contextWindow: model.contextWindow,
        reasoningEfforts: model.reasoningEfforts, defaultReasoningEffort: model.defaultReasoningEffort,
      })), { grokHome, hostname: "127.0.0.1" }) : stripGrokConfig({ grokHome });
      return { client, target, outcome: result.ok && !result.skippedReason ? "current" : "failed", message: result.message };
    }), options.lifecycleLockDeps);
  }
  const desktop = await import("../claude/desktop-3p");
  guard();
  // The durable marker: a caller's snapshot can predate a Desktop apply by another process.
  const inspected = desktop.inspectDesktop3pConfigLibrary({ appliedFingerprint: committedConfig.claudeCode?.desktopProfile?.appliedFingerprint });
  const target = inspected.selectedProfilePath ?? inspected.libraryPath;
  if (inspected.kind === "not_installed") return { client, target, outcome: intent.enabled ? "not_installed" : "current" };
  const state = readClientConnectionState();
  // Connected profiles carry their own owner/projection evidence, not the standalone marker.
  if (!intent.enabled && state.kind === "connected") {
    guard();
    const result = desktop.removeDesktop3pStandardPivot({ lifecycleLockDeps: options.lifecycleLockDeps });
    return { client, target, outcome: result.ok ? "current" : result.reason === "conflict" ? "conflict" : "failed" };
  }
  const firstParty = (config: OcxConfig) => desktopMode!.resolveClaudeDesktopMode(config, desktopMode!.observeClaudeDesktopMode(config)) === "first-party";
  const modeConflict: RouteClientOutcome = { client, target, outcome: "conflict", message: "Claude Desktop first-party mode needs its existing mode-switch transaction" };
  if (intent.enabled && state.kind === "connected") {
    const { applyRemoteDesktopStore } = await import("../claude/desktop-remote-store");
    const { readServiceApiTokenState } = await import("../lib/service-secrets");
    const models = desktop.generateDesktop3pModels(input.models.filter(model => model.native).map(model => model.id),
      input.models.filter(model => !model.native).map(model => ({ provider: model.provider, id: model.id, contextWindow: model.contextWindow })));
    return withClientLifecycleSync(held => withConfigMutationLockSync(() => {
      guard();
      if (firstParty(loadConfig())) return firstPartyDesktopOutcome(true, target);
      const token = readServiceApiTokenState();
      if (token.kind !== "present") return { client, target, outcome: "failed", message: "Child service credential is unavailable" };
      const result = applyRemoteDesktopStore(held, {
        owner: { serverUrl: state.value.serverUrl, apiKeyId: state.value.apiKeyId, connectedAt: state.value.connectedAt },
        expectedTokenFingerprint: token.fingerprint, baseUrl: `http://127.0.0.1:${input.config.port}`,
        apiKey: "opencodex-loopback", mode: "static", models, localListener: true, overwriteConflict: options.overwriteConflict,
      });
      return { client, target: result.ok ? result.path ?? target : target, outcome: result.ok ? "current" : result.reason === "conflict" ? "conflict" : "failed" };
    }), options.lifecycleLockDeps);
  }
  if (!intent.enabled && inspected.kind === "no_owned_state") return { client, target, outcome: "current" };
  const appliedFingerprint = committedConfig.claudeCode?.desktopProfile?.appliedFingerprint;
  const refreshOnly = implicitHomeIntent(input.document, client, intent, options);
  const changedProfile = ["unsafe", "broken", "gateway_drifted"].includes(inspected.kind);
  if (changedProfile && refreshOnly) {
    // Only an OpenCodex-owned profile can have changed under a refresh. An unreadable library or one
    // selecting another app's profile was never ours, so the refresh has nothing to do there.
    const owned = inspected.ownedProfileActive === true || (inspected.ownedProfileActive === null && !!appliedFingerprint);
    if (!owned) return { client, target, outcome: "current", message: IMPLICIT_DESKTOP_MESSAGE };
    // A refresh never takes over a changed profile, even with overwrite: that is a decided write.
    return { client, target, outcome: "conflict",
      message: "Claude Desktop ownership or profile changed; replace it with ocx route to claude-desktop on --device home --overwrite-conflict" };
  }
  if (changedProfile && !options.overwriteConflict) return { client, target, outcome: "conflict", message: "Claude Desktop ownership or profile changed" };
  // Only an absent or untouched profile satisfies a refresh-only switch.
  if (refreshOnly && (inspected.kind !== "gateway_ours" || !appliedFingerprint)) return { client, target, outcome: "current", message: IMPLICIT_DESKTOP_MESSAGE };
  if (!intent.enabled) {
    guard();
    const result = desktop.removeDesktop3pStandardPivot({ appliedFingerprint: committedConfig.claudeCode?.desktopProfile?.appliedFingerprint, lifecycleLockDeps: options.lifecycleLockDeps });
    return { client, target, outcome: result.ok ? "current" : "failed" };
  }
  const { getClaudePickerController } = await import("../claude/intercept/runtime");
  const { runDesktopTransition } = await import("../claude/desktop-picker");
  // Mode switches share picker exclusion in-process and L→C across CLI/server writers.
  // Keep the file write and marker together, reusing the existing writer with this lease.
  return runDesktopTransition<RouteClientOutcome>(getClaudePickerController(), async () => withClientLifecycleSync(held => withConfigMutationLockSync(() => {
    guard();
    const config = loadConfig();
    if (firstParty(config)) return firstPartyDesktopOutcome(true, target);
    const profile = config.claudeCode?.desktopProfile;
    const result = desktop.writeDesktop3pConfig(input.config.port,
      input.models.filter(model => model.native).map(model => model.id),
      input.models.filter(model => !model.native).map(model => ({ provider: model.provider, id: model.id, contextWindow: model.contextWindow })),
      undefined, "static", profile, undefined, options.lifecycleLockDeps,
      refreshOnly ? { appliedFingerprint: appliedFingerprint!, admit: () => !firstParty(loadConfig()) } : undefined, held);
    if (refreshOnly && result.reason === "desktop_refresh_only_skipped") return { client, target, outcome: "current", message: IMPLICIT_DESKTOP_MESSAGE };
    if (!result.written) return { client, target, outcome: "failed", message: result.reason ?? "Claude Desktop writer refused" };
    guard();
    if (firstParty(loadConfig())) return modeConflict;
    if (refreshOnly) {
      // A refresh keeps the existing mode; only the applied marker follows the new bytes.
      const marked = commitDesktopAppliedMarker(captureDesktopAppliedMarker(profile), result.fingerprint!);
      return { client, target, outcome: marked.status !== "unavailable" && marked.value ? "current" : "failed" };
    }
    const recorded = persistCommittedDesktopGateway(config, config.claudeCode?.desktopProfile, result.fingerprint, current => !firstParty(current));
    return { client, target, outcome: recorded.ok ? "current" : "failed" };
  }), options.lifecycleLockDeps), { config: committedConfig });
}

export function materializeLocalRouteIntent(
  config: OcxConfig, document: HomeRouteIntentDocument, models: readonly ExportModel[], options: LocalRouteIntentOptions = {},
): Promise<RouteIntentReceipt> {
  const expected = readClientConnectionState();
  const configuredPort = loadConfig().port;
  const beforeWrite = () => {
    options.beforeWrite?.();
    assertRouteIntentPort(config.port);
    if (loadConfig().port !== configuredPort) throw new Error("client_runtime_changed");
    assertNoClientDisconnectPending();
    const current = readClientConnectionState();
    if (expected.kind === "connected" ? current.kind !== "connected" || !sameClientConnectionOwner(current.value, expected.value)
      : current.kind !== expected.kind || current.kind !== "disconnected") throw new Error("client_connection_changed");
  };
  const input: RouteIntentApplyInput = { config, document: structuredClone(document), models: structuredClone([...models]), ...options, beforeWrite,
    ...(expected.kind === "connected" && expected.value.link ? { linkId: expected.value.link.linkId } : {}),
    localOff: expected.kind === "connected" && expected.value.transport === "link" ? undefined : [] };
  return materializeRouteIntent({ ...input, withFileWrites: work => withClientLifecycle(work, options.lifecycleLockDeps),
    withReceiptWrite: write => withClientLifecycleSync(() => { beforeWrite(); write(); }, options.lifecycleLockDeps),
    applyNative: (client, intent) => applyNative(input, { ...options, overwriteConflict: options.overwriteConflict === true && (options.overwriteClient === undefined || options.overwriteClient === client) }, client, intent) });
}
