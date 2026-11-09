import { existsSync } from "node:fs";
import { join } from "node:path";
import { readConfigDiagnostics, withConfigMutationLockSync } from "../config";
import { assertClientLifecycleHeld, type ClientLifecycleHeld } from "../client/lifecycle-lock";
import { readServiceApiTokenState, serviceApiTokenFingerprint } from "../lib/service-secrets";
import { assertDesktop3pModelsValid } from "./desktop-3p-guard";
import { profilePath } from "./desktop-3p-library";
import type { Desktop3pConfigMode, Desktop3pModelEntry } from "./desktop-3p";
import { StoreIO, metadata, storePaths } from "./desktop-remote-store-io";
import {
  DesktopStoreError, DISCONNECT_PHASES, canonical, origin, parseDisconnect, parseOwner,
  projection, projectionHash, sameOwner, type DesktopDisconnectReceipt, type DesktopRemoteOwner, type DesktopStoreResult,
} from "./desktop-remote-store-state";
import {
  artifact, cleanBackup, currentConnection, establish, loadBundle, locateLegacy, profileCredential,
  requireOwner, saveState, selectedFile, serviceGenerations, type Bundle,
} from "./desktop-remote-store-artifact";
export type { DesktopDisconnectReceipt, DesktopRemoteOwner, DesktopStoreResult } from "./desktop-remote-store-state";

function mutation(held: ClientLifecycleHeld, operation: (io: StoreIO) => DesktopStoreResult): DesktopStoreResult {
  assertClientLifecycleHeld(held);
  const io = new StoreIO();
  try { return withConfigMutationLockSync(() => operation(io)); }
  catch (error) { return { ok: false, changed: io.changed, reason: error instanceof DesktopStoreError ? error.reason : io.changed ? "recovery_required" : "unsafe" }; }
}
function absent(io?: StoreIO): DesktopStoreResult { return { ok: true, changed: io?.changed ?? false, status: "absent", restartRequired: false }; }
function success(io: StoreIO, bundle: Bundle, status: "applied" | "updated" | "restored", extra: Partial<Extract<DesktopStoreResult, { ok: true }>> = {}): DesktopStoreResult {
  return { ok: true, changed: io.changed, status, baselineKind: bundle.state!.baselineKind,
    restartRequired: io.changed, path: profilePath(bundle.paths.library, bundle.state!.targetId),
    fingerprint: bundle.state!.lastProjectionHash, ...extra };
}
function receipt(io: StoreIO): DesktopDisconnectReceipt | null {
  const file = io.read(storePaths().disconnect, 64 * 1024, true);
  return file ? parseDisconnect(file.value) : null;
}
function noDisconnect(io: StoreIO): void {
  const value = receipt(io);
  if (value && value.phase !== "complete") throw new DesktopStoreError("conflict");
}
function knownGeneration(expected: string, candidates: readonly string[]): void {
  if (!candidates.includes(expected)) throw new DesktopStoreError("conflict");
}
function recordedGenerations(io: StoreIO, owner: DesktopRemoteOwner): string[] {
  const bundle = loadBundle(io);
  const terminal = receipt(io);
  if (bundle.state?.phase === "cleaned" && terminal?.phase === "complete"
    && sameOwner(bundle.state.owner, terminal.owner) && !sameOwner(owner, terminal.owner)) return serviceGenerations();
  requireOwner(bundle, owner);
  return [...serviceGenerations(), ...(bundle.state ? [bundle.state.tokenFingerprint] : []),
    ...(bundle.state?.pending ? [bundle.state.pending.tokenFingerprint] : [])];
}

export function inspectRemoteDesktopStore(owner: DesktopRemoteOwner): {
  kind: "absent" | "active" | "pending" | "restored" | "legacy_current_connection" | "conflict" | "unsafe";
} {
  try {
    parseOwner(owner);
    const io = new StoreIO(), bundle = loadBundle(io);
    if (bundle.state?.phase === "cleaned") {
      const terminal = receipt(io);
      if (terminal?.phase === "complete" && sameOwner(bundle.state.owner, terminal.owner) && !sameOwner(owner, terminal.owner)) return { kind: "absent" };
    }
    requireOwner(bundle, owner);
    if (bundle.state) {
      if (bundle.state.phase === "prepared" || bundle.state.pending) return { kind: "pending" };
      if (bundle.state.phase === "cleaned") return { kind: "restored" };
      const meta = metadata(io, bundle.paths.library);
      selectedFile(io, bundle.paths.library, meta.value);
      if (!meta.value.entries.some(e => e.id === bundle.state!.targetId && e.name === "opencodex")) return { kind: "conflict" };
      const file = io.read(profilePath(bundle.paths.library, bundle.state.targetId));
      if (projectionHash(file?.value ?? null) !== bundle.state.lastProjectionHash) return { kind: "conflict" };
      return { kind: bundle.state.phase === "restored" ? "restored" : "active" };
    }
    if (existsSync(bundle.paths.root) && !receipt(io)) throw new DesktopStoreError("unsafe");
    const legacy = locateLegacy(io, owner, serviceGenerations());
    if (legacy) currentConnection(owner);
    return { kind: legacy ? "legacy_current_connection" : "absent" };
  } catch (error) { return { kind: error instanceof DesktopStoreError && error.reason === "conflict" ? "conflict" : "unsafe" }; }
}

