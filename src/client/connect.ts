import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
} from "node:fs";
import { hostname } from "node:os";
import { dirname } from "node:path";
import { atomicWriteFile, loadConfig, withConfigMutationLockSync } from "../config";
import { getConfigDir, withConfigDirHardeningSettled } from "../config/paths";
import { claudeDesktopIntegrationEnabledNow } from "../codex/desired-state";
import { siblingOfLivePort, siblingSkipMessage } from "../codex/sibling-start";
import {
  inspectRemoteDesktopStore, readDesktopDisconnectReceipt, writeDesktopDisconnectReceipt,
  replaceRemoteDesktopCredential, restoreRemoteDesktopStore, finishRemoteDesktopCleanup,
  type DesktopDisconnectReceipt, type DesktopRemoteOwner, type DesktopStoreResult,
} from "../claude/desktop-remote-store";
import {
  withClientLifecycle, withClientLifecycleSync,
  type ClientLifecycleHeld, type ClientLifecycleLockDeps,
} from "./lifecycle-lock";
import { invalidateCodexModelsCache, invalidateCodexModelsCacheWithPermit } from "../codex/catalog/sync";
import { withCatalogWriteSerialization } from "../codex/catalog-write-serialization";
import {
  injectCodexConfig,
  currentExternalCodexModelProvider,
  isCodexRoutingInjected,
  standaloneCodexRoutingTarget,
  type CodexRoutingTarget,
} from "../codex/inject";
import {
  JOURNAL_PATH,
  adoptJournalForClient,
  journalHandoverIncomplete,
  journalOwner,
  restoreJournalState,
} from "../codex/journal";
import { readCodexHomeJournal } from "../codex/codex-home-owner";
import { DEFAULT_CATALOG_PATH, getCodexHome } from "../codex/paths";
import {
  readServiceApiTokenState,
  readTokenBackupState,
  removeServiceApiTokenFileIfOwned,
  removeOrphanTokenBackup,
  replaceServiceApiTokenFile,
  restoreTokenBackup,
  serviceApiTokenBackupPath,
  serviceApiTokenFingerprint,
  writeTokenBackup,
  writeServiceApiTokenFile,
} from "../lib/service-secrets";
import { MAX_REMOTE_CATALOG_BYTES } from "../server/catalog-download";
import type {
  OcxClientConnectionConfig,
  OcxConfig,
  OcxConnectedClientId,
} from "../types";
import {
  downloadClientCatalog,
  abortClientKeyRotation,
  commitClientKeyRotation,
  exchangeConnectPairingGrant,
  fetchHubReady,
  HubClientError,
  issueClientKey,
  normalizeHubOrigin,
  probeClientKeyId,
  revokeClientKey,
  startClientKeyRotation,
  type ConnectGuiSession,
  type IssuedClientKey,
  type OneTimeConnectCredential,
} from "./hub-client";
import {
  clearClientConnection,
  commitClientConnection,
  readClientConnectionState,
  isLinkConnection,
  markClientConnectPending, clearClientConnectPending, pendingClientConnectMayOwnToken,
  assertNoClientDisconnectPending, assertClientConnectionUnchanged, sameClientConnectionOwner,
} from "./state";
import { assertClientCatalogCompatible, type CatalogCompatibilityDeps } from "./catalog-compatibility";
import {
  assertClientSyncExpectation, assertDisconnectLinkExpectation, ClientSyncExpectationError, isClientSyncLockBusy, type ClientSyncExpectation,
} from "./sync-expectation";
import { overlayHomeCodexSettings } from "../link/codex-settings";
import {
  clearHomeCodexSettingsRecord,
  fetchHomeCodexSettings,
  homeCodexSettingsReceipt,
  readHomeCodexSettingsRecord,
  resolveHomeCodexSettings,
  recordHomeCodexSettings,
  withLinkApply,
  withdrawChangingHomeCodexSettingsRecord,
  writeHomeCodexSettingsRecord,
  type HomeCodexSettingsRecord,
  type HomeCodexSettingsSource,
  type LinkHomeDeps,
} from "./link-home";
import { hubStateCachePath } from "./hub-state";
import { ClientLinkStateError, clearClientLinkState, readChildLinkMarker, readClientLinkState } from "./link-state";
import { isLinkPort } from "../link/ports";
import { assertRouteIntentPort, clientSyncRuntimeGuard, ClientSyncRuntimeError } from "./sync-runtime";
import { prepareConnectedRouteIntent, initialConnectRouteIntent, connectedRouteSelectedClients, applyConnectedRouteIntent } from "../integrations/route-intent-connected";
import { clearRouteIntentReceipt, clearRouteIntentUnappliedProof, readRouteIntentReceiptStrict, writeRouteIntentUnappliedProof } from "../integrations/route-intent-state";
import type { RouteIntentReceipt } from "../integrations/route-intent-contract";
import { clearHomeRouteIntentRecord } from "./link-home";
import { clearInitialRouteIntent, recordInitialRouteIntent } from "../integrations/route-intent-initial";
import { cleanupConnectedRouteIntent } from "../integrations/route-intent-disconnect";
import { nativeIntentOriginalsPath, readNativeIntentOriginals, restoreNativeIntentOriginals } from "./route-intent-native-originals";
import { clearFileIntentOriginals } from "./route-intent-file-originals";

class RotationRecoveryRequiredError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "RotationRecoveryRequiredError";
  }
}

export interface ConnectOptions {
  serverUrl: string;
  managementUrl?: string;
  credential: OneTimeConnectCredential | LinkClientCredential;
  selectedClients: OcxConnectedClientId[];
  /** Provisioning selection retained until Home revises that client's device policy. */
  selectedClientsExplicit?: boolean;
  managementTransport: "direct" | "relay";
  transport?: "hub" | "link";
  link?: { tunnelPort: number; linkId: string };
  noSync?: boolean;
  catalogTimeoutMs?: number;
}

export interface LinkClientCredential {
  kind: "link";
  apiKeyId: string;
  key: string;
}

export interface ClientConnectDeps {
  /** Abort enrollment network work and refuse subsequent writes; rollback still drains. */
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  lifecycleLockDeps?: ClientLifecycleLockDeps;
  catalogCompatibility?: CatalogCompatibilityDeps;
  /** Link mode: how the Home's Codex settings are read (#6957). */
  linkHome?: LinkHomeDeps;
  /** Link mode: the apply lock's path (OCX-6); defaults to `<configDir>/link/apply-lock.sqlite`. */
  linkApplyLockPath?: string;
}

export interface RotateClientOptions {
  credential: OneTimeConnectCredential;
}

type CatalogSnapshot =
  | { kind: "absent" }
  | { kind: "file"; body: string; fingerprint: string };

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function catalogSnapshot(): CatalogSnapshot {
  if (!existsSync(DEFAULT_CATALOG_PATH)) return { kind: "absent" };
  const stat = lstatSync(DEFAULT_CATALOG_PATH);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size > MAX_REMOTE_CATALOG_BYTES) {
    throw new Error("existing OpenCodex catalog is not a bounded regular file");
  }
  const body = readFileSync(DEFAULT_CATALOG_PATH, "utf8");
  return { kind: "file", body, fingerprint: sha256(body) };
}

function restoreCatalogSnapshot(snapshot: CatalogSnapshot, writtenFingerprint: string): boolean {
  try {
    if (!existsSync(DEFAULT_CATALOG_PATH)) return snapshot.kind === "absent";
    const stat = lstatSync(DEFAULT_CATALOG_PATH);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size > MAX_REMOTE_CATALOG_BYTES) return false;
    const current = readFileSync(DEFAULT_CATALOG_PATH, "utf8");
    if (sha256(current) !== writtenFingerprint) return false;
    if (snapshot.kind === "absent") unlinkSync(DEFAULT_CATALOG_PATH);
    else atomicWriteFile(DEFAULT_CATALOG_PATH, snapshot.body);
    return true;
  } catch {
    return false;
  }
}

function validLocalCatalog(): string {
  const snapshot = catalogSnapshot();
  if (snapshot.kind !== "file") throw new Error("connected catalog is missing");
  try {
    const parsed = JSON.parse(snapshot.body) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid");
  } catch {
    throw new Error("connected catalog is malformed");
  }
  return snapshot.body;
}

/**
 * Is the on-disk catalog still the one this connection wrote?
 *
 * Recorded as our own hash rather than the hub's ETag: /v1/catalog emits no validator
 * (Phase 1, D2), so there is no server-supplied tag to keep. This is an ownership check on
 * local bytes, which never needed the hub's participation — the previous spelling only
 * looked like a cache concern because it reused the ETag string.
 */
function catalogMatchesFingerprint(body: string, fingerprint: string | undefined): boolean {
  if (!fingerprint) return false;
  return createHash("sha256").update(body).digest("base64url") === fingerprint;
}

/**
 * Codex routing for a connected client. A hub client points Codex at the hub with the admission
 * token in `env_key`. A link Child (`localPort` given) keeps exactly the standalone loopback form,
 * root `openai_base_url = "http://127.0.0.1:<port>/v1"` with no provider table and no `env_key`:
 * its own listener relays to the Home and attaches the link key itself, so a GUI-launched Codex
 * that never saw the key's environment variable still works, and joining changes no Codex bytes.
 */
export function routingTarget(
  serverUrl: string,
  localPort?: number,
  config?: Pick<OcxConfig, "codexDesktopAuthless" | "codexClientCompaction">,
): CodexRoutingTarget & { link?: true } {
  if (localPort === undefined) {
    return { baseUrl: `${serverUrl}/v1`, requiresAdmissionToken: true, tokenEnv: "OPENCODEX_API_AUTH_TOKEN" };
  }
  if (!Number.isInteger(localPort) || localPort < 1 || localPort > 65535) {
    throw new Error("link mode requires a valid local config port");
  }
  return {
    ...standaloneCodexRoutingTarget(localPort, {
      hostname: "127.0.0.1",
      codexDesktopAuthless: config?.codexDesktopAuthless,
      codexClientCompaction: config?.codexClientCompaction,
    }),
    link: true as const,
  };
}

