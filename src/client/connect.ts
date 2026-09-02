import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  readFileSync,
  unlinkSync,
} from "node:fs";
import { hostname } from "node:os";
import { atomicWriteFile, loadConfig } from "../config";
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

function clearRotationState(
  connection: OcxClientConnectionConfig,
  tokenFingerprint: string,
): OcxClientConnectionConfig {
  const next = { ...connection, tokenFingerprint };
  delete next.pendingOperation;
  commitClientConnection(next);
  return next;
}

async function recoverRotationWithAuthority(
  connection: OcxClientConnectionConfig,
  authority: { kind: "admin"; value: Uint8Array } | { kind: "gui-session"; value: ConnectGuiSession },
  deps: ClientConnectDeps,
): Promise<OcxClientConnectionConfig> {
  const pending = connection.pendingOperation;
  if (!pending || pending.oldKeyBackupPath !== serviceApiTokenBackupPath()) {
    throw new RotationRecoveryRequiredError("rotation recovery state is missing or invalid");
  }
  const current = readServiceApiTokenState();
  const backup = readTokenBackupState();
  if (current.kind !== "present" || backup.kind !== "present") {
    throw new RotationRecoveryRequiredError(
      "rotation recovery requires owner-only current and .prev token files; preserve both and rerun ocx connect rotate with transient authority",
    );
  }
  let currentAccepted: boolean;
  let backupAccepted: boolean;
  try {
    [currentAccepted, backupAccepted] = await Promise.all([
      probeClientKeyId(connection.serverUrl, current.token, connection.apiKeyId, { fetchImpl: deps.fetchImpl }),
      probeClientKeyId(connection.serverUrl, backup.token, connection.apiKeyId, { fetchImpl: deps.fetchImpl }),
    ]);
  } catch (error) {
    throw new RotationRecoveryRequiredError(
      "rotation recovery could not establish both key admissions; preserve service-api-token and .prev",
      { cause: error },
    );
  }
  if (currentAccepted && backupAccepted) {
    await commitClientKeyRotation(connection.managementUrl, authority, connection.apiKeyId, pending.rotationId, { fetchImpl: deps.fetchImpl });
    const next = clearRotationState(connection, current.fingerprint);
    removeOrphanTokenBackup();
    return next;
  }
  if (currentAccepted && !backupAccepted) {
    const next = clearRotationState(connection, current.fingerprint);
    removeOrphanTokenBackup();
    return next;
  }
  if (!currentAccepted && backupAccepted) {
    const restored = restoreTokenBackup(pending.oldKeyBackupPath);
    await abortClientKeyRotation(connection.managementUrl, authority, connection.apiKeyId, pending.rotationId, { fetchImpl: deps.fetchImpl });
    const next = clearRotationState(connection, restored.fingerprint);
    removeOrphanTokenBackup();
    return next;
  }
  throw new RotationRecoveryRequiredError(
    "both rotation candidates were rejected; preserve service-api-token and .prev and repair admission from the hub",
  );
}

export async function recoverPendingClientRotation(
  options: RotateClientOptions,
  deps: ClientConnectDeps = {},
): Promise<OcxClientConnectionConfig> {
  try {
    const state = readClientConnectionState();
    if (state.kind !== "connected" || !state.value.pendingOperation) {
      throw new Error("no pending client key rotation to recover");
    }
    const authority = await rotationAuthority(state.value, options, deps);
    return await recoverRotationWithAuthority(state.value, authority, deps);
  } finally {
    releaseCredential(options.credential);
  }
}

