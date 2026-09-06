import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  readFileSync,
  unlinkSync,
} from "node:fs";
import { hostname } from "node:os";
import { atomicWriteFile, loadConfig, withConfigMutationLockSync } from "../config";
import { claudeDesktopIntegrationEnabledNow } from "../codex/desired-state";
import {
  inspectRemoteDesktopStore, readDesktopDisconnectReceipt, writeDesktopDisconnectReceipt,
  replaceRemoteDesktopCredential, restoreRemoteDesktopStore, finishRemoteDesktopCleanup,
  type DesktopDisconnectReceipt, type DesktopRemoteOwner, type DesktopStoreResult,
} from "../claude/desktop-remote-store";
import {
  withClientLifecycle, withClientLifecycleSync,
  type ClientLifecycleHeld, type ClientLifecycleLockDeps,
} from "./lifecycle-lock";
import { invalidateCodexModelsCache } from "../codex/catalog/sync";
import {
  injectCodexConfig,
  currentExternalCodexModelProvider,
  isCodexRoutingInjected,
  type CodexRoutingTarget,
} from "../codex/inject";
import {
  journalOwner,
  restoreJournalState,
} from "../codex/journal";
import { DEFAULT_CATALOG_PATH } from "../codex/paths";
import {
  readServiceApiTokenState,
  readTokenBackupState,
  removeServiceApiTokenFileIfOwned,
  removeOrphanTokenBackup,
  replaceServiceApiTokenFile,
  restoreTokenBackup,
  serviceApiTokenBackupPath,
  writeTokenBackup,
  writeServiceApiTokenFile,
} from "../lib/service-secrets";
import { MAX_REMOTE_CATALOG_BYTES } from "../server/catalog-download";
import type {
  OcxClientConnectionConfig,
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
  assertNoClientDisconnectPending, assertClientConnectionUnchanged, sameClientConnectionOwner,
} from "./state";

class RotationRecoveryRequiredError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "RotationRecoveryRequiredError";
  }
}

export interface ConnectOptions {
  serverUrl: string;
  managementUrl?: string;
  credential: OneTimeConnectCredential;
  selectedClients: OcxConnectedClientId[];
  managementTransport: "direct" | "relay";
  noSync?: boolean;
  catalogTimeoutMs?: number;
}