function localGuiOrigin(): string {
  const port = loadConfig().port;
  return `http://localhost:${Number.isInteger(port) && port > 0 ? port : 10100}`;
}

function clientKeyName(): string {
  const raw = `ocx connect ${hostname() || "client"}`;
  return raw.slice(0, 80);
}

function releaseCredential(credential: OneTimeConnectCredential): void {
  credential.value.fill(0);
}

function releaseConnectCredential(credential: ConnectOptions["credential"]): void {
  if (credential.kind !== "link") releaseCredential(credential);
}

async function rotationAuthority(
  connection: OcxClientConnectionConfig,
  options: RotateClientOptions,
  deps: ClientConnectDeps,
): Promise<{ kind: "admin"; value: Uint8Array } | { kind: "gui-session"; value: ConnectGuiSession }> {
  if (options.credential.kind === "admin") return { kind: "admin", value: options.credential.value };
  const session = await exchangeConnectPairingGrant(
    connection.managementUrl,
    localGuiOrigin(),
    options.credential.value,
    { fetchImpl: deps.fetchImpl },
  );
  return { kind: "gui-session", value: session };
}

export type ClientRotationResult = OcxClientConnectionConfig & {
  rotationOutcome: "committed" | "rolled_back";
};

function desktopOwner(connection: OcxClientConnectionConfig): DesktopRemoteOwner {
  return { serverUrl: connection.serverUrl, apiKeyId: connection.apiKeyId, connectedAt: connection.connectedAt };
}

function requireDesktopResult(result: DesktopStoreResult): Extract<DesktopStoreResult, { ok: true }> {
  if (!result.ok) throw new Error(`desktop_lifecycle_${result.reason}`);
  return result;
}

function assertRotationCandidates(
  connection: OcxClientConnectionConfig,
  currentFingerprint: string,
  backupFingerprint: string,
): void {
  assertClientConnectionUnchanged(connection);
  const current = readServiceApiTokenState();
  const backup = readTokenBackupState();
  if (current.kind !== "present" || backup.kind !== "present"
    || current.fingerprint !== currentFingerprint || backup.fingerprint !== backupFingerprint) {
    throw new RotationRecoveryRequiredError("rotation token generations changed; preserve recovery files");
  }
}

function alignDesktopCredential(
  held: ClientLifecycleHeld,
  connection: OcxClientConnectionConfig,
  previousFingerprint: string,
  token: { token: string; fingerprint: string },
): void {
  withConfigMutationLockSync(() => {
    assertClientConnectionUnchanged(connection);
    const current = readServiceApiTokenState();
    if (current.kind !== "present" || current.fingerprint !== token.fingerprint) {
      throw new Error("client_token_changed");
    }
    if (inspectRemoteDesktopStore(desktopOwner(connection)).kind === "absent") return;
    let result: DesktopStoreResult;
    if (!claudeDesktopIntegrationEnabledNow()) {
      result = restoreRemoteDesktopStore(held, {
        owner: desktopOwner(connection), knownTokenFingerprints: [connection.tokenFingerprint, current.fingerprint],
      });
    } else {
      result = replaceRemoteDesktopCredential(held, {
        owner: desktopOwner(connection), expectedTokenFingerprint: previousFingerprint, replacementKey: current.token,
      });
      if (!result.ok && !result.changed && result.reason === "conflict" && previousFingerprint !== current.fingerprint) {
        // Recovery may find Desktop already on the chosen generation while only
        // service-api-token needed rollback. Retry that exact, freshly proven
        // current generation; never retry a partial write or an unsafe artifact.
        result = replaceRemoteDesktopCredential(held, {
          owner: desktopOwner(connection), expectedTokenFingerprint: current.fingerprint, replacementKey: current.token,
        });
      }
    }
    requireDesktopResult(result);
  });
}

function finalizeRotation(
  held: ClientLifecycleHeld,
  connection: OcxClientConnectionConfig,
  previousFingerprint: string,
  token: { token: string; fingerprint: string },
  rotationOutcome: ClientRotationResult["rotationOutcome"],
): ClientRotationResult {
  try {
    alignDesktopCredential(held, connection, previousFingerprint, token);
    return withConfigMutationLockSync(() => {
      assertClientConnectionUnchanged(connection);
      const current = readServiceApiTokenState();
      if (current.kind !== "present" || current.fingerprint !== token.fingerprint) throw new Error("client_token_changed");
      const next = { ...connection, tokenFingerprint: token.fingerprint };
      delete next.pendingOperation;
      commitClientConnection(next);
      removeOrphanTokenBackup();
      // Outcome is an API result only, never a persisted client configuration field.
      return { ...next, rotationOutcome };
    });
  } catch {
    throw new RotationRecoveryRequiredError("rotation local finalization is incomplete; preserve recovery files");
  }
}

async function recoverRotationWithAuthority(
  held: ClientLifecycleHeld,
  connection: OcxClientConnectionConfig,
  authority: { kind: "admin"; value: Uint8Array } | { kind: "gui-session"; value: ConnectGuiSession },
  deps: ClientConnectDeps,
): Promise<ClientRotationResult> {
  try {
    const pending = connection.pendingOperation;
    if (!pending || pending.oldKeyBackupPath !== serviceApiTokenBackupPath()) throw new Error("invalid rotation marker");
    const current = readServiceApiTokenState();
    const backup = readTokenBackupState();
    if (current.kind !== "present" || backup.kind !== "present" || backup.fingerprint !== connection.tokenFingerprint) {
      throw new Error("rotation recovery generations are unavailable");
    }
    const assertFresh = () => withConfigMutationLockSync(() => assertRotationCandidates(connection, current.fingerprint, backup.fingerprint));
    assertFresh();
    if (current.fingerprint === backup.fingerprint) {
      // A crash after the marker but before replacement leaves two copies of OLD.
      // Their equal successful probes must never commit an uninstalled new hub key.
      if (!await probeClientKeyId(connection.serverUrl, backup.token, connection.apiKeyId, { fetchImpl: deps.fetchImpl })) {
        throw new Error("old generation not admitted");
      }
      assertFresh();
      await abortClientKeyRotation(connection.managementUrl, authority, connection.apiKeyId, pending.rotationId, { fetchImpl: deps.fetchImpl });
      if (!await probeClientKeyId(connection.serverUrl, backup.token, connection.apiKeyId, { fetchImpl: deps.fetchImpl })) {
        throw new Error("old generation not admitted after abort");
      }
      assertFresh();
      return finalizeRotation(held, connection, backup.fingerprint, backup, "rolled_back");
    }
    const [currentAccepted, backupAccepted] = await Promise.all([
      probeClientKeyId(connection.serverUrl, current.token, connection.apiKeyId, { fetchImpl: deps.fetchImpl }),
      probeClientKeyId(connection.serverUrl, backup.token, connection.apiKeyId, { fetchImpl: deps.fetchImpl }),
    ]);
    assertFresh();
    if (currentAccepted && backupAccepted) {
      alignDesktopCredential(held, connection, backup.fingerprint, current);
      await commitClientKeyRotation(connection.managementUrl, authority, connection.apiKeyId, pending.rotationId, { fetchImpl: deps.fetchImpl });
      assertFresh();
      return finalizeRotation(held, connection, backup.fingerprint, current, "committed");
    }
    if (currentAccepted && !backupAccepted) {
      return finalizeRotation(held, connection, backup.fingerprint, current, "committed");
    }
    if (!currentAccepted && backupAccepted) {
      // Remote abort is confirmed before either local credential is rolled back.
      await abortClientKeyRotation(connection.managementUrl, authority, connection.apiKeyId, pending.rotationId, { fetchImpl: deps.fetchImpl });
      assertFresh();
      const restored = withConfigMutationLockSync(() => restoreTokenBackup(pending.oldKeyBackupPath));
      return finalizeRotation(held, connection, current.fingerprint, { token: backup.token, fingerprint: restored.fingerprint }, "rolled_back");
    }
    throw new Error("both generations rejected");
  } catch (error) {
    if (error instanceof RotationRecoveryRequiredError) throw error;
    throw new RotationRecoveryRequiredError("rotation recovery could not settle admission and Desktop state; preserve current and backup tokens");
  }
}

export async function recoverPendingClientRotation(
  options: RotateClientOptions,
  deps: ClientConnectDeps = {},
): Promise<ClientRotationResult> {
  try {
    return await withClientLifecycle(async held => {
      assertNoClientDisconnectPending();
      const state = readClientConnectionState();
      if (state.kind !== "connected" || !state.value.pendingOperation) throw new Error("no pending client key rotation to recover");
      if (isLinkConnection(state.value)) throw new Error("connect rotate is unavailable in link mode");
      const authority = await rotationAuthority(state.value, options, deps);
      assertClientConnectionUnchanged(state.value);
      return recoverRotationWithAuthority(held, state.value, authority, deps);
    }, deps.lifecycleLockDeps);
  } finally { releaseCredential(options.credential); }
}

export async function rotateConnectedClientKey(
  options: RotateClientOptions,
  deps: ClientConnectDeps = {},
): Promise<ClientRotationResult> {
  try {
    return await withClientLifecycle(held => rotateConnectedClientKeyHeld(held, options, deps), deps.lifecycleLockDeps);
  } finally { releaseCredential(options.credential); }
}

