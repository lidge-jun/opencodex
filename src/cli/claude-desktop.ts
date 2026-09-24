import { recordCommittedDesktopGateway } from "../claude/desktop-gateway-state";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { getConfigDir } from "../config/paths";
import { loadConfig, mutatePersistedConfig, withConfigMutationLockSync } from "../config";
import { claudeDesktopIntegrationEnabledNow, setIntegrationEnabled } from "../codex/desired-state";
import { readClientConnectionState, assertClientConnectionUnchanged, assertNoClientDisconnectPending, type ClientConnectionState } from "../client/state";
import { downloadDesktop3pModels, HubClientError, normalizeHubOrigin } from "../client/hub-client";
import { readServiceApiTokenState } from "../lib/service-secrets";
import { applyRemoteDesktopStore, type DesktopStoreResult } from "../claude/desktop-remote-store";
import { withClientLifecycleSync, type ClientLifecycleLockDeps } from "../client/lifecycle-lock";
import {
  DESKTOP_FAMILIES,
  moveDesktopRoute,
  parseDesktopProfile,
  setDesktopFamilyDefault,
  type DesktopFamily,
  type DesktopProfile,
} from "../claude/desktop-profile";
import { inspectDesktop3pConfigLibrary, removeDesktop3pStandardPivot, writeDesktop3pConfig, type Desktop3pConfigMode, parseDesktop3pModeArgs } from "../claude/desktop-3p";
import {
  applyDesktopFirstParty,
  captureDesktopFirstPartyRollback,
  isClaudeDesktopMode,
  observeClaudeDesktopMode,
  recordClaudeDesktopMode,
  removeDesktopFirstParty,
  resolveClaudeDesktopMode,
  resolveClaudeDesktopApplyMode,
  type ClaudeDesktopModeObservation,
  type ClaudeDesktopMode,
} from "../claude/desktop-first-party";
import { FIRST_PARTY_ACCOUNT_RISK } from "../claude/desktop-risk";
import { claudeInterceptEnabled } from "../claude/intercept/runtime";
import { ensurePickerCa, pickerCaCertPath, pickerCaFingerprints, pickerLeafCertPath } from "../claude/intercept/picker-ca";
import { inspectPickerTrust, trustPickerCa, untrustPickerCa, type SecurityRunner } from "../claude/intercept/picker-trust";
import { offlinePickerStatus, removeDesktopPickerArtifacts, type DesktopPickerStatus } from "../claude/desktop-picker";
import { claudeDesktopPolicyWarning, probeClaudeDesktopPolicy } from "../claude/desktop-policy";
import { filterCatalogVisibleModels, desktopVisibleNativeSlugs, nativeContextLimits } from "../codex/catalog";
import { buildClaudeDesktopState, fetchAllModels } from "../server/management-api";
import { findLiveProxy } from "../server/proxy-liveness";
import { CliUsageError, RuntimeApiError, runtimeRequest, takeJsonFlag, type RuntimeApiDeps } from "./runtime-api";
import { OPENAI_CODEX_PROVIDER_ID } from "../providers/openai-tiers";
import type { OcxConfig } from "../types";

const APPLY_FLAGS = ["--first-party", "--gateway", "--static", "--hybrid", "--discovery-only"];

function isFamily(value: string | undefined): value is DesktopFamily {
  return !!value && (DESKTOP_FAMILIES as readonly string[]).includes(value);
}

function printDesktopHelp(): void {
  console.log(`Usage:
  ocx claude desktop [apply] [--first-party | --gateway [--static|--hybrid|--discovery-only]]
      --gateway      (default) install the third-party gateway profile for the whole app
      --first-party  keep Desktop on claude.ai; route only the Code tab's Claude Code through the
                     local intercept proxy via ~/.claude/settings.json env. Account risk: this sends
                     Claude subscription traffic through a local interception proxy, and Anthropic
                     may suspend the account.
  ocx claude desktop show [--json]
  ocx claude desktop status [--json]
  ocx claude desktop picker on|off|status|trust
  ocx claude desktop bind <picker-model-id> <provider/model|native/slug>
      first-party: serve a Code tab picker model (e.g. claude-sonnet-4-6) with an opencodex model;
      the picker keeps Anthropic's label, and only Claude Code traffic through the local proxy uses it
  ocx claude desktop unbind <picker-model-id>
  ocx claude desktop move <provider/model> <opus|fable|sonnet|haiku> [--default]
  ocx claude desktop default <family> <provider/model|none>
  ocx claude desktop export <path|->
  ocx claude desktop import <path> [--apply]`);
}

export interface ApplyProfileDeps {
  downloadDesktop3pModelsImpl?: typeof downloadDesktop3pModels;
  applyRemoteDesktopStoreImpl?: typeof applyRemoteDesktopStore;
  lifecycleLockDeps?: ClientLifecycleLockDeps;
  findLiveProxyImpl?: typeof findLiveProxy;
  postApplyImpl?: (
    mode: Desktop3pConfigMode,
    profile: DesktopProfile,
  ) => Promise<{ ok?: boolean; path?: string; error?: string; warning?: string; picker?: DesktopPickerStatus }>;
  runtimeRequestImpl?: typeof runtimeRequest;
  ensurePickerCaImpl?: typeof ensurePickerCa;
  inspectPickerTrustImpl?: typeof inspectPickerTrust;
  trustPickerCaImpl?: typeof trustPickerCa;
  untrustPickerCaImpl?: typeof untrustPickerCa;
  removeDesktopPickerArtifacts?: typeof removeDesktopPickerArtifacts;
  security?: SecurityRunner;
  platform?: NodeJS.Platform;
  probeClaudeDesktopPolicy?: typeof import("../claude/desktop-policy").probeClaudeDesktopPolicy;
}