export async function rotateConnectedClientKey(
  options: RotateClientOptions,
  deps: ClientConnectDeps = {},
): Promise<OcxClientConnectionConfig> {
  let connection: OcxClientConnectionConfig | null = null;
  let authority: { kind: "admin"; value: Uint8Array } | { kind: "gui-session"; value: ConnectGuiSession } | null = null;
  let started: { rotationId: string; key: string; createdAt: string } | null = null;
  let markerPersisted = false;
  try {
    const state = readClientConnectionState();
    if (state.kind !== "connected") throw new Error(`connect rotate is available only while connected (${state.kind})`);
    connection = state.value;
    authority = await rotationAuthority(connection, options, deps);
    if (connection.pendingOperation) return await recoverRotationWithAuthority(connection, authority, deps);
    const current = readServiceApiTokenState();
    if (current.kind !== "present" || current.fingerprint !== connection.tokenFingerprint) {
      throw new Error(current.kind === "unsafe" ? current.reason : "connected service token ownership changed");
    }
    writeTokenBackup(current.fingerprint);
    const rotation = await startClientKeyRotation(connection.managementUrl, authority, connection.apiKeyId, { fetchImpl: deps.fetchImpl });
    started = { rotationId: rotation.rotationId, key: rotation.key, createdAt: rotation.createdAt };
    const marked: OcxClientConnectionConfig = {
      ...connection,
      pendingOperation: {
        kind: "rotate",
        rotationId: rotation.rotationId,
        newKeyIssuedAt: rotation.createdAt,
        oldKeyBackupPath: serviceApiTokenBackupPath(),
      },
    };
    commitClientConnection(marked);
    connection = marked;
    markerPersisted = true;
    const replacement = replaceServiceApiTokenFile(rotation.key);
    if (!await probeClientKeyId(connection.serverUrl, rotation.key, connection.apiKeyId, { fetchImpl: deps.fetchImpl })) {
      throw new Error("new client key admission probe was refused");
    }
    try {
      await commitClientKeyRotation(connection.managementUrl, authority, connection.apiKeyId, rotation.rotationId, { fetchImpl: deps.fetchImpl });
    } catch {
      return await recoverRotationWithAuthority(connection, authority, deps);
    }
    const next = clearRotationState(connection, replacement.fingerprint);
    removeOrphanTokenBackup();
    return next;
  } catch (error) {
    if (error instanceof RotationRecoveryRequiredError) throw error;
    if (connection && authority && started) {
      if (markerPersisted && connection.pendingOperation) {
        try {
          // Abort FIRST, restore second.
          //
          // The old order restored the local token and then asked the hub to abort. If that
          // abort failed transiently the process was left holding the old key locally while
          // the hub still had a pending rotation for the new one — two sides disagreeing
          // about which generation is current, with the failure surfaced only as "rollback
          // was incomplete". Confirming the hub's state first means the local file is only
          // rewound once the authority that decides it has agreed.
          await abortClientKeyRotation(connection.managementUrl, authority, connection.apiKeyId, started.rotationId, { fetchImpl: deps.fetchImpl });
          const restored = restoreTokenBackup(connection.pendingOperation.oldKeyBackupPath);
          clearRotationState(connection, restored.fingerprint);
          removeOrphanTokenBackup();
        } catch (recoveryError) {
          // Both candidates and the pending marker stay on disk. Recovery cannot tell which
          // generation is authoritative without the hub, so it preserves the evidence and
          // names the command that carries the authority to ask.
          throw new RotationRecoveryRequiredError(
            "rotation rollback was incomplete; preserve service-api-token and .prev and rerun ocx connect rotate with transient authority",
            { cause: recoveryError },
          );
        }
      } else {
        try { await abortClientKeyRotation(connection.managementUrl, authority, connection.apiKeyId, started.rotationId, { fetchImpl: deps.fetchImpl }); }
        finally { removeOrphanTokenBackup(); }
      }
    } else {
      const backup = readTokenBackupState();
      if (backup.kind === "present") removeOrphanTokenBackup();
    }
    throw error;
  } finally {
    if (started) started.key = "";
    authority = null;
    releaseCredential(options.credential);
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
    const state = readClientConnectionState();
    if (state.kind !== "disconnected") {
      const detail = state.kind === "connected" ? "already connected" : state.reason;
      throw new Error(`connect refused: client state is ${state.kind} (${detail})`);
    }
    const externalProvider = currentExternalCodexModelProvider();
    if (externalProvider) throw new Error(`connect refused: external Codex provider ${externalProvider} owns config.toml`);
    const tokenState = readServiceApiTokenState();
    if (tokenState.kind !== "absent") {
      throw new Error(tokenState.kind === "unsafe" ? tokenState.reason : "connect refused: service token file already exists");
    }

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

    priorCatalog = catalogSnapshot();
    const persisted = writeServiceApiTokenFile(issued.key);
    tokenFingerprint = persisted.fingerprint;

    const catalog = await downloadClientCatalog(serverUrl, issued.key, {
      fetchImpl: deps.fetchImpl,
      timeoutMs: options.catalogTimeoutMs,
    });
    atomicWriteFile(DEFAULT_CATALOG_PATH, catalog.body);
    writtenCatalogFingerprint = sha256(catalog.body);

    const config = loadConfig();
    const target = routingTarget(serverUrl);
    const injectConfig = { ...config, syncResumeHistory: false };
    const preflight = await injectCodexConfig(config.port, injectConfig, {
      validateOnly: true,
      routingTarget: target,
      catalogPath: DEFAULT_CATALOG_PATH,
      journalOwner: { kind: "client", apiKeyId: issued.id },
    });
    if (!preflight.success) throw new Error(preflight.message);

    if (!options.noSync && options.selectedClients.includes("codex")) {
      const injected = await injectCodexConfig(config.port, injectConfig, {
        routingTarget: target,
        catalogPath: DEFAULT_CATALOG_PATH,
        journalOwner: { kind: "client", apiKeyId: issued.id },
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
    commitClientConnection(connection);
    committed = true;
    return connection;
  } catch (error) {
    const rollbackFailures: string[] = [];
    if (injectionCommitted) {
      const restored = restoreJournalState();
      if (!restored.complete) rollbackFailures.push("Codex journal restore was partial");
    }
    if (priorCatalog && writtenCatalogFingerprint && !restoreCatalogSnapshot(priorCatalog, writtenCatalogFingerprint)) {
      rollbackFailures.push("catalog rollback did not match the written artifact");
    }
    if (tokenFingerprint) {
      const removed = removeServiceApiTokenFileIfOwned(tokenFingerprint);
      if (removed === "changed") rollbackFailures.push("service token changed during rollback");
    }
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
  const state = readClientConnectionState();
  if (state.kind !== "connected") throw new Error(`connected sync refused: client state is ${state.kind}`);
  const token = readServiceApiTokenState();
  if (token.kind !== "present" || token.fingerprint !== state.value.tokenFingerprint) {
    throw new Error(token.kind === "absent" ? "connected service token is missing" : "connected service token ownership changed");
  }

  let catalogWritten = false;
  let stale = false;
  let next = state.value;
  try {
    const downloaded = await downloadClientCatalog(state.value.serverUrl, token.token, {
      fetchImpl: deps.fetchImpl,
    });
    atomicWriteFile(DEFAULT_CATALOG_PATH, downloaded.body);
    catalogWritten = true;
    const now = (deps.now ?? (() => new Date()))().toISOString();
    next = {
      ...state.value,
      catalogFingerprint: createHash("sha256").update(downloaded.body).digest("base64url"),
      catalogSyncedAt: now,
    };
    commitClientConnection(next);
  } catch (error) {
    const transient = error instanceof HubClientError
      && (error.code === "unreachable" || (error.status !== undefined && error.status >= 500));
    if (!transient) throw error;
    validLocalCatalog();
    stale = true;
  }

  let injected = false;
  if (next.selectedClients.includes("codex")) {
    const config = loadConfig();
    const result = await injectCodexConfig(config.port, { ...config, syncResumeHistory: false }, {
      routingTarget: routingTarget(next.serverUrl),
      catalogPath: DEFAULT_CATALOG_PATH,
      journalOwner: { kind: "client", apiKeyId: next.apiKeyId },
    });
    if (!result.success || result.status === "skipped") throw new Error(result.message);
    injected = true;
  }
  const cacheSynced = invalidateCodexModelsCache({ allowWhenDesiredDisabled: true });
  return { catalogWritten, cacheSynced, injected, stale };
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

export async function disconnectClient(
  options: { keepCatalog?: boolean } = {},
): Promise<{
  restored: boolean;
  tokenRemoved: boolean;
  /** True when the catalog no longer holds remote bytes: removed outright or overwritten. */
  catalogRemoved: boolean;
  /** True only when a recorded pre-connect catalog was written back. */
  catalogRestored: boolean;
  apiKeyId: string;
}> {
  const state = readClientConnectionState();
  if (state.kind !== "connected") throw new Error(`disconnect refused: client state is ${state.kind}`);
  const token = readServiceApiTokenState();
  if (token.kind !== "present" || token.fingerprint !== state.value.tokenFingerprint) {
    throw new Error(token.kind === "absent" ? "disconnect refused: service token is missing" : "disconnect refused: service token ownership changed");
  }

  let restored = true;
  if (state.value.selectedClients.includes("codex")) {
    const owner = journalOwner();
    // A journal owned by this client key is ours, obviously. A journal owned by a PROCESS is
    // also ours to unwind: it is what `ocx start` leaves behind, and connecting on top of it
    // never transfers ownership — writeJournal() declines to overwrite a journal whose
    // config is already injected, so the process owner survives into the connected state.
    //
    // Treating that as a conflict stranded the normal "start, then connect" path: disconnect
    // refused, and nothing the operator could do would satisfy the check. The genuine
    // conflict is a journal owned by a DIFFERENT client key, which is the one case where
    // restoring would unwind somebody else's routing.
    if (
      owner === null
      || owner.kind === "process"
      || owner.apiKeyId === state.value.apiKeyId
    ) {
      if (owner !== null) restored = restoreJournalState().complete;
      else if (isCodexRoutingInjected()) {
        // Injected routing with no journal at all: there is no recorded baseline to restore,
        // so unwinding would be a guess about what the config looked like before.
        throw new Error("disconnect refused: Codex routing is injected but no journal records the original state");
      }
    } else {
      throw new Error("disconnect refused: Codex journal ownership conflicts with the connected key");
    }
    if (!restored) throw new Error("disconnect refused: Codex journal restore was partial");
  }

  const tokenRemoval = removeServiceApiTokenFileIfOwned(state.value.tokenFingerprint);
  if (tokenRemoval === "changed") throw new Error("disconnect refused: service token changed before removal");
  let catalogRemoval: "removed" | "restored" | "absent" | "changed" = "absent";
  if (!options.keepCatalog) {
    catalogRemoval = restorePriorCatalog(state.value);
    if (catalogRemoval === "changed") throw new Error("disconnect refused: catalog ownership changed");
  }
  if (clearClientConnection(state.value.apiKeyId) !== "committed") {
    throw new Error("disconnect refused: client state changed before final commit");
  }
  return {
    restored,
    tokenRemoved: tokenRemoval === "removed",
    catalogRemoved: catalogRemoval === "removed" || catalogRemoval === "restored",
    catalogRestored: catalogRemoval === "restored",
    apiKeyId: state.value.apiKeyId,
  };
}

export async function revokeConnectedClientKey(
  credential: { kind: "admin"; value: Uint8Array },
  deps: ClientConnectDeps = {},
): Promise<{ apiKeyId: string }> {
  try {
    const state = readClientConnectionState();
    if (state.kind !== "connected") throw new Error("connect revoke is available only while connected");
    await revokeClientKey(state.value.managementUrl, credential, state.value.apiKeyId, { fetchImpl: deps.fetchImpl });
    return { apiKeyId: state.value.apiKeyId };
  } finally {
    credential.value.fill(0);
  }
}