async function rotateConnectedClientKeyHeld(
  held: ClientLifecycleHeld,
  options: RotateClientOptions,
  deps: ClientConnectDeps,
): Promise<ClientRotationResult> {
  let connection: OcxClientConnectionConfig | null = null;
  let authority: { kind: "admin"; value: Uint8Array } | { kind: "gui-session"; value: ConnectGuiSession } | null = null;
  let started: { rotationId: string; key: string; createdAt: string } | null = null;
  let markerPersisted = false;
  let backupCreated = false;
  let hubCommitted = false;
  try {
    assertNoClientDisconnectPending();
    const state = readClientConnectionState();
    if (state.kind !== "connected") throw new Error("connect rotate is available only while connected");
    connection = state.value;
    if (isLinkConnection(connection)) throw new Error("connect rotate is unavailable in link mode");
    const current = readServiceApiTokenState();
    if (current.kind !== "present") throw new Error("connected service token unavailable");
    if (!connection.pendingOperation) {
      if (current.fingerprint !== connection.tokenFingerprint) throw new Error("connected service token ownership changed");
      const desktop = inspectRemoteDesktopStore(desktopOwner(connection));
      if (["conflict", "unsafe", "pending"].includes(desktop.kind)) throw new Error("desktop_lifecycle_recovery_required");
      // Establish legacy fallback ownership and reject edited projections BEFORE hub issuance.
      // The remote Desktop store writes under the config root with required ACLs, so it admits
      // after overlapping config-root ACL work (#7815); a timeout here refuses before the hub.
      const unchanged = connection;
      await withConfigDirHardeningSettled(getConfigDir(), () => alignDesktopCredential(held, unchanged, current.fingerprint, current));
      withConfigMutationLockSync(() => {
        assertClientConnectionUnchanged(connection!);
        const orphan = readTokenBackupState();
        if (orphan.kind === "unsafe") throw new Error("service token backup is unsafe");
        if (orphan.kind === "present") removeOrphanTokenBackup();
      });
    }
    authority = await rotationAuthority(connection, options, deps);
    assertClientConnectionUnchanged(connection);
    if (connection.pendingOperation) return recoverRotationWithAuthority(held, connection, authority, deps);
    withConfigMutationLockSync(() => {
      assertClientConnectionUnchanged(connection!);
      writeTokenBackup(current.fingerprint);
    });
    backupCreated = true;
    const rotation = await startClientKeyRotation(connection.managementUrl, authority, connection.apiKeyId, { fetchImpl: deps.fetchImpl });
    started = { rotationId: rotation.rotationId, key: rotation.key, createdAt: rotation.createdAt };
    const marked: OcxClientConnectionConfig = {
      ...connection,
      pendingOperation: { kind: "rotate", rotationId: rotation.rotationId, newKeyIssuedAt: rotation.createdAt, oldKeyBackupPath: serviceApiTokenBackupPath() },
    };
    withConfigMutationLockSync(() => {
      assertClientConnectionUnchanged(connection!);
      commitClientConnection(marked);
    });
    connection = marked;
    markerPersisted = true;
    const replacement = withConfigMutationLockSync(() => {
      assertRotationCandidates(connection!, current.fingerprint, current.fingerprint);
      return replaceServiceApiTokenFile(rotation.key);
    });
    // Still before the hub commit: an admission timeout takes the ordinary rollback below.
    const marking = connection;
    await withConfigDirHardeningSettled(getConfigDir(), () =>
      alignDesktopCredential(held, marking, current.fingerprint, { token: rotation.key, fingerprint: replacement.fingerprint }));
    if (!await probeClientKeyId(connection.serverUrl, rotation.key, connection.apiKeyId, { fetchImpl: deps.fetchImpl })) {
      throw new Error("new client key admission probe was refused");
    }
    withConfigMutationLockSync(() => assertRotationCandidates(connection!, replacement.fingerprint, current.fingerprint));
    try {
      await commitClientKeyRotation(connection.managementUrl, authority, connection.apiKeyId, rotation.rotationId, { fetchImpl: deps.fetchImpl });
    } catch {
      return await recoverRotationWithAuthority(held, connection, authority, deps);
    }
    hubCommitted = true;
    return finalizeRotation(held, connection, current.fingerprint, { token: rotation.key, fingerprint: replacement.fingerprint }, "committed");
  } catch (error) {
    if (error instanceof RotationRecoveryRequiredError || hubCommitted) {
      throw error instanceof RotationRecoveryRequiredError ? error : new RotationRecoveryRequiredError("committed rotation requires local recovery");
    }
    if (connection && authority && started) {
      try {
        await abortClientKeyRotation(connection.managementUrl, authority, connection.apiKeyId, started.rotationId, { fetchImpl: deps.fetchImpl });
        if (markerPersisted && connection.pendingOperation) {
          const beforeRestore = readServiceApiTokenState();
          const backup = readTokenBackupState();
          if (beforeRestore.kind !== "present" || backup.kind !== "present") throw new Error("rotation rollback token unavailable");
          withConfigMutationLockSync(() => {
            assertRotationCandidates(connection!, beforeRestore.fingerprint, backup.fingerprint);
            restoreTokenBackup(connection!.pendingOperation!.oldKeyBackupPath);
          });
          finalizeRotation(held, connection, beforeRestore.fingerprint, backup, "rolled_back");
        } else {
          withConfigMutationLockSync(() => {
            assertClientConnectionUnchanged(connection!);
            if (backupCreated) removeOrphanTokenBackup();
          });
        }
      } catch {
        throw new RotationRecoveryRequiredError("rotation rollback was incomplete; preserve current and backup tokens");
      }
    } else if (backupCreated && connection) {
      withConfigMutationLockSync(() => {
        assertClientConnectionUnchanged(connection!);
        removeOrphanTokenBackup();
      });
    }
    throw error;
  } finally {
    if (started) started.key = "";
    authority = null;
  }
}

async function cleanupIssuedKey(
  managementUrl: string,
  credential: { kind: "admin"; value: Uint8Array } | { kind: "gui-session"; value: ConnectGuiSession },
  issuedId: string,
  deps: ClientConnectDeps,
): Promise<string | null> {
  try {
    await revokeClientKey(managementUrl, credential, issuedId, { fetchImpl: deps.fetchImpl });
    return null;
  } catch {
    return `Hub cleanup could not revoke client key ${issuedId}; revoke it from Integrations → API Keys.`;
  }
}

function assertConnectingState(expectedTokenFingerprint?: string): void {
  assertNoClientDisconnectPending();
  if (readClientConnectionState().kind !== "disconnected") throw new Error("client_connection_changed");
  const token = readServiceApiTokenState();
  if (expectedTokenFingerprint === undefined ? token.kind !== "absent"
    : token.kind !== "present" || token.fingerprint !== expectedTokenFingerprint) {
    if (expectedTokenFingerprint === undefined && token.kind === "present") {
      throw new Error("client_token_changed: if this is not a Hub and no admission secret or installed service uses the token, inspect it and use ocx disconnect --orphaned-token --yes before retrying");
    }
    throw new Error("client_token_changed");
  }
}

/** Enroll a client key, keeping its pending ownership visible until commit or rollback. */
/**
 * Connect this machine to a hub or, with `transport: "link"`, to a Remote Link Home. A link
 * connect holds the apply lock throughout (OCX-6), because it applies the Home's Codex settings
 * and records that apply exactly as `ocx sync` does.
 */
export async function connectClient(
  options: ConnectOptions,
  deps: ClientConnectDeps = {},
): Promise<OcxClientConnectionConfig> {
  if ((options.transport ?? "hub") !== "link") return connectClientUnlocked(options, deps);
  return withLinkApply(() => connectClientUnlocked(options, deps), deps.linkApplyLockPath);
}

