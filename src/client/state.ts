import { readFileSync } from "node:fs";
import {
  getConfigPath,
  deleteConfigTopLevelKey,
  getDefaultConfig,
  mutatePersistedConfig,
  readConfigDiagnostics,
  saveConfig,
  withConfigMutationLockSync,
} from "../config";
import type { OcxClientConnectionConfig } from "../types";
import { inspectRemoteDesktopStore, readDesktopDisconnectReceipt } from "../claude/desktop-remote-store";
import { withClientLifecycleSync, type ClientLifecycleLockDeps } from "./lifecycle-lock";
import {
  readServiceApiTokenState,
  readTokenBackupState,
  removeOrphanTokenBackup,
} from "../lib/service-secrets";

export type ClientConnectionState =
  | { kind: "disconnected" }
  | { kind: "connected"; value: OcxClientConnectionConfig }
  | { kind: "invalid"; reason: string }
  | { kind: "mismatched"; reason: string };

export type ClientRotationRecoveryGate =
  | { kind: "clean" }
  | { kind: "orphan-cleaned" }
  | { kind: "recovery-required"; reason: string }
  | { kind: "unsafe"; reason: string };

function rawTopLevelConfig(): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(readFileSync(getConfigPath(), "utf8").replace(/^\uFEFF/, "")) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

export function readClientConnectionState(): ClientConnectionState {
  const raw = rawTopLevelConfig();
  const diagnostics = readConfigDiagnostics();
  if (!raw) {
    return diagnostics.source === "default"
      ? { kind: "disconnected" }
      : { kind: "invalid", reason: "config.json is missing or unreadable" };
  }
  const hasClient = Object.hasOwn(raw, "client") && raw.client !== undefined;
  const role = raw.runtimeRole;
  if (role !== undefined && role !== "standalone" && role !== "hub" && role !== "client") {
    return { kind: "invalid", reason: "config.json.runtimeRole is invalid" };
  }
  if (!hasClient && (role === undefined || role === "standalone")) return { kind: "disconnected" };
  // A hub is a server role, not a broken client: without client state it simply is not
  // connected, and refusing here blocked `ocx start` on every hub (found on the first
  // clisu-oracle dogfood boot). Hub role WITH client state remains mismatched below.
  if (!hasClient && role === "hub") return { kind: "disconnected" };
  if (!hasClient || role !== "client") {
    return {
      kind: "mismatched",
      reason: hasClient
        ? "config.json.client is present without runtimeRole=client"
        : "runtimeRole=client is present without config.json.client",
    };
  }
  const client = diagnostics.config.client;
  if (!client) {
    const warning = diagnostics.warnings?.find(value => value.startsWith("client"));
    return { kind: "invalid", reason: warning ?? "config.json.client is malformed" };
  }
  return { kind: "connected", value: client };
}

export function sameClientConnectionOwner(
  left: Pick<OcxClientConnectionConfig, "serverUrl" | "apiKeyId" | "connectedAt">,
  right: Pick<OcxClientConnectionConfig, "serverUrl" | "apiKeyId" | "connectedAt">,
): boolean {
  return left.serverUrl === right.serverUrl && left.apiKeyId === right.apiKeyId && left.connectedAt === right.connectedAt;
}

/** Read-only: safe at a Codex N/C commit boundary; never acquires L or removes recovery state. */
export function assertNoClientDisconnectPending(): void {
  const receipt = readDesktopDisconnectReceipt();
  if (receipt.kind === "unsafe") throw new Error("client_disconnect_receipt_unsafe");
  if (receipt.kind === "valid" && receipt.value.phase !== "complete") {
    throw new Error("client_disconnect_pending");
  }
}

/** Full snapshot CAS for work returning from an await, including selection and rotation state. */
export function assertClientConnectionUnchanged(expected: OcxClientConnectionConfig): void {
  assertNoClientDisconnectPending();
  const current = readClientConnectionState();
  if (current.kind !== "connected" || JSON.stringify(current.value) !== JSON.stringify(expected)) {
    throw new Error("client_connection_changed");
  }
}