export function applyRemoteDesktopStore(held: ClientLifecycleHeld, options: {
  owner: DesktopRemoteOwner; expectedTokenFingerprint: string;
  baseUrl: string; apiKey: string; mode: Desktop3pConfigMode; models: Desktop3pModelEntry[];
}): DesktopStoreResult {
  return mutation(held, io => {
    const { config, client } = currentConnection(options.owner);
    noDisconnect(io);
    if (client.pendingOperation) throw new DesktopStoreError("conflict");
    const token = readServiceApiTokenState();
    if (token.kind !== "present" || token.fingerprint !== options.expectedTokenFingerprint || token.fingerprint !== client.tokenFingerprint
      || serviceApiTokenFingerprint(options.apiKey) !== token.fingerprint || origin(options.baseUrl) !== options.owner.serverUrl) throw new DesktopStoreError("conflict");
    if (config.clientIntegrations?.["claude-desktop"] === false) throw new DesktopStoreError("desired_disabled");
    if (!options.models.length || !["static", "hybrid", "discovery"].includes(options.mode)) throw new DesktopStoreError("unsafe");
    assertDesktop3pModelsValid(options.models);
    const bundle = establish(io, options.owner, [token.fingerprint, ...serviceGenerations()], false)!;
    const value = {
      inferenceProvider: "gateway", inferenceCredentialKind: "static", inferenceGatewayBaseUrl: options.owner.serverUrl,
      inferenceGatewayApiKey: options.apiKey, modelDiscoveryEnabled: options.mode !== "static",
      ...(options.mode === "discovery" ? {} : { inferenceModels: options.models }),
    };
    artifact(io, bundle, value, "apply", token.fingerprint, bundle.state!.targetId);
    cleanBackup(io, bundle, [token.fingerprint, ...serviceGenerations()]);
    return success(io, bundle, "applied");
  });
}

export function replaceRemoteDesktopCredential(held: ClientLifecycleHeld, options: {
  owner: DesktopRemoteOwner; expectedTokenFingerprint: string; replacementKey: string;
}): DesktopStoreResult {
  return mutation(held, io => {
    const { config, client } = currentConnection(options.owner);
    noDisconnect(io);
    const token = readServiceApiTokenState();
    const generations = recordedGenerations(io, options.owner);
    const replacement = serviceApiTokenFingerprint(options.replacementKey);
    if (token.kind !== "present" || replacement !== token.fingerprint
      || (token.fingerprint !== client.tokenFingerprint && !client.pendingOperation)) throw new DesktopStoreError("conflict");
    knownGeneration(options.expectedTokenFingerprint, generations);
    const bundle = establish(io, options.owner, [options.expectedTokenFingerprint, ...generations], true);
    if (!bundle) return absent(io);
    if (bundle.state!.phase === "restored") return restoreArtifact(io, bundle, generations);
    if (config.clientIntegrations?.["claude-desktop"] === false) return restoreArtifact(io, bundle, generations);
    const file = io.read(profilePath(bundle.paths.library, bundle.state!.targetId));
    if (!file) throw new DesktopStoreError("unsafe");
    const credential = profileCredential(file.value);
    if (!credential || credential.origin !== options.owner.serverUrl
      || ![options.expectedTokenFingerprint, replacement].includes(credential.fingerprint)) throw new DesktopStoreError("conflict");
    artifact(io, bundle, { ...projection(file.value), inferenceGatewayApiKey: options.replacementKey }, "rotate", replacement);
    cleanBackup(io, bundle, [options.expectedTokenFingerprint, ...generations]);
    return success(io, bundle, "updated");
  });
}