async function connectClientUnlocked(
  options: ConnectOptions,
  deps: ClientConnectDeps = {},
): Promise<OcxClientConnectionConfig> {
  deps.signal?.throwIfAborted();
  const rawFetch = deps.fetchImpl ?? fetch;
  const fetchImpl: typeof fetch = deps.signal ? Object.assign(async (...[input, init = {}]: Parameters<typeof fetch>) => {
    deps.signal!.throwIfAborted();
    const signals = [deps.signal, init.signal, input instanceof Request ? input.signal : undefined]
      .filter((signal): signal is AbortSignal => signal != null);
    return rawFetch(input, { ...init, signal: AbortSignal.any(signals), redirect: "manual" });
  }, { preconnect: rawFetch.preconnect }) : rawFetch;
  const assertActiveConnectingState = (fingerprint?: string) => {
    deps.signal?.throwIfAborted();
    assertConnectingState(fingerprint);
  };
  let serverUrl = "";
  let managementUrl = "";
  let linkAdmissionToken: string | null = null;
  let linkMode = false;
  let linkMetadata: { tunnelPort: number; linkId: string } | undefined;
  let issued: IssuedClientKey | null = null;
  let cleanupCredential: { kind: "admin"; value: Uint8Array } | { kind: "gui-session"; value: ConnectGuiSession } | null = null;
  let tokenFingerprint: string | null = null;
  let pendingConnectFingerprint: string | null = null;
  let priorCatalog: CatalogSnapshot | null = null;
  let writtenCatalogFingerprint: string | null = null;
  let injectionCommitted = false;
  let restoreNativeIntent = false;
  let committed = false;
  let initialSelectionWritten = false;
  // Before any catalog, journal, client-state or credential write: `CODEX_HOME` is shared with the
  // live proxy a sibling instance runs beside, and connecting re-points it (`sibling-start.ts`).
  if (siblingOfLivePort() !== null) throw new Error(siblingSkipMessage());
  try {
    linkMode = (options.transport ?? "hub") === "link";
    if (linkMode) {
      if (options.credential.kind !== "link" || !options.link
        || !isLinkPort(options.link.tunnelPort)
        || !/^lnk_[0-9a-f]{16}$/.test(options.link.linkId)
        || !/^ocx_data_[0-9a-f]{40}$/.test(options.credential.key)
        || !options.credential.apiKeyId.trim() || options.credential.apiKeyId.length > 256) {
        throw new Error("invalid link credential");
      }
      linkMetadata = { ...options.link };
      serverUrl = `http://127.0.0.1:${linkMetadata.tunnelPort}`;
      if ((options.managementUrl && options.managementUrl !== serverUrl) || options.managementTransport !== "direct") {
        throw new Error("link mode requires direct management on the tunnel origin");
      }
      managementUrl = serverUrl;
    } else {
      if (options.credential.kind === "link" || options.link) throw new Error("link credential requires link transport");
      serverUrl = normalizeHubOrigin(options.serverUrl);
      if (options.managementUrl) managementUrl = normalizeHubOrigin(options.managementUrl);
    }
    if (options.selectedClients.length < 1 || new Set(options.selectedClients).size !== options.selectedClients.length) {
      throw new Error("at least one unique connected client is required");
    }
    // Only link mode needs the local port before the hub is contacted; hub mode keeps reading config
    // after the catalog download, so its stderr order (catalog refusal first) is unchanged.
    const earlyConfig = linkMode ? loadConfig() : undefined;
    if (earlyConfig) assertRouteIntentPort(earlyConfig.port);
    if (earlyConfig && (!Number.isInteger(earlyConfig.port) || earlyConfig.port < 1 || earlyConfig.port > 65535)) {
      throw new Error("link mode requires a valid local config port");
    }
    withClientLifecycleSync(() => withConfigMutationLockSync(() => {
      assertActiveConnectingState();
      const externalProvider = currentExternalCodexModelProvider();
      if (externalProvider) throw new Error("connect refused: an external Codex provider owns config.toml");
      if (linkMode) {
        const credential = options.credential;
        if (credential.kind !== "link") throw new Error("invalid link credential");
        const persisted = writeServiceApiTokenFile(credential.key);
        pendingConnectFingerprint = persisted.fingerprint;
        const reread = readServiceApiTokenState();
        if (reread.kind !== "present" || reread.fingerprint !== persisted.fingerprint) {
          throw new Error("invalid link credential");
        }
        markClientConnectPending(persisted.fingerprint);
        linkAdmissionToken = reread.token;
      }
    }), deps.lifecycleLockDeps);

    const upstreamFetch = fetchImpl;
    const readinessFetch = linkMode
      ? (async (input, init = {}) => {
        const url = input instanceof Request ? input.url : String(input);
        if (!url.endsWith("/readyz")) return upstreamFetch(input, init);
        const headers = new Headers(init.headers);
        headers.set("x-opencodex-api-key", linkAdmissionToken!);
        return upstreamFetch(input, { ...init, headers });
      }) as typeof fetch
      : upstreamFetch;
    const ready = await fetchHubReady(serverUrl, { fetchImpl: readinessFetch });
    if (ready.status !== "ready") throw new Error(`hub is not ready (${ready.status})`);
    if (!linkMode) managementUrl = managementUrl || ready.metadata.managementUrl;

    if (!linkMode && options.credential.kind === "pairing-grant") {
      const session = await exchangeConnectPairingGrant(
        managementUrl,
        localGuiOrigin(),
        options.credential.value,
        { fetchImpl },
      );
      cleanupCredential = { kind: "gui-session", value: session };
    } else if (!linkMode && options.credential.kind === "admin") {
      cleanupCredential = { kind: "admin", value: options.credential.value };
    }
    if (!linkMode) {
      issued = await issueClientKey(managementUrl, cleanupCredential!, clientKeyName(), { fetchImpl });
    }

    const initialFiles = withClientLifecycleSync(() => withConfigMutationLockSync(() => {
      assertActiveConnectingState(linkMode ? pendingConnectFingerprint! : undefined);
      const persisted = linkMode
        ? (() => {
          const current = readServiceApiTokenState();
          if (current.kind !== "present") throw new Error("invalid link credential");
          return { fingerprint: current.fingerprint };
        })()
        : writeServiceApiTokenFile(issued!.key);
      const fingerprint = persisted.fingerprint;
      if (!pendingConnectFingerprint) {
        markClientConnectPending(fingerprint);
        pendingConnectFingerprint = fingerprint;
      }
      return { prior: catalogSnapshot(), persisted };
    }), deps.lifecycleLockDeps);
    priorCatalog = initialFiles.prior;
    const persisted = initialFiles.persisted;
    tokenFingerprint = persisted.fingerprint;

    const admissionToken = linkMode ? linkAdmissionToken : issued?.key;
    if (!admissionToken) throw new Error("client admission credential unavailable");
    const apiKeyId = linkMode ? (options.credential as LinkClientCredential).apiKeyId : issued!.id;
    const catalog = await downloadClientCatalog(serverUrl, admissionToken, {
      fetchImpl,
      timeoutMs: options.catalogTimeoutMs,
    });
    // Fail closed BEFORE the write (#4207). The hub being reachable and the credential working
    // does not mean the selected local Codex runtime can consume what arrived: an older CLI
    // exits on an unknown reasoning level before making a single request, while connect
    // reports success. Refusing here leaves the previous catalog in place untouched, rather
    // than writing one and restoring it afterwards.
    assertClientCatalogCompatible(catalog.body, deps.catalogCompatibility);
    writtenCatalogFingerprint = withClientLifecycleSync(() => withConfigMutationLockSync(() => {
      assertActiveConnectingState(persisted.fingerprint);
      mkdirSync(dirname(DEFAULT_CATALOG_PATH), { recursive: true });
      atomicWriteFile(DEFAULT_CATALOG_PATH, catalog.body);
      return sha256(catalog.body);
    }), deps.lifecycleLockDeps);

    const config = earlyConfig ?? loadConfig();
    const routeIntent = initialConnectRouteIntent(linkMode && linkMetadata
      ? await prepareConnectedRouteIntent({ transport: "link", link: linkMetadata, apiKeyId }, admissionToken, deps.linkHome,
        () => assertActiveConnectingState(persisted.fingerprint)) : undefined,
      options.selectedClients, options.selectedClientsExplicit);
    const selectedClients = connectedRouteSelectedClients(routeIntent, options.selectedClients);
    const target = routingTarget(serverUrl, linkMode ? config.port : undefined, config);
    // A link Child writes the Home's OpenCodex-owned Codex settings, not its own (#6957). A read
    // that fails here keeps the local values; the next `ocx sync` applies the Home's.
    // Read only: the record is written after the connection commits, so a rollback leaves none.
    const homeSettings = linkMode && linkMetadata && selectedClients.includes("codex")
      ? await fetchHomeCodexSettings({ transport: "link", link: linkMetadata, apiKeyId }, admissionToken, deps.linkHome)
      : undefined;
    const injectConfig = {
      ...(homeSettings?.kind === "fresh" ? overlayHomeCodexSettings(config, homeSettings.document.settings) : config),
      syncResumeHistory: false,
    };
    const beforeCodexWrite = () => {
      assertActiveConnectingState(persisted.fingerprint);
      if (routeIntent && (!connectedRouteSelectedClients(routeIntent, options.selectedClients).includes("codex")
        || loadConfig().port !== config.port)) throw new Error("Codex route intent or runtime changed; retry connect");
    };
    if (!options.noSync && routeIntent && selectedClients.includes("codex") && existsSync(getCodexHome())) {
      const { persistNativeRouteIntent } = await import("./route-intent-apply");
      // Armed before publication: the write-ahead originals record can exist even when the
      // config write or its bookkeeping throws, and rollback must still put the field back.
      restoreNativeIntent = true;
      withClientLifecycleSync(() => withConfigMutationLockSync(() => {
        beforeCodexWrite();
        // Home intent owns a selected installed client, including a standalone OFF. Keep
        // compensation field-scoped: a failed enrollment restores the recorded standalone
        // value, keeps a later edit by the person, and keeps disjoint config changes.
        persistNativeRouteIntent("codex", true, beforeCodexWrite, injectConfig, true);
      }), deps.lifecycleLockDeps);
    }
    const preflight = !selectedClients.includes("codex") || (routeIntent && !existsSync(getCodexHome()))
      ? { success: true, message: "Codex is not selected or installed" } : await injectCodexConfig(config.port, injectConfig, {
      validateOnly: true,
      routingTarget: target,
      catalogPath: DEFAULT_CATALOG_PATH,
      journalOwner: { kind: "client", apiKeyId },
      beforeClientWrite: beforeCodexWrite,
    });
    if (!preflight.success) throw new Error(preflight.message);

    if (!options.noSync && selectedClients.includes("codex") && (!routeIntent || existsSync(getCodexHome()))) {
      const injected = await injectCodexConfig(config.port, injectConfig, {
        routingTarget: target,
        catalogPath: DEFAULT_CATALOG_PATH,
        journalOwner: { kind: "client", apiKeyId },
        beforeClientWrite: beforeCodexWrite,
      });
      if (!injected.success || injected.status === "skipped") throw new Error(injected.message);
      injectionCommitted = true;
      if (!isCodexRoutingInjected()) throw new Error("Codex routing target was not committed");
    }

    const now = (deps.now ?? (() => new Date()))().toISOString();
    const connection: OcxClientConnectionConfig = {
      serverUrl,
      managementUrl,
      managementTransport: options.managementTransport,
      selectedClients: [...selectedClients],
      tokenEnv: "OPENCODEX_API_AUTH_TOKEN",
      apiKeyId,
      tokenFingerprint: persisted.fingerprint,
      protocolVersion: 1,
      connectedAt: now,
      catalogFingerprint: createHash("sha256").update(catalog.body).digest("base64url"),
      // Durable so disconnect — a different process — can put back whatever was here
      // before. The in-memory `priorCatalog` only covers a connect that fails and rolls
      // back in the same run.
      priorCatalog: priorCatalog.kind === "file" ? Buffer.from(priorCatalog.body, "utf8").toString("base64") : "",
      catalogSyncedAt: now,
      ...(linkMode ? { transport: "link" as const, link: linkMetadata } : {}),
    };
    withClientLifecycleSync(() => withConfigMutationLockSync(() => {
      assertActiveConnectingState(persisted.fingerprint);
      if (linkMetadata && options.selectedClientsExplicit) {
        recordInitialRouteIntent(linkMetadata.linkId, routeIntent?.document, options.selectedClients);
        initialSelectionWritten = true;
      }
      // No route apply has begun for this connection; the first one removes this proof.
      if (linkMetadata) writeRouteIntentUnappliedProof(linkMetadata.linkId, connection.connectedAt);
      clearClientConnectPending(persisted.fingerprint);
      commitClientConnection(connection);
      committed = true;
    }), deps.lifecycleLockDeps);
    // Only now does the routing belong to this connection: take over a journal another owner wrote
    // (src/codex/journal.ts adoptJournalForClient). A failure keeps the connection; sync retries.
    if (injectionCommitted) {
      try {
        const adoption = adoptJournalForClient(apiKeyId, () => {
          // Under the Codex lock: still this committed connection (same owner and link) and its
          // token, or write nothing. The stored record is normalized, so identity is compared.
          assertNoClientDisconnectPending();
          const current = readClientConnectionState();
          if (current.kind !== "connected" || !sameClientConnectionOwner(current.value, connection)
            || current.value.link?.linkId !== connection.link?.linkId) throw new Error("client_connection_changed");
          const token = readServiceApiTokenState();
          if (token.kind !== "present" || token.fingerprint !== connection.tokenFingerprint) throw new Error("client_token_changed");
        });
        if (journalHandoverIncomplete(adoption)) console.warn(FOREIGN_JOURNAL_WARNING);
      }
      catch { console.warn("Warning: the Codex journal could not be handed to this connection; run 'ocx sync' so a supervised restart keeps Codex routing."); }
    }
    // Recorded only when the injection that applied it ran (not with --no-sync). The connection is
    // already committed, so a failed record write must not reach the rollback below: it is a
    // warning, and `ocx status` reports no recorded apply until `ocx sync` writes one.
    if (homeSettings?.kind === "fresh" && linkMetadata && injectionCommitted) {
      try {
        writeHomeCodexSettingsRecord(homeCodexSettingsReceipt(
          linkMetadata.linkId, homeSettings.document, now, (deps.now ?? (() => new Date()))().toISOString(), null,
        ));
      } catch {
        console.warn("Warning: the Home's Codex settings were applied, but the apply record was not written; run 'ocx sync' to record it.");
      }
    }
    if (!options.noSync && routeIntent) {
      // The connection is committed: nothing from here on may reach the enrollment rollback below,
      // including a lifecycle lock another operation holds now or a connection it already changed.
      // Either one leaves the route apply to the next sync, which reconciles the current connection.
      try {
        const appliedConnection = withClientLifecycleSync(() => {
          const current = readClientConnectionState();
          if (current.kind !== "connected" || !Bun.deepEquals(current.value, connection, true)) throw new Error("client_connection_changed");
          return current.value;
        }, deps.lifecycleLockDeps);
        await applyConnectedRouteIntent(connection, admissionToken, routeIntent, {
        codexApplied: injectionCommitted, lifecycleLockDeps: deps.lifecycleLockDeps, beforeWrite: () => {
          deps.signal?.throwIfAborted(); assertClientConnectionUnchanged(appliedConnection);
          const token = readServiceApiTokenState();
          if (token.kind !== "present" || token.fingerprint !== connection.tokenFingerprint) throw new Error("client_token_changed");
        },
        }, deps.linkHome);
      } catch { console.warn("Warning: local route intent needs reconciliation; run 'ocx route to sync'."); }
    }
    return connection;
  } catch (error) {
    const rollbackFailures: string[] = [];
    if (injectionCommitted) {
      const restored = restoreJournalState();
      if (!restored.complete) rollbackFailures.push("Codex journal restore was partial");
    }
    try {
      withClientLifecycleSync(() => withConfigMutationLockSync(() => {
        assertNoClientDisconnectPending();
        if (initialSelectionWritten && !committed && linkMetadata) {
          try { clearInitialRouteIntent(linkMetadata.linkId); }
          catch { rollbackFailures.push("initial route selection rollback unavailable"); }
        }
        // Bound to a connection that never committed, so it could never match; remove it anyway.
        if (!committed && linkMetadata) { try { clearRouteIntentUnappliedProof(); } catch { /* matches nothing */ } }
        let nativeRestoreFailed = false;
        if (restoreNativeIntent && !committed && pendingConnectFingerprint) {
          const fingerprint = pendingConnectFingerprint;
          try { restoreNativeIntentOriginals(() => assertConnectingState(fingerprint)); }
          catch {
            // Like disconnect, keep the token (and the marker proving it is this attempt's) until the
            // standalone switches are back; ocx disconnect finishes this rollback.
            nativeRestoreFailed = true;
            rollbackFailures.push(`Standalone native switches were not restored, so the enrollment token was kept. Repair the config or ${nativeIntentOriginalsPath()}, then run ocx disconnect to finish the rollback.`);
          }
        }
        if (priorCatalog && writtenCatalogFingerprint && !restoreCatalogSnapshot(priorCatalog, writtenCatalogFingerprint)) {
          rollbackFailures.push("catalog rollback did not match the written artifact");
        }
        if (pendingConnectFingerprint && !nativeRestoreFailed) {
          const removed = removeServiceApiTokenFileIfOwned(pendingConnectFingerprint);
          if (removed === "changed") rollbackFailures.push("service token changed during rollback");
          // Final commit may fail after this attempt already cleared its marker under the same lock.
          else if (pendingClientConnectMayOwnToken(pendingConnectFingerprint)) clearClientConnectPending(pendingConnectFingerprint);
        }
      }), deps.lifecycleLockDeps);
    } catch { rollbackFailures.push("client cleanup ownership unavailable"); }
    let remoteCleanup: string | null = null;
    if (issued && cleanupCredential && managementUrl) {
      remoteCleanup = await cleanupIssuedKey(managementUrl, cleanupCredential, issued.id, deps);
    }
    const base = error instanceof Error ? error.message : String(error);
    const details = [
      ...rollbackFailures,
      ...(remoteCleanup ? [remoteCleanup] : []),
    ];
    throw new Error(details.length > 0 ? `${base}. ${details.join(" ")}` : base, { cause: error });
  } finally {
    releaseConnectCredential(options.credential);
    cleanupCredential = null;
    issued = null;
    if (!committed) {
      tokenFingerprint = null;
      priorCatalog = null;
      writtenCatalogFingerprint = null;
    }
  }
}