export interface ClientConnectDeps {
  fetchImpl?: typeof fetch;
  now?: () => Date;
  lifecycleLockDeps?: ClientLifecycleLockDeps;
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

function routingTarget(serverUrl: string): CodexRoutingTarget {
  return {
    baseUrl: `${serverUrl}/v1`,
    requiresAdmissionToken: true,
    tokenEnv: "OPENCODEX_API_AUTH_TOKEN",
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
    const current = readServiceApiTokenState();
    if (current.kind !== "present") throw new Error("connected service token unavailable");
    if (!connection.pendingOperation) {
      if (current.fingerprint !== connection.tokenFingerprint) throw new Error("connected service token ownership changed");
      const desktop = inspectRemoteDesktopStore(desktopOwner(connection));
      if (["conflict", "unsafe", "pending"].includes(desktop.kind)) throw new Error("desktop_lifecycle_recovery_required");
      // Establish legacy fallback ownership and reject edited projections BEFORE hub issuance.
      alignDesktopCredential(held, connection, current.fingerprint, current);
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
    alignDesktopCredential(held, connection, current.fingerprint, { token: rotation.key, fingerprint: replacement.fingerprint });
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
    throw new Error("client_token_changed");
  }
}

export async function connectClient(
  options: ConnectOptions,
  deps: ClientConnectDeps = {},
): Promise<OcxClientConnectionConfig> {
  let serverUrl = "";
  let managementUrl = "";
  let issued: IssuedClientKey | null = null;
  let cleanupCredential: { kind: "admin"; value: Uint8Array } | { kind: "gui-session"; value: ConnectGuiSession } | null = null;
  let tokenFingerprint: string | null = null;
  let priorCatalog: CatalogSnapshot | null = null;
  let writtenCatalogFingerprint: string | null = null;
  let injectionCommitted = false;
  let committed = false;
  try {
    serverUrl = normalizeHubOrigin(options.serverUrl);
    if (options.managementUrl) managementUrl = normalizeHubOrigin(options.managementUrl);
    if (options.selectedClients.length < 1 || new Set(options.selectedClients).size !== options.selectedClients.length) {
      throw new Error("at least one unique connected client is required");
    }
    withClientLifecycleSync(() => withConfigMutationLockSync(() => {
      assertConnectingState();
      const externalProvider = currentExternalCodexModelProvider();
      if (externalProvider) throw new Error("connect refused: an external Codex provider owns config.toml");
    }), deps.lifecycleLockDeps);

    const ready = await fetchHubReady(serverUrl, { fetchImpl: deps.fetchImpl });
    if (ready.status !== "ready") throw new Error(`hub is not ready (${ready.status})`);
    managementUrl = managementUrl || ready.metadata.managementUrl;

    if (options.credential.kind === "pairing-grant") {
      const session = await exchangeConnectPairingGrant(
        managementUrl,
        localGuiOrigin(),
        options.credential.value,
        { fetchImpl: deps.fetchImpl },
      );
      cleanupCredential = { kind: "gui-session", value: session };
    } else {
      cleanupCredential = { kind: "admin", value: options.credential.value };
    }
    issued = await issueClientKey(managementUrl, cleanupCredential, clientKeyName(), { fetchImpl: deps.fetchImpl });

    const initialFiles = withClientLifecycleSync(() => withConfigMutationLockSync(() => {
      assertConnectingState();
      return { prior: catalogSnapshot(), persisted: writeServiceApiTokenFile(issued!.key) };
    }), deps.lifecycleLockDeps);
    priorCatalog = initialFiles.prior;
    const persisted = initialFiles.persisted;
    tokenFingerprint = persisted.fingerprint;

    const catalog = await downloadClientCatalog(serverUrl, issued.key, {
      fetchImpl: deps.fetchImpl,
      timeoutMs: options.catalogTimeoutMs,
    });
    writtenCatalogFingerprint = withClientLifecycleSync(() => withConfigMutationLockSync(() => {
      assertConnectingState(persisted.fingerprint);
      atomicWriteFile(DEFAULT_CATALOG_PATH, catalog.body);
      return sha256(catalog.body);
    }), deps.lifecycleLockDeps);

    const config = loadConfig();
    const target = routingTarget(serverUrl);
    const injectConfig = { ...config, syncResumeHistory: false };
    const preflight = await injectCodexConfig(config.port, injectConfig, {
      validateOnly: true,
      routingTarget: target,
      catalogPath: DEFAULT_CATALOG_PATH,
      journalOwner: { kind: "client", apiKeyId: issued.id },
      beforeClientWrite: () => assertConnectingState(persisted.fingerprint),
    });
    if (!preflight.success) throw new Error(preflight.message);

    if (!options.noSync && options.selectedClients.includes("codex")) {
      const injected = await injectCodexConfig(config.port, injectConfig, {
        routingTarget: target,
        catalogPath: DEFAULT_CATALOG_PATH,
        journalOwner: { kind: "client", apiKeyId: issued.id },
        beforeClientWrite: () => assertConnectingState(persisted.fingerprint),
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
      selectedClients: [...options.selectedClients],
      tokenEnv: "OPENCODEX_API_AUTH_TOKEN",
      apiKeyId: issued.id,
      tokenFingerprint: persisted.fingerprint,
      protocolVersion: 1,
      connectedAt: now,
      catalogFingerprint: createHash("sha256").update(catalog.body).digest("base64url"),
      // Durable so disconnect — a different process — can put back whatever was here
      // before. The in-memory `priorCatalog` only covers a connect that fails and rolls
      // back in the same run.
      priorCatalog: priorCatalog.kind === "file" ? Buffer.from(priorCatalog.body, "utf8").toString("base64") : "",
      catalogSyncedAt: now,
    };
    withClientLifecycleSync(() => withConfigMutationLockSync(() => {
      assertConnectingState(persisted.fingerprint);
      commitClientConnection(connection);
      committed = true;
    }), deps.lifecycleLockDeps);
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
        if (priorCatalog && writtenCatalogFingerprint && !restoreCatalogSnapshot(priorCatalog, writtenCatalogFingerprint)) {
          rollbackFailures.push("catalog rollback did not match the written artifact");
        }
        if (tokenFingerprint) {
          const removed = removeServiceApiTokenFileIfOwned(tokenFingerprint);
          if (removed === "changed") rollbackFailures.push("service token changed during rollback");
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
    releaseCredential(options.credential);
    cleanupCredential = null;
    issued = null;
    if (!committed) {
      tokenFingerprint = null;
      priorCatalog = null;
      writtenCatalogFingerprint = null;
    }
  }
}

export async function syncConnectedClient(
  _options: { restartCodex?: boolean } = {},
  deps: ClientConnectDeps = {},
): Promise<{ catalogWritten: boolean; cacheSynced: boolean; injected: boolean; stale: boolean }> {
  const initial = withClientLifecycleSync(() => withConfigMutationLockSync(() => {
    assertNoClientDisconnectPending();
    const state = readClientConnectionState();
    if (state.kind !== "connected" || state.value.pendingOperation) throw new Error("client_sync_unavailable");
    const token = readServiceApiTokenState();
    if (token.kind !== "present" || token.fingerprint !== state.value.tokenFingerprint) throw new Error("client_token_changed");
    return { connection: state.value, token };
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
  const next = withClientLifecycleSync(() => withConfigMutationLockSync(() => {
    assertClientConnectionUnchanged(initial.connection);
    const token = readServiceApiTokenState();
    if (token.kind !== "present" || token.fingerprint !== initial.token.fingerprint) throw new Error("client_token_changed");
    if (!downloaded) { validLocalCatalog(); return initial.connection; }
    atomicWriteFile(DEFAULT_CATALOG_PATH, downloaded.body);
    const updated = {
      ...initial.connection,
      catalogFingerprint: createHash("sha256").update(downloaded.body).digest("base64url"),
      catalogSyncedAt: (deps.now ?? (() => new Date()))().toISOString(),
    };
    commitClientConnection(updated);
    return updated;
  }), deps.lifecycleLockDeps);
  // Read-only: injection invokes this while N/C are held. Acquiring L here would invert C→L.
  const beforeClientWrite = () => {
    assertClientConnectionUnchanged(next);
    const token = readServiceApiTokenState();
    if (next.pendingOperation || token.kind !== "present" || token.fingerprint !== next.tokenFingerprint) throw new Error("client_token_changed");
  };
  let injected = false;
  if (next.selectedClients.includes("codex")) {
    const config = loadConfig();
    const result = await injectCodexConfig(config.port, { ...config, syncResumeHistory: false }, {
      routingTarget: routingTarget(next.serverUrl), catalogPath: DEFAULT_CATALOG_PATH,
      journalOwner: { kind: "client", apiKeyId: next.apiKeyId }, beforeClientWrite,
    });
    if (!result.success || result.status === "skipped") throw new Error(result.message);
    injected = true;
  }
  const cacheSynced = withClientLifecycleSync(() => {
    beforeClientWrite();
    // Cache invalidation acquires K itself (N -> K -> C); never call it while C is held.
    return invalidateCodexModelsCache({ allowWhenDesiredDisabled: true });
  }, deps.lifecycleLockDeps);
  return { catalogWritten: downloaded !== undefined, cacheSynced, injected, stale };
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

function restoreConnectedCodex(connection: OcxClientConnectionConfig): void {
  if (!connection.selectedClients.includes("codex")) return;
  const owner = journalOwner();
  if (owner && owner.kind === "client" && owner.apiKeyId !== connection.apiKeyId) {
    throw new Error("disconnect refused: Codex journal ownership conflicts with the connected key");
  }
  if (owner !== null) {
    if (!restoreJournalState().complete) throw new Error("disconnect refused: Codex journal restore was partial");
  } else if (isCodexRoutingInjected()) {
    throw new Error("disconnect refused: Codex routing is injected but no journal records the original state");
  }
}

export async function disconnectClient(
  options: { keepCatalog?: boolean; expectedOwner?: DesktopRemoteOwner } = {},
  deps: Pick<ClientConnectDeps, "lifecycleLockDeps"> = {},
): Promise<{
  restored: boolean; tokenRemoved: boolean; catalogRemoved: boolean; catalogRestored: boolean; apiKeyId: string;
  desktopRestoration?: "owned_projection" | "standard_fallback" | "selection_preserved";
  restartRequired: boolean;
}> {
  const keepCatalog = options.keepCatalog === true;
  const prepared = withClientLifecycleSync(held => withConfigMutationLockSync(() => {
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
        if (desktop.kind === "unsafe" || desktop.kind === "conflict") throw new Error("desktop_lifecycle_unsafe");
        preflightDisconnectCatalog(connection, keepCatalog);
        receipt = { version: 1, owner: desktopOwner(connection), tokenFingerprint: connection.tokenFingerprint, keepCatalog, phase: "prepared" };
        writeDesktopDisconnectReceipt(held, previous, receipt);
      }
    } else if (state.kind !== "disconnected" || !receipt || !disconnectAtLeast(receipt, "clearing_connection")) {
      throw new Error("disconnect refused: no recoverable connected state");
    }
    if (!receipt || receipt.keepCatalog !== keepCatalog) throw new Error("client_disconnect_options_changed");
    return { receipt, connection };
  }), deps.lifecycleLockDeps);

  // The prepared receipt blocks even a sync queued for its actual N/C injection commit.
  // Codex-only restore MUST stay outside L; it never invokes Desktop cleanup.
  if (prepared.connection && !disconnectAtLeast(prepared.receipt, "desktop_restored")) {
    restoreConnectedCodex(prepared.connection);
  }

  return withClientLifecycleSync(held => withConfigMutationLockSync(() => {
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
    if (!disconnectAtLeast(receipt, "removing_token")) advance("removing_token");
    const tokenRemoval = removeServiceApiTokenFileIfOwned(receipt.tokenFingerprint);
    if (tokenRemoval === "changed") throw new Error("client_token_changed");
    if (!disconnectAtLeast(receipt, "token_removed")) advance("token_removed");
    if (!disconnectAtLeast(receipt, "clearing_connection")) advance("clearing_connection");
    if (clearClientConnection(receipt.owner) === "conflict") throw new Error("client_disconnect_owner_changed");
    if (!disconnectAtLeast(receipt, "connection_cleared")) advance("connection_cleared");
    requireDesktopResult(finishRemoteDesktopCleanup(held, receipt.owner));
    if (receipt.phase !== "complete") advance("complete");
    return {
      restored: true, tokenRemoved: tokenRemoval === "removed",
      catalogRemoved: !keepCatalog, catalogRestored: !keepCatalog && receipt.catalogAfter?.kind === "file",
      apiKeyId: receipt.owner.apiKeyId, restartRequired: desktop.restartRequired,
      ...(desktop.restoration ? { desktopRestoration: desktop.restoration } : {}),
    };
  }), deps.lifecycleLockDeps);
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
      await revokeClientKey(state.value.managementUrl, credential, state.value.apiKeyId, { fetchImpl: deps.fetchImpl });
      assertClientConnectionUnchanged(state.value);
      return { apiKeyId: state.value.apiKeyId };
    }, deps.lifecycleLockDeps);
  } finally { credential.value.fill(0); }
}