type DesktopApplyResult = {
  ok: boolean;
  path: string;
  reason?: string;
  warning?: string;
  picker?: DesktopPickerStatus;
  delegated?: boolean;
};

type PickerRouteResponse = {
  ok?: boolean;
  code?: string;
  reason?: string;
  hint?: string;
  picker?: DesktopPickerStatus;
};

function pickerRuntimeRequest<T>(
  path: string,
  init: RequestInit,
  deps: ApplyProfileDeps,
): Promise<T> {
  const request = deps.runtimeRequestImpl ?? runtimeRequest;
  const requestDeps: RuntimeApiDeps = deps.findLiveProxyImpl
    ? { findLiveProxy: deps.findLiveProxyImpl }
    : {};
  return request<T>(path, init, requestDeps);
}

async function liveDesktopProxy(deps: ApplyProfileDeps): Promise<boolean> {
  return !!await (deps.findLiveProxyImpl ?? findLiveProxy)();
}

function persistPickerPreference(value: boolean): boolean {
  const outcome = mutatePersistedConfig(current => {
    const claudeCode = current.claudeCode ?? {};
    const intercept = claudeCode.intercept ?? {};
    if (intercept.picker === value) return { changed: false, value: structuredClone(current.claudeCode) };
    current.claudeCode = { ...claudeCode, intercept: { ...intercept, picker: value } };
    return { changed: true, value: structuredClone(current.claudeCode) };
  });
  return outcome.status !== "unavailable";
}

function pickerTrustPaths(deps: ApplyProfileDeps, configDir = getConfigDir()): { caPath: string; leafPath: string; sha1: string } {
  const ca = (deps.ensurePickerCaImpl ?? ensurePickerCa)(configDir);
  return {
    caPath: pickerCaCertPath(configDir),
    leafPath: pickerLeafCertPath(configDir),
    sha1: pickerCaFingerprints(ca.certPem).sha1,
  };
}

async function trustPickerLocally(deps: ApplyProfileDeps): Promise<{ ok: true; callerAddedTrust: boolean; caPath: string; sha1: string } | { ok: false; reason: string }> {
  try {
    const configDir = getConfigDir();
    const paths = pickerTrustPaths(deps, configDir);
    const inspect = deps.inspectPickerTrustImpl ?? inspectPickerTrust;
    const before = await inspect(paths.leafPath, paths.sha1, deps.security, deps.platform);
    if (before === "trusted") return { ok: true, callerAddedTrust: false, caPath: paths.caPath, sha1: paths.sha1 };
    const trust = await (deps.trustPickerCaImpl ?? trustPickerCa)(paths.caPath, deps.security, deps.platform);
    if (!trust.ok) return { ok: false, reason: trust.reason ?? "trust_declined" };
    return { ok: true, callerAddedTrust: true, caPath: paths.caPath, sha1: paths.sha1 };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : "trust_failed" };
  }
}

async function compensateLocalPickerTrust(
  trust: { callerAddedTrust: boolean; caPath: string; sha1: string },
  deps: ApplyProfileDeps,
): Promise<void> {
  if (!trust.callerAddedTrust) return;
  await (deps.untrustPickerCaImpl ?? untrustPickerCa)(trust.caPath, trust.sha1, deps.security, deps.platform);
}

function printPickerStatus(status: DesktopPickerStatus | undefined, json = false): void {
  if (!status) return;
  if (json) console.log(JSON.stringify(status, null, 2));
  else console.log(`picker: ${JSON.stringify(status)}`);
}

function isAmbiguousPickerTransport(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /timeout|timed out|abort|aborted|lost response|socket hang up|reset/i.test(message);
}

function isAnsweredPickerRefusal(error: unknown): boolean {
  if (!(error instanceof RuntimeApiError)) return false;
  const body = error.body;
  return !!body && typeof body === "object" && ("picker" in body || (body as Record<string, unknown>).code === "picker_proxy_unavailable");
}

/** Persist only the requested local profile, never an await-old whole configuration. */
function saveLocalDesktopProfile(
  profile: DesktopProfile,
  expectedProfile: DesktopProfile | undefined,
  expectedConnection: ClientConnectionState,
  deps: ApplyProfileDeps,
  gatewayWrite?: { fingerprint?: string },
): void {
  withClientLifecycleSync(() => {
    const outcome = mutatePersistedConfig(current => {
      assertNoClientDisconnectPending();
      if (expectedConnection.kind === "connected") {
        assertClientConnectionUnchanged(expectedConnection.value);
        if (expectedConnection.value.pendingOperation) throw new Error("client_rotation_pending");
        const token = readServiceApiTokenState();
        if (token.kind !== "present" || token.fingerprint !== expectedConnection.value.tokenFingerprint) {
          throw new Error("client_token_changed");
        }
      } else if (expectedConnection.kind !== "disconnected" || readClientConnectionState().kind !== "disconnected") {
        throw new Error("client_connection_changed");
      }
      if (JSON.stringify(current.claudeCode?.desktopProfile) !== JSON.stringify(expectedProfile)) {
        throw new Error("desktop_profile_changed");
      }
      if (gatewayWrite) {
        recordCommittedDesktopGateway(current, profile, gatewayWrite.fingerprint, new Date().toISOString());
        return { changed: true, value: undefined };
      }
      const changed = JSON.stringify(current.claudeCode?.desktopProfile) !== JSON.stringify(profile);
      if (changed) current.claudeCode = { ...(current.claudeCode ?? {}), desktopProfile: structuredClone(profile) };
      return { changed, value: undefined };
    });
    if (outcome.status === "unavailable") throw new Error("desktop_profile_save_unavailable");
  }, deps.lifecycleLockDeps);
}