export interface ConnectedSyncResult {
  routeIntent?: RouteIntentReceipt;
  catalogWritten: boolean;
  cacheSynced: boolean;
  injected: boolean;
  stale: boolean;
  homeSettings?: HomeCodexSettingsSource;
  /** The apply record this sync committed or kept (link Child with Home settings only). */
  appliedRecord?: HomeCodexSettingsRecord;
  /** The Home's settings were injected but their record could not be written (OCX-6). */
  applyRecordFailed?: true;
  /** Routing was injected but the Codex journal stayed with its previous owner; sync again. */
  journalHandoverFailed?: true;
  /**
   * The connection this sync ran under, read inside its lock and compare-and-swapped on every
   * write. Callers decide link-vs-hub wording and restart ownership from this, never from a read
   * they made before the lock.
   */
  connection: OcxClientConnectionConfig;
}

export interface ConnectedSyncOptions {
  restartCodex?: boolean;
  overwriteConflict?: boolean;
  overwriteClient?: import("../link/route-intent").RouteClientId;
  /**
   * #7694: refuse unless this is the connection found under the lock. A mismatch throws
   * `ClientSyncExpectationError` before any request or write.
   */
  expect?: ClientSyncExpectation;
}

/**
 * Refresh the catalog and Codex config from the hub or Home. Every sync holds the apply lock
 * (OCX-6), so a sync that finds a link connection inside, whatever an earlier unlocked read said,
 * never interleaves with another apply, and its record names what its own injection wrote.
 */
export async function syncConnectedClient(
  options: ConnectedSyncOptions = {},
  deps: ClientConnectDeps = {},
): Promise<ConnectedSyncResult> {
  let checked = false;
  try {
    return await withLinkApply(() => syncConnectedClientUnlocked(options, deps, () => { checked = true; }), deps.linkApplyLockPath);
  } catch (error) {
    // #7694: a pinned sync that cannot take a lock its check needs (a link connect holds the apply
    // lock across its network reads) is refused as pending, with nothing written; it never surfaces
    // as a generic failure the caller cannot tell from a broken sync.
    if (options.expect && !checked && isClientSyncLockBusy(error)) {
      throw new ClientSyncExpectationError(options.expect, "pending_operation");
    }
    throw error;
  }
}

