import { readFileSync } from "node:fs";
import {
  getConfigPath,
  deleteConfigTopLevelKey,
  getDefaultConfig,
  mutatePersistedConfig,
  readConfigDiagnostics,
  saveConfig,
} from "../config";
import type { OcxClientConnectionConfig } from "../types";
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

/**
 * Does the persisted config record a rotation that has not finished?
 *
 * Read fresh rather than taken from a caller-supplied snapshot: the whole point is to see a
 * `pendingOperation` that landed after that snapshot was taken.
 */
function rotationInFlight(): boolean {
  const current = readClientConnectionState();
  return current.kind === "connected" && current.value.pendingOperation !== undefined;
}

export function inspectClientRotationRecoveryGate(
  state: ClientConnectionState = readClientConnectionState(),
): ClientRotationRecoveryGate {
  const current = readServiceApiTokenState();
  const backup = readTokenBackupState();
  if (state.kind === "connected" && state.value.pendingOperation) {
    if (current.kind !== "present" || backup.kind !== "present") {
      return {
        kind: "unsafe",
        reason: "pending key rotation requires owner-only service-api-token and service-api-token.prev files",
      };
    }
    return {
      kind: "recovery-required",
      reason: "rerun ocx connect rotate with --pairing-code-stdin or --admin-token-stdin",
    };
  }
  if (backup.kind === "unsafe") return { kind: "unsafe", reason: backup.reason };
  if (backup.kind === "present" && current.kind === "present") {
    // Only an ORPHAN backup is cleanable, and this branch cannot always tell an orphan from
    // a backup belonging to a rotation that is mid-flight.
    //
    // `rotateConnectedClientKey` writes the .prev backup BEFORE it persists
    // `pendingOperation`. A concurrent `ocx connect status` landing in that window sees
    // "backup present, token present, no pending marker" — indistinguishable from a stale
    // leftover — and deleted the live rollback target. If the rotation then failed, its
    // restore had nothing to restore from.
    //
    // Re-reading the persisted state closes most of the window: the caller's `state` may
    // have been captured before the marker landed, while a fresh read sees it. The
    // remaining window is narrow enough that the rotation's own lock is the right owner,
    // and deleting nothing is the safe side of it.
    if (rotationInFlight()) {
      return { kind: "recovery-required", reason: "a key rotation is in flight; leave service-api-token.prev in place" };
    }
    try {
      removeOrphanTokenBackup();
      return { kind: "orphan-cleaned" };
    } catch (error) {
      return { kind: "unsafe", reason: error instanceof Error ? error.message : "token backup cleanup failed" };
    }
  }
  return { kind: "clean" };
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
  }, { surface: "cli", detail: "ocx connect: commit client connection" });
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
    saveConfig(seeded, { surface: "cli", detail: "ocx connect: commit client connection" });
    return "committed";
  }
  throw new Error(`client state commit unavailable: ${"reason" in outcome ? outcome.reason : "unknown"}`);
}

export function clearClientConnection(
  expectedApiKeyId: string,
): "committed" | "absent" | "conflict" {
  const outcome = mutatePersistedConfig(config => {
    if (!config.client && config.runtimeRole !== "client") {
      return { changed: false, value: "absent" as const };
    }
    if (!config.client || config.runtimeRole !== "client" || config.client.apiKeyId !== expectedApiKeyId) {
      return { changed: false, value: "conflict" as const };
    }
    deleteConfigTopLevelKey(config, "client");
    deleteConfigTopLevelKey(config, "runtimeRole");
    return { changed: true, value: "committed" as const };
  }, { surface: "cli", detail: "ocx disconnect: clear client connection" });
  if (outcome.status === "unavailable") return "conflict";
  return outcome.value;
}