async function applyConnectedDesktopProfile(
  mode: Desktop3pConfigMode,
  connection: Extract<ClientConnectionState, { kind: "connected" }>,
  deps: ApplyProfileDeps,
): Promise<{ ok: boolean; path: string; reason?: string; warning?: string }> {
  try {
    const token = withClientLifecycleSync(() => withConfigMutationLockSync(() => {
      assertClientConnectionUnchanged(connection.value);
      if (connection.value.pendingOperation) throw new Error("client_rotation_pending");
      const current = readServiceApiTokenState();
      if (current.kind === "absent") throw new Error("client_token_absent");
      if (current.kind === "unsafe") throw new Error("client_token_unsafe");
      if (current.fingerprint !== connection.value.tokenFingerprint) {
        throw new Error("client_token_mismatch");
      }
      const desired = setIntegrationEnabled("claude-desktop", true);
      if (!desired.ok) throw new Error("desktop_desired_state_write_failed");
      return current;
    }), deps.lifecycleLockDeps);
    const baseUrl = normalizeHubOrigin(connection.value.serverUrl);
    let snapshot: Awaited<ReturnType<typeof downloadDesktop3pModels>>;
    try {
      snapshot = await (deps.downloadDesktop3pModelsImpl ?? downloadDesktop3pModels)(baseUrl, token.token);
    } catch (error) {
      return { ok: false, path: "", reason: error instanceof HubClientError ? error.code : "desktop_download_failed" };
    }
    const result: DesktopStoreResult = withClientLifecycleSync(held => withConfigMutationLockSync(() => {
      assertClientConnectionUnchanged(connection.value);
      const currentToken = readServiceApiTokenState();
      if (currentToken.kind !== "present" || currentToken.fingerprint !== connection.value.tokenFingerprint) {
        throw new Error("client_connection_changed");
      }
      if (!claudeDesktopIntegrationEnabledNow()) throw new Error("desired_state_changed");
      if (snapshot.models.length === 0) throw new Error("desktop_unavailable");
      return (deps.applyRemoteDesktopStoreImpl ?? applyRemoteDesktopStore)(held, {
        owner: { serverUrl: connection.value.serverUrl, apiKeyId: connection.value.apiKeyId, connectedAt: connection.value.connectedAt },
        expectedTokenFingerprint: currentToken.fingerprint,
        baseUrl, apiKey: currentToken.token, mode, models: snapshot.models,
      });
    }), deps.lifecycleLockDeps);
    if (!result.ok) return { ok: false, path: "", reason: `desktop_lifecycle_${result.reason}` };
    // Policy probes may spawn a process; perform them only after L/C have been released.
    const policyWarning = claudeDesktopPolicyWarning((deps.probeClaudeDesktopPolicy ?? probeClaudeDesktopPolicy)());
    const fallbackWarning = result.baselineKind === "standard_fallback"
      ? "Previous Desktop settings were not recorded. Disconnect will switch this managed profile to standard mode."
      : undefined;
    const warning = [fallbackWarning, policyWarning].filter(Boolean).join(" ");
    return { ok: true, path: result.path ?? "", ...(warning ? { warning } : {}) };
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    return { ok: false, path: "", reason: /^[a-z][a-z0-9_]{1,100}$/.test(message) ? message : "desktop_apply_failed" };
  }
}

/** Persist the operator's Desktop mode choice; a failed marker save never undoes the apply. */
function saveDesktopMode(mode: ClaudeDesktopMode, deps: ApplyProfileDeps): boolean {
  try {
    return withClientLifecycleSync(() => {
      const outcome = mutatePersistedConfig(current => recordClaudeDesktopMode(current, mode));
      return outcome.status !== "unavailable";
    }, deps.lifecycleLockDeps);
  } catch {
    return false;
  }
}

export type DesktopApplyTarget =
  | { kind: "first-party" }
  | { kind: "gateway"; mode: Desktop3pConfigMode };

/** Parse `ocx claude desktop apply` flags into a target; legacy gateway shape flags imply --gateway. */
/**
 * Default mode when no flag is given: gateway, unless this install is already first-party (saved
 * mode or observed first-party settings). A connected client still uses gateway, because the
 * intercept proxy lives on the hub.
 */
export function defaultDesktopApplyMode(
  config: Pick<OcxConfig, "claudeCode" | "port" | "runtimeRole">,
  connection: ClientConnectionState = readClientConnectionState(),
  observed: ClaudeDesktopModeObservation = observeClaudeDesktopMode(config),
): ClaudeDesktopMode {
  const resolved = resolveClaudeDesktopApplyMode(config, observed);
  if (resolved === "gateway") return resolved;
  return connection.kind === "connected" ? "gateway" : "first-party";
}