async function syncConnectedClientUnlocked(
  options: ConnectedSyncOptions = {},
  deps: ClientConnectDeps = {},
  markChecked: () => void = () => {},
): Promise<ConnectedSyncResult> {
  if (siblingOfLivePort() !== null) throw new Error(siblingSkipMessage());
  const initial = withClientLifecycleSync(() => withConfigMutationLockSync(() => {
    // The expectation is checked by the read that selects this path; everything after is
    // compare-and-swapped against the connection it passed (#7694).
    if (options.expect) {
      assertClientSyncExpectation(options.expect);
      markChecked();
    }
    assertNoClientDisconnectPending();
    const state = readClientConnectionState();
    if (state.kind !== "connected" || state.value.pendingOperation) throw new Error("client_sync_unavailable");
    const token = readServiceApiTokenState();
    if (token.kind !== "present" || token.fingerprint !== state.value.tokenFingerprint) throw new Error("client_token_changed");
    let assertRuntimeCurrent = () => {};
    try { if (isLinkConnection(state.value)) assertRuntimeCurrent = clientSyncRuntimeGuard(); }
    catch (error) {
      if (options.expect && error instanceof ClientSyncRuntimeError && error.code === "client_runtime_stopping") {
        throw new ClientSyncExpectationError(options.expect, "pending_operation");
      }
      throw error;
    }
    return { connection: state.value, token, assertRuntimeCurrent };
  }), deps.lifecycleLockDeps);
  let downloaded: Awaited<ReturnType<typeof downloadClientCatalog>> | undefined;
  let stale = false;
  try {
    downloaded = await downloadClientCatalog(initial.connection.serverUrl, initial.token.token, { fetchImpl: deps.fetchImpl });
  } catch (error) {
    const transient = error instanceof HubClientError
      && (error.code === "unreachable" || (error.status !== undefined && error.status >= 500));
    if (!transient) throw error;
    stale = true;
  }
  // Same gate as connect (#4207): a sync must never replace a catalog the local CLI can parse
  // with one it cannot. Refusing leaves the connection and the existing catalog exactly as
  // they were, which is the known-good state.
  if (downloaded) assertClientCatalogCompatible(downloaded.body, deps.catalogCompatibility);
  const routeIntent = await prepareConnectedRouteIntent(initial.connection, initial.token.token, deps.linkHome, () => {
    initial.assertRuntimeCurrent(); assertClientConnectionUnchanged(initial.connection);
  });
  const next = withClientLifecycleSync(() => withConfigMutationLockSync(() => {
    initial.assertRuntimeCurrent();
    assertClientConnectionUnchanged(initial.connection);
    const token = readServiceApiTokenState();
    if (token.kind !== "present" || token.fingerprint !== initial.token.fingerprint) throw new Error("client_token_changed");
    if (!downloaded) validLocalCatalog();
    else atomicWriteFile(DEFAULT_CATALOG_PATH, downloaded.body);
    const updated = {
      ...initial.connection,
      selectedClients: [...connectedRouteSelectedClients(routeIntent, initial.connection.selectedClients)],
      ...(downloaded ? { catalogFingerprint: createHash("sha256").update(downloaded.body).digest("base64url"),
        catalogSyncedAt: (deps.now ?? (() => new Date()))().toISOString() } : {}),
    };
    commitClientConnection(updated);
    return updated;
  }), deps.lifecycleLockDeps);
  // Read-only: injection invokes this while N/C are held. Acquiring L here would invert C→L.
  const beforeClientWrite = () => {
    initial.assertRuntimeCurrent();
    if (isLinkConnection(next)) assertRouteIntentPort(loadConfig().port);
    assertClientConnectionUnchanged(next);
    const token = readServiceApiTokenState();
    if (next.pendingOperation || token.kind !== "present" || token.fingerprint !== next.tokenFingerprint) throw new Error("client_token_changed");
  };
  const withClientWrite = <T>(write: () => T): T => withConfigMutationLockSync(() => { beforeClientWrite(); return write(); });
  let injected = false;
  let homeSettings: HomeCodexSettingsSource | undefined;
  let appliedRecord: HomeCodexSettingsRecord | undefined;
  let applyRecordFailed = false;
  let journalHandoverFailed = false;
  if (next.selectedClients.includes("codex") && (!routeIntent || existsSync(getCodexHome()))) {
    const beforeCodexWrite = () => {
      beforeClientWrite();
      if (routeIntent && !connectedRouteSelectedClients(routeIntent, next.selectedClients).includes("codex")) {
        throw new Error("Codex route intent changed; retry sync");
      }
    };
    let config = loadConfig();
    // #6957: a link Child applies the Home's OpenCodex-owned Codex settings with the catalog.
    if (isLinkConnection(next)) {
      homeSettings = await resolveHomeCodexSettings(next, initial.token.token, { ...deps.linkHome, withWriteGuard: withClientWrite });
      if (homeSettings.source !== "local") config = overlayHomeCodexSettings(config, homeSettings.document.settings);
      // About to write different settings: until their record commits, report no applied digest
      // rather than the previous one (OCX-6). A failed injection then reads "unknown", never a
      // digest of values Codex no longer has or never got.
      if (homeSettings.source === "home" && next.link) {
        const { linkId } = next.link, { document } = homeSettings;
        withClientWrite(() => withdrawChangingHomeCodexSettingsRecord(linkId, document));
      }
    }
    // Off persisted false. Reconcile the effective Home intent before the injector rereads
    // that durable gate, retaining local opt-outs and the owner/runtime/token commit fences.
    if (routeIntent) {
      const { persistNativeRouteIntent } = await import("./route-intent-apply");
      withClientLifecycleSync(() => persistNativeRouteIntent("codex", true, beforeCodexWrite, config, true), deps.lifecycleLockDeps);
    }
    const result = await injectCodexConfig(config.port, { ...config, syncResumeHistory: false }, {
      routingTarget: routingTarget(next.serverUrl, isLinkConnection(next) ? config.port : undefined, config), catalogPath: DEFAULT_CATALOG_PATH,
      journalOwner: { kind: "client", apiKeyId: next.apiKeyId }, beforeClientWrite: beforeCodexWrite,
    });
    if (!result.success || result.status === "skipped") throw new Error(result.message);
    injected = result.configApplied !== false;
    // An external provider can preserve config.toml without applying even the same Home digest.
    // Withdraw any previous receipt under the current connection fence before reporting parity.
    if (!injected && next.link) withClientWrite(clearHomeCodexSettingsRecord);
    if (injected) {
      // A committed connection re-injected: own the journal too (retries a takeover connect missed),
      // under the same connection guard as the injection, so a stale sync claims nothing.
      try {
        const adoption = adoptJournalForClient(next.apiKeyId, beforeCodexWrite);
        // No journal or another client's means the routing is not this connection's to keep.
        if (journalHandoverIncomplete(adoption)) journalHandoverFailed = true;
      } catch { journalHandoverFailed = true; }
    }
    if (injected && homeSettings && next.link) {
      const linkId = next.link.linkId;
      const settings = homeSettings;
      try {
        appliedRecord = withClientLifecycleSync(() => withClientWrite(() =>
          recordHomeCodexSettings(linkId, settings, deps.now) ?? readHomeCodexSettingsRecord(linkId) ?? undefined), deps.lifecycleLockDeps);
      } catch (error) {
        // An ownership change is not a disk problem: report it as itself.
        if (error instanceof ClientSyncRuntimeError || (error instanceof Error && (error.message === "client_token_changed" || error.message === "client_connection_changed"))) throw error;
        // The injection committed, so the cache refresh below still runs; the caller reports this.
        try { withClientWrite(clearHomeCodexSettingsRecord); } catch { /* status already reads no recorded apply or reports the write */ }
        applyRecordFailed = true;
      }
    }
  }
  const routeReceipt = await applyConnectedRouteIntent(next, initial.token.token, routeIntent,
    { beforeWrite: beforeClientWrite, codexApplied: injected, lifecycleLockDeps: deps.lifecycleLockDeps,
      overwriteConflict: options.overwriteConflict, overwriteClient: options.overwriteClient }, deps.linkHome);
  const cacheSynced = withClientLifecycleSync(() => {
    // Acquire K before the guarded C commit; never acquire K from inside C.
    const owningHome = getCodexHome();
    const result = withCatalogWriteSerialization(owningHome, permit => withClientWrite(() =>
      invalidateCodexModelsCacheWithPermit(permit, owningHome, { allowWhenDesiredDisabled: true })),
    { intent: "cache", writer: "cache-invalidate" });
    return result.kind === "completed" && result.value;
  }, deps.lifecycleLockDeps);
  return {
    catalogWritten: downloaded !== undefined, cacheSynced, injected, stale: stale || routeReceipt?.catalogPending === true || routeIntent?.stale === true,
    ...(homeSettings ? { homeSettings } : {}),
    ...(appliedRecord ? { appliedRecord } : {}),
    ...(applyRecordFailed ? { applyRecordFailed } : {}),
    ...(routeReceipt ? { routeIntent: routeReceipt } : {}),
    ...(journalHandoverFailed ? { journalHandoverFailed: true as const } : {}),
    connection: next,
  };
}

/**
 * Put the catalog back the way connect found it.
 *
 * Not a delete. Connect overwrites whatever catalog was already there, so removing the
 * remote one leaves the user with nothing — and disconnect still reports that native Codex
 * state was restored. If the connection recorded a prior catalog, it is rewritten;
 * `priorCatalog: ""` means there genuinely was none and removal is the restoration.
 *
 * Still ownership-checked first: a catalog the user edited or replaced since connect is
 * theirs, and `changed` refuses rather than overwriting it.
 */
function restorePriorCatalog(connection: OcxClientConnectionConfig): "removed" | "restored" | "absent" | "changed" {
  if (!existsSync(DEFAULT_CATALOG_PATH)) return "absent";
  try {
    const body = validLocalCatalog();
    if (!catalogMatchesFingerprint(body, connection.catalogFingerprint)) return "changed";
    if (connection.priorCatalog) {
      atomicWriteFile(DEFAULT_CATALOG_PATH, Buffer.from(connection.priorCatalog, "base64").toString("utf8"));
      return "restored";
    }
    // Undefined means the connection predates this field: the pre-connect catalog was
    // never recorded, so removal is the only honest option and matches the old behavior.
    unlinkSync(DEFAULT_CATALOG_PATH);
    return "removed";
  } catch {
    return "changed";
  }
}

const DISCONNECT_PHASES: readonly DesktopDisconnectReceipt["phase"][] = [
  "prepared", "desktop_restored", "catalog_settled", "removing_token", "token_removed", "clearing_connection", "connection_cleared", "complete",
];

function disconnectAtLeast(receipt: DesktopDisconnectReceipt, phase: DesktopDisconnectReceipt["phase"]): boolean {
  return DISCONNECT_PHASES.indexOf(receipt.phase) >= DISCONNECT_PHASES.indexOf(phase);
}

const FOREIGN_JOURNAL_WARNING = "Warning: the Codex journal belongs to an earlier connection, so the next OpenCodex restart restores native Codex routing. After that restart, run 'ocx sync --restart-codex' to point Codex at this connection again.";

function catalogIsRecordedPrior(connection: OcxClientConnectionConfig, snapshot: CatalogSnapshot): boolean {
  return snapshot.kind === "file" && !!connection.priorCatalog
    && snapshot.fingerprint === sha256(Buffer.from(connection.priorCatalog, "base64").toString("utf8"));
}

function preflightDisconnectCatalog(connection: OcxClientConnectionConfig, keepCatalog: boolean): void {
  const snapshot = catalogSnapshot();
  if (!keepCatalog && snapshot.kind === "file"
    && !catalogMatchesFingerprint(snapshot.body, connection.catalogFingerprint)
    && !catalogIsRecordedPrior(connection, snapshot)) throw new Error("client_catalog_ownership_changed");
}

function catalogAfterState(): NonNullable<DesktopDisconnectReceipt["catalogAfter"]> {
  const snapshot = catalogSnapshot();
  return snapshot.kind === "absent" ? { kind: "absent" } : { kind: "file", fingerprint: snapshot.fingerprint };
}

function verifyDisconnectCatalog(receipt: DesktopDisconnectReceipt): void {
  if (!receipt.catalogAfter || JSON.stringify(catalogAfterState()) !== JSON.stringify(receipt.catalogAfter)) {
    throw new Error("client_catalog_changed_during_disconnect");
  }
}

