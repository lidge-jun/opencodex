import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
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
import { writeDesktop3pConfig, type Desktop3pConfigMode, parseDesktop3pModeArgs } from "../claude/desktop-3p";
import { claudeDesktopPolicyWarning, probeClaudeDesktopPolicy } from "../claude/desktop-policy";
import { filterCatalogVisibleModels, desktopVisibleNativeSlugs, nativeContextLimits } from "../codex/catalog";
import { buildClaudeDesktopState, fetchAllModels } from "../server/management-api";
import { findLiveProxy } from "../server/proxy-liveness";
import { CliUsageError, runtimeRequest, takeJsonFlag } from "./runtime-api";
import { OPENAI_CODEX_PROVIDER_ID } from "../providers/openai-tiers";

function isFamily(value: string | undefined): value is DesktopFamily {
  return !!value && (DESKTOP_FAMILIES as readonly string[]).includes(value);
}

function printDesktopHelp(): void {
  console.log(`Usage:
  ocx claude desktop [apply] [--static|--hybrid|--discovery-only]
  ocx claude desktop show [--json]
  ocx claude desktop status [--json]
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
  ) => Promise<{ ok?: boolean; path?: string; error?: string; warning?: string }>;
  probeClaudeDesktopPolicy?: typeof import("../claude/desktop-policy").probeClaudeDesktopPolicy;
}

/** Persist only the requested local profile, never an await-old whole configuration. */
function saveLocalDesktopProfile(
  profile: DesktopProfile,
  expectedProfile: DesktopProfile | undefined,
  expectedConnection: ClientConnectionState,
  deps: ApplyProfileDeps,
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

export async function applyProfile(
  profile: DesktopProfile | undefined,
  mode: Desktop3pConfigMode,
  deps: ApplyProfileDeps = {},
): Promise<{ ok: boolean; path: string; reason?: string; warning?: string }> {
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
      runtimeRequest<{ ok?: boolean; path?: string; error?: string; saved?: boolean; warning?: string }>(
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
  const policyState = (deps.probeClaudeDesktopPolicy ?? probeClaudeDesktopPolicy)();
  const warning = result.written ? claudeDesktopPolicyWarning(policyState) : undefined;
  return {
    ok: result.written,
    path: result.path,
    reason: result.reason,
    ...(warning ? { warning } : {}),
  };
}

export async function handleClaudeDesktopCommand(argv: string[], deps: ApplyProfileDeps = {}): Promise<number> {
  const command = argv[0];
  if (command === "help" || command === "--help" || command === "-h") {
    printDesktopHelp();
    return 0;
  }

  // Legacy mode flags remain apply aliases and are parsed before subcommands.
  const legacyFlags = argv.filter(arg => ["--static", "--hybrid", "--discovery-only"].includes(arg));
  const applyInvocation = argv.length === 0 || command === "apply" || legacyFlags.length > 0;
  if (applyInvocation) {
    const nonMode = argv.filter(arg => !["apply", "--static", "--hybrid", "--discovery-only"].includes(arg));
    if (nonMode.length > 0) {
      console.error(`알 수 없는 인자: ${nonMode.join(" ")}`);
      return 2;
    }
    const parsedMode = parseDesktop3pModeArgs(legacyFlags);
    if ("error" in parsedMode) { console.error(parsedMode.error); return 2; }
    try {
      const result = await applyProfile(undefined, parsedMode.mode, deps);
      if (!result.ok) {
        console.error(`설정 적용 실패: ${result.reason ?? "unknown error"}`);
        return 1;
      }
      console.log(`Claude Desktop 설정을 적용했습니다: ${result.path}`);
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
        const result = await applyProfile(reconciled, "static", deps);
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