function restoreArtifact(io: StoreIO, bundle: Bundle, known: readonly string[]): DesktopStoreResult {
  let state = bundle.state!;
  const baseline = bundle.baseline;
  if (!baseline) throw new DesktopStoreError("recovery_required");
  const meta = metadata(io, bundle.paths.library);
  selectedFile(io, bundle.paths.library, meta.value);
  let selection = meta.value.appliedId ?? state.targetId;
  let restoration: "owned_projection" | "standard_fallback" | "selection_preserved" = baseline.kind === "standard_fallback" ? "standard_fallback" : "owned_projection";
  if (selection !== state.targetId) restoration = "selection_preserved";
  else if (baseline.priorSelection && baseline.priorSelection.id !== state.targetId) {
    const priorSelection = baseline.priorSelection;
    const prior = io.read(profilePath(bundle.paths.library, priorSelection.id));
    if (!prior || prior.hash !== priorSelection.hash || !meta.value.entries.some(e => e.id === priorSelection.id)) throw new DesktopStoreError("conflict");
    const key = profileCredential(prior.value);
    if (key && known.includes(key.fingerprint)) throw new DesktopStoreError("conflict");
    selection = priorSelection.id;
  }
  const originalKey = profileCredential(baseline.projection);
  if (originalKey && known.includes(originalKey.fingerprint)) throw new DesktopStoreError("conflict");
  const current = io.read(profilePath(bundle.paths.library, state.targetId));
  const retainedForeignData = current !== null && Object.keys(current.value).length > Object.keys(projection(current.value)).length;
  if (state.pending && state.pending.kind !== "restore") {
    const observed = projectionHash(current?.value ?? null);
    if (observed !== state.pending.before && observed !== state.pending.after) throw new DesktopStoreError("conflict");
    const targetEntry = meta.value.entries.find(e => e.id === state.targetId);
    const uncommittedCreation = !baseline.targetExisted && state.lastProjectionHash === projectionHash(null);
    if ((targetEntry && targetEntry.name !== "opencodex") || (!targetEntry && !uncommittedCreation)) throw new DesktopStoreError("conflict");
    const tokenFingerprint = observed === state.pending.after ? state.pending.tokenFingerprint : state.tokenFingerprint;
    // Transition the intent, not the last committed projection. A profile may
    // already exist while its new metadata row has never been committed.
    saveState(io, bundle, { ...state, tokenFingerprint, pending: {
      kind: "restore", before: observed, after: projectionHash(baseline.projection),
      beforeSelection: meta.value.appliedId ?? null, afterSelection: selection, tokenFingerprint,
    } });
    state = bundle.state!;
  }
  artifact(io, bundle, baseline.projection, "restore", state.tokenFingerprint, selection);
  cleanBackup(io, bundle, [...known, state.tokenFingerprint]);
  return success(io, bundle, "restored", { restoration, retainedForeignData: !baseline.targetExisted && retainedForeignData });
}

export function restoreRemoteDesktopStore(held: ClientLifecycleHeld, options: {
  owner: DesktopRemoteOwner; knownTokenFingerprints: readonly string[];
}): DesktopStoreResult {
  return mutation(held, io => {
    currentConnection(options.owner);
    const generations = recordedGenerations(io, options.owner);
    if (options.knownTokenFingerprints.some(hash => !generations.includes(hash))) throw new DesktopStoreError("conflict");
    const bundle = establish(io, options.owner, generations, true);
    if (!bundle) return absent(io);
    return restoreArtifact(io, bundle, [...generations, ...options.knownTokenFingerprints]);
  });
}