function restoreConnectedCodex(connection: OcxClientConnectionConfig, receipt: DesktopDisconnectReceipt, recoverConfig = false): string | undefined {
  const inspection = readCodexHomeJournal(JOURNAL_PATH);
  const owner = journalOwner({ readOnly: true });
  const explicitOwner = inspection.kind === "read" ? inspection.journal.owner as Record<string, unknown> | undefined : undefined;
  const invalidOwner = explicitOwner !== undefined && (!explicitOwner || typeof explicitOwner !== "object" || Array.isArray(explicitOwner)
    || !(explicitOwner.kind === "client" && typeof explicitOwner.apiKeyId === "string" && explicitOwner.apiKeyId.length > 0
      || explicitOwner.kind === "process" && typeof explicitOwner.pid === "number" && Number.isSafeInteger(explicitOwner.pid) && explicitOwner.pid > 0));
  if (inspection.kind === "unknown" || invalidOwner || (inspection.kind === "read" && owner === null)) {
    throw new Error("disconnect refused: Codex journal ownership is unknown; journal and connection credentials were retained");
  }
  // Deselection records desired state, not completed cleanup. A failed off still leaves
  // this client's journal to drain; an unrelated process journal grants no such authority.
  if (!connection.selectedClients.includes("codex") && owner?.kind !== "client") {
    if (inspection.kind === "missing" && isCodexRoutingInjected()) {
      throw new Error("disconnect refused: Codex routing is injected but no journal records the original state");
    }
    return;
  }
  if (owner && owner.kind === "client" && owner.apiKeyId !== connection.apiKeyId) {
    throw new Error("disconnect refused: Codex journal ownership conflicts with the connected key");
  }
  if (owner !== null) {
    const restored = restoreJournalState({ preserveConfigEdits: true,
      ...(recoverConfig ? { recoverConfigForClient: connection.apiKeyId } : {}),
      beforeWrite: () => {
        const state = readClientConnectionState(), currentReceipt = readDesktopDisconnectReceipt();
        const token = readServiceApiTokenState();
        if (state.kind !== "connected" || JSON.stringify(state.value) !== JSON.stringify(connection)
          || currentReceipt.kind !== "valid" || JSON.stringify(currentReceipt.value) !== JSON.stringify(receipt)
          || token.kind !== "present" || token.fingerprint !== receipt.tokenFingerprint) throw new Error("client_disconnect_owner_changed");
      },
    });
    if (!restored.complete) throw new Error(
      "disconnect refused: Codex journal restore was partial; journal and connection credentials were retained. "
      + "Retry 'ocx disconnect --recover-config --yes' to privately back up current Codex config/profile and restore only evidenced OCX-owned fields (retain --keep-catalog if originally requested). "
      + "Unknown ownership and edited or unverified profiles remain refused.",
    );
    return restored.recoveryBackupDir;
  } else if (isCodexRoutingInjected()) {
    throw new Error("disconnect refused: Codex routing is injected but no journal records the original state");
  }
}

/**
 * `ocx disconnect --expect-link <id>`: refuse unless this machine is connected to that link (the same
 * check `ocx sync --expect-link` makes), read-only under the client lifecycle and config locks. A Home's
 * delayed revoke of an old link then cannot disconnect a newer one. Throws ClientSyncExpectationError.
 */
export function assertDisconnectExpectation(linkId: string, deps: Pick<ClientConnectDeps, "lifecycleLockDeps"> = {}): void {
  withClientLifecycleSync(() => withConfigMutationLockSync(() => assertHomeInitiatedDisconnect(linkId)), deps.lifecycleLockDeps);
}

/**
 * The link expectation, then the Home-initiated check: a Home sends --expect-link only for Home-initiated links, and
 * a client-initiated one needs the client-link teardown that path skips. Its sidecar, or the marker that survives a
 * lost sidecar, naming this link refuses it (client_initiated_link); an unreadable sidecar or marker refuses too.
 * When this link's own unfinished disconnect is on record (the expectation let it resume), the refusal says
 * disconnect_pending instead: an earlier attempt may have cleaned part of the Child, and the Home must count the
 * cleanup as attempted. Read-only; the caller holds the client lifecycle and config mutation locks.
 */
function assertHomeInitiatedDisconnect(linkId: string): void {
  assertDisconnectLinkExpectation(linkId);
  let reason: "client_initiated_link" | "invalid_state" | null;
  // An unreadable sidecar or marker refuses as invalid_state: it proves nothing about who joined.
  try {
    const marker = readChildLinkMarker();
    reason = marker.kind === "unreadable" ? "invalid_state"
      : readClientLinkState()?.linkId === linkId || (marker.kind === "link" && marker.linkId === linkId) ? "client_initiated_link" : null;
  } catch { reason = "invalid_state"; }
  if (!reason) return;
  const receipt = readDesktopDisconnectReceipt();
  throw new ClientSyncExpectationError({ kind: "link", linkId }, receipt.kind === "valid" && receipt.value.phase !== "complete" ? "disconnect_pending" : reason);
}

/**
 * A disconnected machine with no unfinished disconnect can still hold the standalone native
 * switches an interrupted or failed enrollment displaced, and the token that enrollment kept
 * because it could not restore them. Plain `ocx disconnect` restores the switches, then removes
 * that token only while the pending-connect marker proves it is the enrollment's own.
 * `ocx disconnect --orphaned-token` never touches the record.
 */
function drainLoneNativeIntentOriginals(lifecycleLockDeps?: ClientLifecycleLockDeps): {
  restored: true; tokenRemoved: boolean; catalogRemoved: false; catalogRestored: false; apiKeyId: string; restartRequired: false; nativeIntentOnly: true;
} | null {
  const refused = (error: unknown) => new Error(`disconnect refused: the standalone native switches recorded in ${nativeIntentOriginalsPath()} were not restored (${error instanceof Error ? error.message : String(error)}). Repair the config or that record (remove it only after setting the switches by hand), then rerun ocx disconnect.`);
  return withClientLifecycleSync(() => withConfigMutationLockSync(() => {
    const read = readDesktopDisconnectReceipt();
    if (read.kind === "unsafe" || (read.kind === "valid" && read.value.phase !== "complete")) return null;
    if (readClientConnectionState().kind !== "disconnected") return null;
    let present: boolean;
    try { present = readNativeIntentOriginals() !== null; } catch (error) { throw refused(error); }
    if (!present) return null;
    try {
      restoreNativeIntentOriginals(() => {
        assertNoClientDisconnectPending();
        if (readClientConnectionState().kind !== "disconnected") throw new Error("client_connection_changed");
      });
    } catch (error) { throw refused(error); }
    const token = readServiceApiTokenState();
    let tokenRemoved = false;
    if (token.kind === "present" && pendingClientConnectMayOwnToken(token.fingerprint)) {
      const removed = removeServiceApiTokenFileIfOwned(token.fingerprint);
      if (removed === "changed") throw new Error("client_token_changed");
      tokenRemoved = removed === "removed";
      clearClientConnectPending(token.fingerprint);
    }
    return { restored: true, tokenRemoved, catalogRemoved: false, catalogRestored: false, apiKeyId: "", restartRequired: false, nativeIntentOnly: true };
  }), lifecycleLockDeps);
}