export function parseDesktopApplyArgs(
  flags: string[],
  config: Pick<OcxConfig, "claudeCode" | "port" | "runtimeRole">,
  observed?: ClaudeDesktopModeObservation,
): { target: DesktopApplyTarget } | { error: string } {
  const shapeFlags = flags.filter(arg => ["--static", "--hybrid", "--discovery-only"].includes(arg));
  const wantsFirstParty = flags.includes("--first-party");
  const wantsGateway = flags.includes("--gateway") || shapeFlags.length > 0;
  if (wantsFirstParty && wantsGateway) return { error: "--first-party cannot be combined with --gateway or gateway shape flags." };
  const unknown = flags.filter(arg => !["--first-party", "--gateway", "--static", "--hybrid", "--discovery-only"].includes(arg));
  if (unknown.length > 0) return { error: `알 수 없는 인자: ${unknown.join(" ")}` };
  const kind: ClaudeDesktopMode = wantsFirstParty
    ? "first-party"
    : wantsGateway ? "gateway" : defaultDesktopApplyMode(config, readClientConnectionState(), observed ?? observeClaudeDesktopMode(config));
  if (kind === "first-party") return { target: { kind } };
  const parsedMode = parseDesktop3pModeArgs(shapeFlags);
  if ("error" in parsedMode) return parsedMode;
  return { target: { kind, mode: parsedMode.mode } };
}

/**
 * What an apply without a flag says after it lands on gateway, the default.
 *
 * It names why gateway was chosen (the default, a saved gateway mode, or a previous gateway apply),
 * that first-party exists and which command selects it, and the account risk that comes with it,
 * so nobody switches without reading it. Returns nothing when the user asked for gateway
 * explicitly, because they already chose, and when first-party cannot run here — a connected client
 * or a disabled intercept — because offering it would be advice that fails.
 */
export function gatewayModeExplanation(input: {
  requestedExplicitly: boolean;
  config: Pick<OcxConfig, "claudeCode" | "runtimeRole">;
  connection?: ClientConnectionState;
}): string[] {
  if (input.requestedExplicitly) return [];
  const connection = input.connection ?? readClientConnectionState();
  if (connection.kind === "connected") return [];
  if (!claudeInterceptEnabled(input.config)) return [];
  const savedMode = input.config.claudeCode?.desktopMode;
  const hasSavedGateway = isClaudeDesktopMode(savedMode) && savedMode === "gateway";
  const hasApplyMarker = input.config.claudeCode?.desktopProfile?.appliedFingerprint !== undefined;
  const reason = hasSavedGateway
    ? "because this machine has claudeCode.desktopMode saved as gateway; an existing install is never switched for you"
    : hasApplyMarker
      ? "because this machine carries a previous gateway apply; an existing install is never switched for you"
      : "because gateway is the default for Claude Desktop";
  return [
    `Applied the gateway profile ${reason}.`,
    "First-party keeps Desktop on your claude.ai account and routes only the Code tab through the local proxy:",
    "  ocx claude desktop apply --first-party",
    `Account risk: ${FIRST_PARTY_ACCOUNT_RISK.message}`,
  ];
}

/**
 * First-party apply: settings.json env only. The intercept pair the env points at runs inside
 * the hub process, so this is a local-hub operation — a connected client machine cannot reach
 * a loopback proxy on the hub and is refused rather than left with a dead `HTTPS_PROXY`.
 */
async function applyFirstPartyDesktop(
  deps: ApplyProfileDeps,
): Promise<DesktopApplyResult> {
  try { assertNoClientDisconnectPending(); } catch { return { ok: false, path: "", reason: "client_disconnect_pending" }; }
  const connection = readClientConnectionState();
  if (connection.kind === "connected") return { ok: false, path: "", reason: "first_party_requires_local_hub" };
  if (connection.kind !== "disconnected") return { ok: false, path: "", reason: "client_connection_invalid" };
  if (await liveDesktopProxy(deps)) {
    try {
      const applied = await pickerRuntimeRequest<DesktopApplyResult>(
        "/api/claude-desktop/apply",
        { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mode: "first-party" }) },
        deps,
      );
      return { ...applied, path: applied.path ?? "", delegated: true };
    } catch (error) {
      return { ok: false, path: "", reason: error instanceof Error ? error.message : "daemon apply failed" };
    }
  }
  const config = loadConfig();
  const desired = setIntegrationEnabled("claude-desktop", true);
  if (!desired.ok) return { ok: false, path: "", reason: desired.message };
  // Establish the replacement before deleting the working gateway. A refused
  // cleanup restores only our managed env keys, preserving unrelated settings.
  const rollback = captureDesktopFirstPartyRollback(config);
  const applied = applyDesktopFirstParty(config);
  if (!applied.ok) return { ok: false, path: applied.path, reason: applied.reason };
  const appliedFingerprint = config.claudeCode?.desktopProfile?.appliedFingerprint ?? null;
  const library = inspectDesktop3pConfigLibrary({ appliedFingerprint });
  if (library.kind === "gateway_ours" || library.kind === "gateway_drifted") {
    const removed = removeDesktop3pStandardPivot({ appliedFingerprint, replaceWhileEnabled: true });
    if (!removed.ok) {
      const restored = removed.changed || !applied.changed || rollback();
      const modeSaved = !removed.changed || saveDesktopMode("first-party", deps);
      const warning = [restored ? "" : "first-party settings rollback did not complete",
        modeSaved ? "" : "first-party is active but its mode marker was not saved"].filter(Boolean).join("; ");
      return { ok: false, path: library.selectedProfilePath ?? "", reason: removed.kind === "cleanup_incomplete" ? "gateway_cleanup_incomplete" : `gateway_profile_active:${removed.reason ?? removed.kind}`,
        ...(warning ? { warning } : {}) };
    }
  }
  const saved = saveDesktopMode("first-party", deps);
  return {
    ok: true,
    path: applied.path,
    picker: offlinePickerStatus(loadConfig(), deps.platform),
    ...(saved ? {} : { warning: "desktop mode marker was not saved" }),
  };
}