/** Undefined means only "possible orphan": the caller must repeat this read under L/C. */
function observeClientRotationRecovery(): ClientRotationRecoveryGate | undefined {
  const state = readClientConnectionState();
  const current = readServiceApiTokenState();
  const backup = readTokenBackupState();
  const receipt = readDesktopDisconnectReceipt();
  if (receipt.kind === "unsafe") return { kind: "unsafe", reason: "client_disconnect_receipt_unsafe" };
  if (receipt.kind === "valid" && receipt.value.phase !== "complete") {
    return { kind: "recovery-required", reason: "client_disconnect_pending" };
  }
  if (state.kind === "connected" && state.value.pendingOperation) {
    if (current.kind !== "present" || backup.kind !== "present") {
      return { kind: "unsafe", reason: "pending rotation requires current and backup token files" };
    }
    return { kind: "recovery-required", reason: "rerun ocx connect rotate with transient authority" };
  }
  if (backup.kind === "unsafe") return { kind: "unsafe", reason: "service token backup is unsafe" };
  if (backup.kind === "present" && current.kind === "present") {
    if (state.kind === "invalid" || state.kind === "mismatched"
      || (state.kind === "connected" && current.fingerprint !== state.value.tokenFingerprint)) {
      return { kind: "unsafe", reason: "connected token ownership changed" };
    }
    if (state.kind === "connected") {
      const desktop = inspectRemoteDesktopStore({ serverUrl: state.value.serverUrl, apiKeyId: state.value.apiKeyId, connectedAt: state.value.connectedAt });
      if (desktop.kind !== "absent" && desktop.kind !== "restored") {
        // The inspection DTO deliberately exposes no credential generation. Let
        // explicit rotation reconcile an active Desktop copy before discarding .prev.
        return { kind: "recovery-required", reason: "Desktop credential reconciliation requires ocx connect rotate" };
      }
    }
    return undefined;
  }
  return { kind: "clean" };
}

export function inspectClientRotationRecoveryGate(
  _state: ClientConnectionState = readClientConnectionState(),
  lockDeps?: ClientLifecycleLockDeps,
): ClientRotationRecoveryGate {
  try {
    // Ordinary status is read-only: even acquiring C creates config-mutation.sqlite.
    // Only actual orphan cleanup needs L/C; this first observation authorizes no write.
    const observed = observeClientRotationRecovery();
    if (observed) return observed;
    return withClientLifecycleSync(() => withConfigMutationLockSync((): ClientRotationRecoveryGate => {
      const fresh = observeClientRotationRecovery();
      if (fresh) return fresh;
      removeOrphanTokenBackup();
      return { kind: "orphan-cleaned" };
    }), lockDeps);
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
    if (code === "client_lifecycle_busy") return { kind: "recovery-required", reason: "client_lifecycle_busy" };
    return { kind: "unsafe", reason: "client rotation state could not be inspected safely" };
  }
}

export function commitClientConnection(

  state: OcxClientConnectionConfig,
): "committed" | "unchanged" {
  const outcome = mutatePersistedConfig(config => {
    const unchanged = config.runtimeRole === "client"
      && JSON.stringify(config.client) === JSON.stringify(state);
    if (!unchanged) {
      config.runtimeRole = "client";
      config.client = structuredClone(state);
    }
    return { changed: !unchanged, value: undefined };
  });
  if (outcome.status === "committed" || outcome.status === "unchanged") return outcome.status;
  if (outcome.status === "unavailable" && outcome.reason === "missing") {
    // First ocx run on a fresh machine: ocx connect is the expected first command in
    // client mode, so there is no config.json yet. mutatePersistedConfig correctly
    // refuses to invent one (a lost config must fail closed), but a genuinely absent
    // file is the bootstrap case, not corruption — seed defaults plus the client
    // block atomically. Found on the first MacBook↔oracle dogfood connect.
    const seeded = getDefaultConfig();
    seeded.runtimeRole = "client";
    seeded.client = structuredClone(state);
    saveConfig(seeded);
    return "committed";
  }
  throw new Error(`client state commit unavailable: ${"reason" in outcome ? outcome.reason : "unknown"}`);
}

export function clearClientConnection(
  expected: string | Pick<OcxClientConnectionConfig, "serverUrl" | "apiKeyId" | "connectedAt">,
): "committed" | "absent" | "conflict" {
  const outcome = mutatePersistedConfig(config => {
    if (!config.client && config.runtimeRole !== "client") {
      return { changed: false, value: "absent" as const };
    }
    if (!config.client || config.runtimeRole !== "client" || (typeof expected === "string" ? config.client.apiKeyId !== expected : !sameClientConnectionOwner(config.client, expected))) {
      return { changed: false, value: "conflict" as const };
    }
    deleteConfigTopLevelKey(config, "client");
    deleteConfigTopLevelKey(config, "runtimeRole");
    return { changed: true, value: "committed" as const };
  });
  if (outcome.status === "unavailable") return "conflict";
  return outcome.value;
}