export async function disconnectClient(
  options: { keepCatalog?: boolean; expectedOwner?: DesktopRemoteOwner; expectLink?: string; recoverConfig?: boolean } = {},
  deps: Pick<ClientConnectDeps, "lifecycleLockDeps"> = {},
): Promise<{
  restored: boolean; tokenRemoved: boolean; catalogRemoved: boolean; catalogRestored: boolean; apiKeyId: string;
  desktopRestoration?: "owned_projection" | "standard_fallback" | "selection_preserved";
  restartRequired: boolean;
  recoveryBackupDir?: string;
  /** Only standalone native switches an interrupted enrollment displaced were restored. */
  nativeIntentOnly?: true;
}> {
  if (siblingOfLivePort() !== null) throw new Error(siblingSkipMessage());
  // A link-bound disconnect changes nothing on a machine that is not connected to that link, so it never drains here.
  if (!options.expectedOwner && options.expectLink === undefined) {
    // It restores config-root switches under the lifecycle lock, so it admits after overlapping
    // config-root ACL work like both phases below (#7815).
    const drained = await withConfigDirHardeningSettled(getConfigDir(), () => drainLoneNativeIntentOriginals(deps.lifecycleLockDeps));
    if (drained) return drained;
  }
  const keepCatalog = options.keepCatalog === true;
  // Both phases write the disconnect receipt and the remote Desktop store under the config root
  // with required ACLs, so each admits after overlapping config-root ACL work (#7815). A timeout
  // before phase 1 writes nothing; one before phase 2 leaves the prepared receipt it resumes from.
  const prepared = await withConfigDirHardeningSettled(getConfigDir(), () => withClientLifecycleSync(held => withConfigMutationLockSync(() => {
    // Checked first, under the same locks, before anything is read for writing or written.
    if (options.expectLink !== undefined) assertHomeInitiatedDisconnect(options.expectLink);
    const read = readDesktopDisconnectReceipt();
    if (read.kind === "unsafe") throw new Error("client_disconnect_receipt_unsafe");
    const state = readClientConnectionState();
    const previous = read.kind === "valid" ? read.value : null;
    const observedOwner = state.kind === "connected" ? desktopOwner(state.value) : previous?.owner;
    if (options.expectedOwner && (!observedOwner || !sameClientConnectionOwner(observedOwner, options.expectedOwner))) {
      throw new Error("client_disconnect_expected_owner_changed");
    }
    let receipt = previous;
    let connection: OcxClientConnectionConfig | null = null;
    if (state.kind === "connected") {
      connection = state.value;
      if (connection.pendingOperation) throw new Error("client_rotation_recovery_required");
      if (receipt?.phase === "complete" && !sameClientConnectionOwner(receipt.owner, connection)) receipt = null;
      if (receipt && !sameClientConnectionOwner(receipt.owner, connection)) throw new Error("client_disconnect_owner_changed");
      if (receipt?.phase === "complete") throw new Error("client_disconnect_completed_owner_reappeared");
      const token = readServiceApiTokenState();
      const expectedFingerprint = receipt?.tokenFingerprint ?? connection.tokenFingerprint;
      if (connection.tokenFingerprint !== expectedFingerprint
        || (token.kind === "present" ? token.fingerprint !== expectedFingerprint
          : token.kind !== "absent" || !receipt || !disconnectAtLeast(receipt, "removing_token"))) {
        throw new Error("client_token_changed");
      }
      if (!receipt) {
        const desktop = inspectRemoteDesktopStore(desktopOwner(connection));
        if (desktop.reason === "root_without_state") {
          throw new Error(`desktop_lifecycle_unsafe: ${desktop.path} exists but holds no Claude Desktop remote state or disconnect receipt (a leftover or renamed file), so disconnect cannot tell what it would restore. Move that folder aside, then run ocx disconnect again.`);
        }
        if (desktop.kind === "unsafe" || desktop.kind === "conflict") throw new Error(`desktop_lifecycle_unsafe: the Claude Desktop remote profile store could not be verified (${desktop.kind}); nothing was changed.`);
        preflightDisconnectCatalog(connection, keepCatalog);
        receipt = { version: 1, owner: desktopOwner(connection), tokenFingerprint: connection.tokenFingerprint, keepCatalog, phase: "prepared" };
        writeDesktopDisconnectReceipt(held, previous, receipt);
      }
    } else if (state.kind !== "disconnected" || !receipt || !disconnectAtLeast(receipt, "clearing_connection")) {
      throw new Error("disconnect refused: no recoverable connected state; if this is not a Hub and no admission secret or installed service uses the token, inspect it and use ocx disconnect --orphaned-token --yes");
    }
    if (!receipt || receipt.keepCatalog !== keepCatalog) throw new Error("client_disconnect_options_changed");
    return { receipt, connection };
  }), deps.lifecycleLockDeps));

  // This sibling step owns only file integrations; failures retain the prepared receipt/token.
  if (prepared.connection?.transport === "link" && !disconnectAtLeast(prepared.receipt, "desktop_restored")) {
    // It writes the route receipt and file integrations under the config root, so it admits after
    // overlapping config-root ACL work like both disconnect phases (#7815).
    const connection = prepared.connection;
    await withConfigDirHardeningSettled(getConfigDir(), () => cleanupConnectedRouteIntent(connection, prepared.receipt, deps.lifecycleLockDeps, options.recoverConfig === true));
  }
  // The prepared receipt blocks even a sync queued for its actual N/C injection commit.
  // Codex-only restore MUST stay outside L; it never invokes Desktop cleanup.
  const recoveryBackupDir = prepared.connection && !disconnectAtLeast(prepared.receipt, "desktop_restored")
    ? restoreConnectedCodex(prepared.connection, prepared.receipt, options.recoverConfig === true) : undefined;

  return withConfigDirHardeningSettled(getConfigDir(), () => withClientLifecycleSync(held => withConfigMutationLockSync(() => {
    const read = readDesktopDisconnectReceipt();
    if (read.kind !== "valid" || JSON.stringify(read.value) !== JSON.stringify(prepared.receipt)) {
      throw new Error("client_disconnect_receipt_changed");
    }
    let receipt = read.value;
    const state = readClientConnectionState();
    let connection: OcxClientConnectionConfig | null = null;
    if (state.kind === "connected") {
      if (!sameClientConnectionOwner(state.value, receipt.owner) || state.value.pendingOperation
        || state.value.tokenFingerprint !== receipt.tokenFingerprint) throw new Error("client_disconnect_owner_changed");
      connection = state.value;
    } else if (state.kind !== "disconnected" || !disconnectAtLeast(receipt, "clearing_connection")) {
      throw new Error("client_disconnect_owner_changed");
    }
    const token = readServiceApiTokenState();
    if (token.kind === "present" ? token.fingerprint !== receipt.tokenFingerprint
      : token.kind !== "absent" || !disconnectAtLeast(receipt, "removing_token")) throw new Error("client_token_changed");
    const advance = (phase: DesktopDisconnectReceipt["phase"], fields: Partial<DesktopDisconnectReceipt> = {}) => {
      const next = { ...receipt, ...fields, phase };
      writeDesktopDisconnectReceipt(held, receipt, next);
      receipt = next;
    };
    let desktop: Extract<DesktopStoreResult, { ok: true }>;
    if (!disconnectAtLeast(receipt, "desktop_restored")) {
      desktop = requireDesktopResult(restoreRemoteDesktopStore(held, {
        owner: receipt.owner, knownTokenFingerprints: [receipt.tokenFingerprint],
      }));
      advance("desktop_restored", desktop.fingerprint ? { desktopAfterFingerprint: desktop.fingerprint } : {});
    } else {
      // A retry after token/config removal must verify the completed projection,
      // not invoke a mutator that needs the now-removed connection credential.
      const inspected = inspectRemoteDesktopStore(receipt.owner);
      if (inspected.kind !== "restored" && !(inspected.kind === "absent"
        && (!receipt.desktopAfterFingerprint || receipt.phase === "complete"))) {
        throw new Error("desktop_disconnect_after_state_changed");
      }
      desktop = { ok: true, changed: false, status: inspected.kind === "absent" ? "absent" : "restored",
        restartRequired: receipt.desktopAfterFingerprint !== undefined };
    }
    if (!disconnectAtLeast(receipt, "catalog_settled")) {
      if (!connection) throw new Error("client_disconnect_catalog_context_missing");
      preflightDisconnectCatalog(connection, keepCatalog);
      const snapshot = catalogSnapshot();
      if (!keepCatalog && snapshot.kind !== "absent" && !catalogIsRecordedPrior(connection, snapshot)) {
        if (restorePriorCatalog(connection) === "changed") throw new Error("client_catalog_ownership_changed");
      }
      advance("catalog_settled", { catalogAfter: catalogAfterState() });
    } else verifyDisconnectCatalog(receipt);
    if (connection?.transport === "link" && !disconnectAtLeast(receipt, "removing_token")) {
      if (connection.link) clearInitialRouteIntent(connection.link.linkId);
      clearHomeRouteIntentRecord();
      // Its clients were restored by the route cleanup above, which phase gating never reruns.
      clearFileIntentOriginals();
      if (readRouteIntentReceiptStrict()?.linkId === connection.link?.linkId) clearRouteIntentReceipt();
      clearRouteIntentUnappliedProof();
    }
    // Standalone native switches come back before the token that displaced them is removed.
    // The record is machine-scoped, so any transport drains one a crashed enrollment left.
    // The locks and the receipt checked above already fence this; a retry is idempotent.
    if (!disconnectAtLeast(receipt, "removing_token")) restoreNativeIntentOriginals(() => {});
    if (!disconnectAtLeast(receipt, "removing_token")) advance("removing_token");
    const tokenRemoval = removeServiceApiTokenFileIfOwned(receipt.tokenFingerprint);
    if (tokenRemoval === "changed") throw new Error("client_token_changed");
    if (!disconnectAtLeast(receipt, "token_removed")) advance("token_removed");
    if (!disconnectAtLeast(receipt, "clearing_connection")) advance("clearing_connection");
    if (clearClientConnection(receipt.owner) === "conflict") throw new Error("client_disconnect_owner_changed");
    if (!disconnectAtLeast(receipt, "connection_cleared")) advance("connection_cleared");
    if (connection?.transport === "link" && connection.link) {
      // A corrupt sidecar is left in place: the connection is already cleared, the client runtime
      // will not start a tunnel for a disconnected client, and the next join overwrites the file.
      let sidecarLinkId: string | null = null;
      try {
        sidecarLinkId = readClientLinkState()?.linkId ?? null;
      } catch (error) {
        if (!(error instanceof ClientLinkStateError)) throw error;
      }
      if (sidecarLinkId === connection.link.linkId) clearClientLinkState(connection.link.linkId);
      try { clearHomeCodexSettingsRecord(); } catch { /* derived data; never fails a disconnect */ }
    }
    removeHubStateCache();
    requireDesktopResult(finishRemoteDesktopCleanup(held, receipt.owner));
    if (receipt.phase !== "complete") advance("complete");
    return {
      ...(recoveryBackupDir ? { recoveryBackupDir } : {}),
      restored: true, tokenRemoved: tokenRemoval === "removed",
      catalogRemoved: !keepCatalog, catalogRestored: !keepCatalog && receipt.catalogAfter?.kind === "file",
      apiKeyId: receipt.owner.apiKeyId, restartRequired: desktop.restartRequired,
      ...(desktop.restoration ? { desktopRestoration: desktop.restoration } : {}),
    };
  }), deps.lifecycleLockDeps));
}

/**
 * Drop the cached hub-state document (#4236).
 *
 * It is derived data from a connection that no longer exists, and it is owner-stamped, so a
 * reader would reject it anyway — but leaving it behind means `<OPENCODEX_HOME>/hub-state.json`
 * keeps naming the previous hub's providers and logins on a machine that is no longer connected
 * to anything, which is exactly the wrong artifact to leave where someone might read it.
 *
 * Best effort and unconditional on the phase: the disconnect has already succeeded by this point,
 * and a cache file that cannot be removed must not fail it or block a retry.
 */
function removeHubStateCache(): void {
  try {
    unlinkSync(hubStateCachePath());
  } catch { /* absent, or not ours to remove */ }
}

export async function revokeConnectedClientKey(
  credential: { kind: "admin"; value: Uint8Array },
  deps: ClientConnectDeps = {},
): Promise<{ apiKeyId: string }> {
  try {
    return await withClientLifecycle(async () => {
      assertNoClientDisconnectPending();
      const state = readClientConnectionState();
      if (state.kind !== "connected" || state.value.pendingOperation) throw new Error("connect revoke requires a settled connection");
      if (isLinkConnection(state.value)) throw new Error("connect revoke is unavailable in link mode");
      await revokeClientKey(state.value.managementUrl, credential, state.value.apiKeyId, { fetchImpl: deps.fetchImpl });
      assertClientConnectionUnchanged(state.value);
      return { apiKeyId: state.value.apiKeyId };
    }, deps.lifecycleLockDeps);
  } finally { credential.value.fill(0); }
}