export async function applyDesktop(
  profile: DesktopProfile | undefined,
  target: DesktopApplyTarget,
  deps: ApplyProfileDeps = {},
): Promise<DesktopApplyResult> {
  if (target.kind === "first-party") return applyFirstPartyDesktop(deps);
  const result = await applyProfile(profile, target.mode, deps);
  if (!result.ok) return result;
  if (result.delegated) return result;
  const modeSaved = saveDesktopMode("gateway", deps);
  const warning = [result.warning, modeSaved ? "" : "desktop mode marker was not saved"].filter(Boolean).join(" ");
  // The gateway mode is committed before retiring first-party settings.
  const removed = removeDesktopFirstParty();
  if (!removed.ok) return { ok: false, path: removed.path, reason: "first_party_settings_unreadable",
    warning: ["gateway applied; first-party cleanup remains incomplete", warning].filter(Boolean).join(" ") };
  if (warning) return { ...result, warning };
  return result;
}

export async function applyProfile(
  profile: DesktopProfile | undefined,
  mode: Desktop3pConfigMode,
  deps: ApplyProfileDeps = {},
): Promise<DesktopApplyResult> {
  try { assertNoClientDisconnectPending(); } catch { return { ok: false, path: "", reason: "client_disconnect_pending" }; }
  const connection = readClientConnectionState();
  if (connection.kind === "connected") return applyConnectedDesktopProfile(mode, connection, deps);
  if (connection.kind !== "disconnected") return { ok: false, path: "", reason: "client_connection_invalid" };
  // Explicit apply is an enable action. Persist intent before any Desktop write
  // so a process crash cannot leave a gateway profile that startup immediately removes.
  const desired = setIntegrationEnabled("claude-desktop", true);
  if (!desired.ok) return { ok: false, path: "", reason: desired.message };
  const config = loadConfig();
  const state = await buildClaudeDesktopState(config, profile);
  saveLocalDesktopProfile(state.profile, config.claudeCode?.desktopProfile, connection, deps);
  const live = await (deps.findLiveProxyImpl ?? findLiveProxy)();
  assertNoClientDisconnectPending();
  if (readClientConnectionState().kind !== "disconnected") throw new Error("client_connection_changed");
  if (live) {
    // #859: the Desktop alias reverse-map is process-local. Applying through the
    // serving process installs the map there; a local-only write leaves the
    // daemon unable to decode aliases, and the provider rejects them (400).
    const post = deps.postApplyImpl ?? (async (m: Desktop3pConfigMode, p: DesktopProfile) =>
      runtimeRequest<{ ok?: boolean; path?: string; error?: string; saved?: boolean; warning?: string; picker?: DesktopPickerStatus }>(
        "/api/claude-desktop/apply",
        // The daemon's config may be older than what we just saved, so the
        // profile travels with the request instead of being re-read there.
        { method: "POST", body: JSON.stringify({ mode: m, profile: p }) },
      ));
    try {
      const applied = await post(mode, state.profile);
      if (applied.ok === false) return { ok: false, path: applied.path ?? "", reason: applied.error ?? "daemon apply failed" };
      // Partial success: Desktop was written but the applied marker was not
      // persisted. Pass the degradation up instead of reporting a clean apply.
      const partial = (applied as { saved?: boolean; warning?: string }).saved === false;
      const warning = (applied as { warning?: string }).warning;
      return {
        ok: true,
        path: applied.path ?? "",
        picker: applied.picker,
        delegated: true,
        ...(warning ? { warning } : partial ? { warning: "applied marker was not saved" } : {}),
      };
    } catch (error) {
      return { ok: false, path: "", reason: error instanceof Error ? error.message : String(error) };
    }
  }
  const allModels = await fetchAllModels(config);
  // The toggle can persist OFF while fetchAllModels was awaiting (same race the
  // management writers fence). Re-read persisted intent immediately before the
  // writer; a lost race is a discriminated skip, not a write.
  assertNoClientDisconnectPending();
  if (readClientConnectionState().kind !== "disconnected") throw new Error("client_connection_changed");
  if (!claudeDesktopIntegrationEnabledNow()) {
    return { ok: false, path: "", reason: "desired_state_changed" };
  }
  const routed = filterCatalogVisibleModels(allModels, config).map(model => ({
    provider: model.provider,
    id: model.id,
    contextWindow: model.contextWindow,
  }));
  const result = writeDesktop3pConfig(
    config.port ?? 10100,
    [...desktopVisibleNativeSlugs(config)],
    routed,
    config.apiKeys?.[0]?.key,
    mode,
    state.profile,
    nativeContextLimits(config),
    deps.lifecycleLockDeps,
  );
  let stateWarning: string | undefined;
  if (result.written) {
    try { saveLocalDesktopProfile(state.profile, state.profile, connection, deps, { fingerprint: result.fingerprint }); }
    catch { stateWarning = "gateway applied but its committed mode/profile state was not saved"; }
  }
  const policyState = (deps.probeClaudeDesktopPolicy ?? probeClaudeDesktopPolicy)();
  const warning = [result.written ? claudeDesktopPolicyWarning(policyState) : undefined, stateWarning].filter(Boolean).join(" ");
  return {
    ok: result.written,
    path: result.path,
    reason: result.reason,
    ...(warning ? { warning } : {}),
  };
}