export function readDesktopDisconnectReceipt():
  | { kind: "absent" } | { kind: "valid"; value: DesktopDisconnectReceipt } | { kind: "unsafe" } {
  try { const value = receipt(new StoreIO()); return value ? { kind: "valid", value } : { kind: "absent" }; }
  catch { return { kind: "unsafe" }; }
}
export function writeDesktopDisconnectReceipt(held: ClientLifecycleHeld, expected: DesktopDisconnectReceipt | null, next: DesktopDisconnectReceipt): void {
  assertClientLifecycleHeld(held);
  try {
    withConfigMutationLockSync(() => {
      parseDisconnect(next);
      if (expected) parseDisconnect(expected);
      const io = new StoreIO(), paths = storePaths();
      const file = io.read(paths.disconnect, 64 * 1024, true);
      const current = file ? parseDisconnect(file.value) : null;
      if (canonical(current) !== canonical(expected)) throw new DesktopStoreError("conflict");
      const rollover = current?.phase === "complete" && next.phase === "prepared" && !sameOwner(current.owner, next.owner);
      if (!current || rollover) {
        if (next.phase !== "prepared") throw new DesktopStoreError("conflict");
        const { client } = currentConnection(next.owner);
        const token = readServiceApiTokenState();
        if (client.pendingOperation || token.kind !== "present" || token.fingerprint !== next.tokenFingerprint || client.tokenFingerprint !== token.fingerprint) throw new DesktopStoreError("conflict");
        if (rollover) {
          const bundle = loadBundle(io);
          if (bundle.baselineFile || (bundle.state && (bundle.state.phase !== "cleaned" || !sameOwner(bundle.state.owner, current!.owner)))) throw new DesktopStoreError("conflict");
          if (bundle.stateFile) io.remove(paths.state, bundle.stateFile);
        }
      } else {
        if (!sameOwner(current.owner, next.owner) || current.tokenFingerprint !== next.tokenFingerprint || current.keepCatalog !== next.keepCatalog) throw new DesktopStoreError("conflict");
        const delta = DISCONNECT_PHASES.indexOf(next.phase) - DISCONNECT_PHASES.indexOf(current.phase);
        if (delta !== 0 && delta !== 1) throw new DesktopStoreError("conflict");
        if ((current.desktopAfterFingerprint && current.desktopAfterFingerprint !== next.desktopAfterFingerprint)
          || (current.catalogAfter && canonical(current.catalogAfter) !== canonical(next.catalogAfter))) throw new DesktopStoreError("conflict");
      }
      io.write(paths.disconnect, next, file, 64 * 1024);
    });
  } catch (error) {
    throw new Error(error instanceof DesktopStoreError && error.reason === "conflict"
      ? "desktop_disconnect_receipt_conflict" : error instanceof DesktopStoreError && error.reason === "unsafe"
        ? "desktop_disconnect_receipt_unsafe" : "desktop_disconnect_receipt_write_failed");
  }
}

export function inspectRemoteDesktopCleanup():
  | { kind: "absent" } | { kind: "active" | "restored" | "pending"; owner: DesktopRemoteOwner } | { kind: "unsafe" } {
  try {
    const io = new StoreIO(), bundle = loadBundle(io), r = receipt(io);
    if (r && bundle.state && !sameOwner(r.owner, bundle.state.owner)) throw new DesktopStoreError("unsafe");
    if (bundle.state) {
      const state = bundle.state;
      if (state.phase === "cleaned" && r?.phase === "complete") {
        return bundle.baselineFile ? { kind: "pending", owner: state.owner } : { kind: "absent" };
      }
      if (state.pending || state.phase === "prepared") return { kind: "pending", owner: state.owner };
      if (r && r.phase !== "complete" && state.phase === "cleaned") return { kind: "pending", owner: state.owner };
      return { kind: state.phase === "restored" || state.phase === "cleaned" ? "restored" : "active", owner: state.owner };
    }
    if (r && r.phase !== "complete") return { kind: "pending", owner: r.owner };
    if (!r && existsSync(bundle.paths.root)) throw new DesktopStoreError("unsafe");
    return { kind: "absent" };
  } catch { return { kind: "unsafe" }; }
}

export function finishRemoteDesktopCleanup(held: ClientLifecycleHeld, owner: DesktopRemoteOwner): DesktopStoreResult {
  return mutation(held, io => {
    const r = receipt(io);
    if (!r || !sameOwner(r.owner, owner) || !["connection_cleared", "complete"].includes(r.phase)) throw new DesktopStoreError("conflict");
    const diagnostics = readConfigDiagnostics();
    if (diagnostics.source === "fallback" || diagnostics.config.client || diagnostics.config.runtimeRole === "client"
      || readServiceApiTokenState().kind !== "absent") throw new DesktopStoreError("conflict");
    const bundle = loadBundle(io);
    requireOwner(bundle, owner);
    if (!bundle.state) return absent(io);
    if (bundle.state.phase !== "restored" && bundle.state.phase !== "cleaned") throw new DesktopStoreError("conflict");
    const target = io.read(profilePath(bundle.paths.library, bundle.state.targetId));
    if (projectionHash(target?.value ?? null) !== bundle.state.lastProjectionHash) throw new DesktopStoreError("conflict");
    cleanBackup(io, bundle, [r.tokenFingerprint, bundle.state.tokenFingerprint]);
    // Mark cleanup before unlink so a crash between the two remains recoverable.
    if (bundle.state.phase !== "cleaned") saveState(io, bundle, { ...bundle.state, phase: "cleaned" });
    if (bundle.baselineFile) io.remove(bundle.paths.baseline, bundle.baselineFile);
    return success(io, bundle, "restored", { restartRequired: false });
  });
}