async function handleClaudeDesktopPickerCommand(
  argv: string[],
  config: OcxConfig,
  deps: ApplyProfileDeps,
): Promise<number> {
  const action = argv[1];
  const rest = argv.slice(2);
  const usage = "Usage: ocx claude desktop picker on|off|status|trust [--json]";
  if (!action || !["on", "off", "status", "trust"].includes(action)) throw new CliUsageError(usage);
  const wantsJson = takeJsonFlag(rest);
  if (rest.length > 0 || (action !== "status" && wantsJson)) throw new CliUsageError(usage);

  const requestPicker = (body: Record<string, unknown>) => pickerRuntimeRequest<PickerRouteResponse>(
    "/api/claude-desktop/picker",
    { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
    deps,
  );

  if (action === "status") {
    if (await liveDesktopProxy(deps)) {
      try {
        const response = await pickerRuntimeRequest<{ ok?: boolean; picker?: DesktopPickerStatus }>("/api/claude-desktop/picker", {}, deps);
        printPickerStatus(response.picker, wantsJson);
      } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        return 1;
      }
    } else {
      printPickerStatus(offlinePickerStatus(config, deps.platform), wantsJson);
    }
    return 0;
  }

  if (action === "off") {
    if (await liveDesktopProxy(deps)) {
      try {
        const response = await requestPicker({ enabled: false, persist: true });
        printPickerStatus(response.picker, false);
      } catch (error) {
        if (isAnsweredPickerRefusal(error)) {
          const body = (error as RuntimeApiError).body as PickerRouteResponse;
          printPickerStatus(body.picker, false);
        }
        console.error(error instanceof Error ? error.message : String(error));
        return 1;
      }
    } else {
      if (!persistPickerPreference(false)) {
        console.error("Could not persist claudeCode.intercept.picker=false");
        return 1;
      }
      const removed = await (deps.removeDesktopPickerArtifacts ?? removeDesktopPickerArtifacts)({ configDir: getConfigDir(), security: deps.security, platform: deps.platform });
      if (!removed.ok) console.error(`picker cleanup incomplete${removed.residual?.length ? `: ${removed.residual.join(", ")}` : ""}`);
      printPickerStatus(offlinePickerStatus(loadConfig(), deps.platform), false);
      if (!removed.ok) return 1;
    }
    console.log("Fully quit and reopen Claude Desktop");
    return 0;
  }

  if (action === "on" && !(await liveDesktopProxy(deps))) {
    console.error("proxy_unavailable");
    return 1;
  }

  let localTrust: { callerAddedTrust: boolean; caPath: string; sha1: string } | undefined;
  const sendEnable = async (trustedLocally = false): Promise<PickerRouteResponse> => requestPicker({
    enabled: true,
    persist: action === "on",
    ...(trustedLocally ? { trustedLocally: true, callerAddedTrust: localTrust?.callerAddedTrust ?? false } : {}),
  });

  if (action === "trust") {
    const trusted = await trustPickerLocally(deps);
    if (!trusted.ok) {
      console.error(trusted.reason);
      return 1;
    }
    localTrust = trusted;
    if (!(await liveDesktopProxy(deps))) {
      await compensateLocalPickerTrust(localTrust, deps);
      console.error("proxy_unavailable");
      return 1;
    }
  }

  let response: PickerRouteResponse;
  try {
    response = await sendEnable(action === "trust");
    if (response.ok === false) {
      printPickerStatus(response.picker, false);
      console.error(response.reason ?? response.code ?? "picker_enable_refused");
      return 1;
    }
    if (action === "on" && response.picker?.reason === "trust_pending") {
      const trusted = await trustPickerLocally(deps);
      if (!trusted.ok) {
        console.error(trusted.reason);
        return 1;
      }
      localTrust = trusted;
      response = await sendEnable(true);
    }
    printPickerStatus(response.picker, false);
    if (response.picker?.reason === "restart_required") console.log("Fully quit and reopen Claude Desktop");
    const reason = response.picker?.reason;
    return response.ok === false || (reason !== "active" && reason !== "restart_required") ? 1 : 0;
  } catch (error) {
    if (isAnsweredPickerRefusal(error)) {
      const body = (error as RuntimeApiError).body as PickerRouteResponse;
      printPickerStatus(body.picker, false);
      console.error(body.reason ?? body.code ?? (error instanceof Error ? error.message : String(error)));
      return 1;
    }
    if (isAmbiguousPickerTransport(error)) {
      console.error("state unknown - run ocx claude desktop picker status");
      return 1;
    }
    if (localTrust) await compensateLocalPickerTrust(localTrust, deps);
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

export async function handleClaudeDesktopCommand(argv: string[], deps: ApplyProfileDeps = {}): Promise<number> {
  const command = argv[0];
  if (command === "help" || command === "--help" || command === "-h") {
    printDesktopHelp();
    return 0;
  }

  // Mode flags remain apply aliases and are parsed before subcommands.
  const applyFlags = argv.filter(arg => APPLY_FLAGS.includes(arg));
  const applyInvocation = argv.length === 0 || command === "apply" || applyFlags.length > 0;
  if (applyInvocation) {
    const rest = argv.filter(arg => arg !== "apply");
    const preApplyConfig = loadConfig();
    const parsedTarget = parseDesktopApplyArgs(rest, preApplyConfig);
    if ("error" in parsedTarget) { console.error(parsedTarget.error); return 2; }
    const { target } = parsedTarget;
    try {
      const result = await applyDesktop(undefined, target, deps);
      if (!result.ok) {
        console.error(`설정 적용 실패: ${result.reason ?? "unknown error"}`);
        if (result.warning) console.warn(result.warning);
        if (result.reason?.startsWith("gateway_")) {
          console.error("The gateway profile could not be removed safely, so first-party mode was not applied. Turn the integration off (dashboard toggle) and retry, or keep gateway with `ocx claude desktop apply --gateway`.");
        } else if (result.reason === "foreign_env") {
          console.error(`~/.claude/settings.json already sets HTTPS_PROXY or NODE_EXTRA_CA_CERTS to a value opencodex does not own (${result.path}). Remove them or use --gateway.`);
        } else if (result.reason === "intercept_disabled") {
          console.error("First-party mode needs the Claude intercept proxy (claudeCode.intercept.enabled on a hub). Use --gateway instead.");
        } else if (result.reason === "first_party_requires_local_hub") {
          console.error("First-party mode runs on the hub machine only; on a connected client use --gateway.");
        }
        return 1;
      }
      if (target.kind === "first-party") {
        console.log(`Claude Desktop first-party 설정을 적용했습니다: ${result.path}`);
        console.log("Desktop 앱 설정은 그대로이며, Code 탭의 Claude Code만 로컬 프록시를 거칩니다.");
        console.warn(`⚠️  ${FIRST_PARTY_ACCOUNT_RISK.message}`);
        printPickerStatus(result.picker, false);
      } else {
        console.log(`Claude Desktop gateway 설정을 적용했습니다: ${result.path}`);
        for (const line of gatewayModeExplanation({
          requestedExplicitly: applyFlags.some(flag => flag !== "--first-party"),
          config: preApplyConfig,
        })) {
          console.log(line);
        }
      }
      // The write landed; only the bookkeeping marker did not. Saying nothing
      // would leave the saved-vs-applied display wrong with no explanation.
      if (result.warning) console.warn(`⚠️  ${result.warning}`);
      console.log("Claude Desktop을 완전히 종료한 뒤 다시 열어 주세요.");
      return 0;
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      return 1;
    }
  }

  try {
    const connection = readClientConnectionState();
    if (command === "import" && argv.includes("--apply")) assertNoClientDisconnectPending();
    if (command === "import" && argv.includes("--apply") && connection.kind !== "disconnected") {
      throw new CliUsageError(connection.kind === "connected"
        ? "Connected Desktop apply uses the hub profile. Import on the hub, then run ocx claude desktop apply here."
        : "Client connection state is invalid; refusing import --apply.");
    }
    const localView = connection.kind === "connected";
    if (localView && ["show", "export", "move", "default", "import"].includes(command ?? "")) {
      console.warn("Local client profile only; connected Desktop apply uses the hub profile.");
    }
    const config = loadConfig();
    if (command === "picker") return await handleClaudeDesktopPickerCommand(argv, config, deps);
    // `status` is API-backed and must NOT build local state first: the whole point of the
    // route the GUI polls (/api/claude-desktop/status) is the applied-vs-desired comparison,
    // including staleness, drift and health, which only the running proxy knows. `show`
    // reports what this machine would write; `status` reports what is actually in effect.
    if (command === "status") {
      const rest = argv.slice(1);
      const wantsJson = takeJsonFlag(rest);
      if (rest.length > 0) throw new CliUsageError("Usage: ocx claude desktop status [--json]");
      const live = await runtimeRequest<Record<string, unknown>>("/api/claude-desktop/status", {});
      if (wantsJson) console.log(JSON.stringify(live, null, 2));
      else {
        for (const [key, value] of Object.entries(live)) {
          console.log(`${key}: ${typeof value === "object" ? JSON.stringify(value) : String(value)}`);
        }
      }
      return 0;
    }
    // Bindings are API-backed for the same reason as `status`: the running proxy routes with
    // its live config, so the change must land there, not only in the file.
    if (command === "bind" || command === "unbind") {
      const [, pickerId, route, ...extra] = argv;
      const usage = command === "bind"
        ? "Usage: ocx claude desktop bind <picker-model-id> <provider/model|native/slug>"
        : "Usage: ocx claude desktop unbind <picker-model-id>";
      if (!pickerId || (command === "bind" ? !route || extra.length > 0 : route !== undefined)) throw new CliUsageError(usage);
      const body = command === "bind" ? { set: { [pickerId]: route! } } : { remove: [pickerId] };
      const result = await runtimeRequest<{ modelBindings?: Record<string, string> }>("/api/claude-desktop/first-party-bindings", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const bindings = result.modelBindings ?? {};
      console.log(command === "bind"
        ? `Code 탭 피커의 ${pickerId}를 ${route}로 연결했습니다. 다음 요청부터 적용됩니다.`
        : `${pickerId} 연결을 해제했습니다.`);
      const ids = Object.keys(bindings).sort();
      if (ids.length === 0) console.log("현재 연결된 피커 모델이 없습니다.");
      for (const id of ids) console.log(`  ${id} -> ${bindings[id]}`);
      if (resolveClaudeDesktopMode(config, observeClaudeDesktopMode(config)) === "gateway") {
        console.warn("⚠️  Desktop이 gateway 모드입니다. 바인딩은 first-party 모드(ocx claude desktop apply --first-party)의 Code 탭과 claude CLI에만 적용됩니다.");
      }
      return 0;
    }
    const state = await buildClaudeDesktopState(config);
    if (command === "show") {
      const rest = argv.slice(1);
      const wantsJson = takeJsonFlag(rest);
      if (rest.length > 0) throw new CliUsageError("Usage: ocx claude desktop show [--json]");
      if (wantsJson) console.log(JSON.stringify(localView ? { ...state, scope: "local" } : state));
      else {
        for (const family of DESKTOP_FAMILIES) {
          console.log(`${family.toUpperCase()}${state.profile.defaults[family] ? ` (default: ${state.profile.defaults[family]})` : ""}`);
          for (const model of state.models.filter(item => item.assignment.family === family)) {
            console.log(`  ${model.available ? "•" : "○"} ${model.route} -> ${model.assignment.alias}${model.available ? "" : " (unavailable)"}`);
          }
        }
      }
      return 0;
    }
    if (command === "move") {
      const [, route, familyRaw, ...flags] = argv;
      if (!route || !isFamily(familyRaw) || flags.some(flag => flag !== "--default")) throw new CliUsageError("Usage: ocx claude desktop move <route> <family> [--default]");
      if (!state.models.some(model => model.route === route && model.available)) throw new Error(`현재 사용할 수 없는 모델입니다: ${route}`);
      const profile = moveDesktopRoute(state.profile, route, familyRaw, flags.includes("--default"));
      saveLocalDesktopProfile(profile, config.claudeCode?.desktopProfile, connection, deps);
      console.log(`${route} 모델을 ${familyRaw} 그룹으로 옮겼습니다.`);
      return 0;
    }
    if (command === "default") {
      const [, familyRaw, routeRaw] = argv;
      if (!isFamily(familyRaw) || !routeRaw || argv.length !== 3) throw new CliUsageError("Usage: ocx claude desktop default <family> <route|none>");
      const route = routeRaw === "none" ? null : routeRaw;
      if (route && !state.models.some(model => model.route === route && model.available)) throw new Error(`현재 사용할 수 없는 모델입니다: ${route}`);
      const profile = setDesktopFamilyDefault(state.profile, familyRaw, route);
      saveLocalDesktopProfile(profile, config.claudeCode?.desktopProfile, connection, deps);
      console.log(`${familyRaw} 기본 모델을 ${route ?? "없음"}으로 지정했습니다.`);
      return 0;
    }
    if (command === "export") {
      const target = argv[1];
      if (!target || argv.length !== 2) throw new CliUsageError("Usage: ocx claude desktop export <path|->");
      const json = JSON.stringify(state.profile, null, 2) + "\n";
      if (target === "-") process.stdout.write(json);
      else writeFileSync(resolve(target), json, { encoding: "utf8", mode: 0o600 });
      return 0;
    }
    if (command === "import") {
      const source = argv[1];
      const flags = argv.slice(2);
      if (!source || flags.some(flag => flag !== "--apply")) throw new CliUsageError("Usage: ocx claude desktop import <path> [--apply]");
      const profile = parseDesktopProfile(JSON.parse(readFileSync(resolve(source), "utf8")));
      const reconciled = (await buildClaudeDesktopState(config, profile)).profile;
      if (flags.includes("--apply")) assertNoClientDisconnectPending();
      if (flags.includes("--apply") && readClientConnectionState().kind !== "disconnected") {
        throw new CliUsageError("Client connection changed; refusing import --apply. Connected Desktop apply uses the hub profile.");
      }
      saveLocalDesktopProfile(reconciled, config.claudeCode?.desktopProfile, connection, deps);
      if (flags.includes("--apply")) {
        // A routing profile is a gateway-mode artifact: importing with --apply installs it there.
        const result = await applyDesktop(reconciled, { kind: "gateway", mode: "static" }, deps);
        if (!result.ok) { console.error(`프로필은 저장했지만 Desktop 적용에 실패했습니다: ${result.reason ?? "unknown error"}`); return 1; }
        if (result.warning) console.warn(`⚠️  ${result.warning}`);
      }
      console.log("Claude Desktop 프로필을 가져왔습니다.");
      return 0;
    }
    printDesktopHelp();
    return 2;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return error instanceof CliUsageError ? 2 : 1;
  }
}
