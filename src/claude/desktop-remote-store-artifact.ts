import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { readConfigDiagnostics } from "../config";
import { readServiceApiTokenState, readTokenBackupState, serviceApiTokenFingerprint } from "../lib/service-secrets";
import { profilePath, type Desktop3pMetadata } from "./desktop-3p-library";
import { StoreIO, metadata, storePaths, MAX_DESKTOP_METADATA_ENTRIES, type JsonFile } from "./desktop-remote-store-io";
import {
  DesktopStoreError, digest, origin, parseBaseline, parseDisconnect, parseOwner, parseState, projection, projectionHash, mergeProjection,
  sameOwner, type ArtifactPending, type Baseline, type DesktopRemoteOwner, type Projection, type StoreState,
} from "./desktop-remote-store-state";

export function currentConnection(owner: DesktopRemoteOwner) {
  parseOwner(owner);
  const { config, source } = readConfigDiagnostics();
  const client = config.client;
  if (source !== "file" || config.runtimeRole !== "client" || !client
    || origin(client.serverUrl) !== owner.serverUrl || client.apiKeyId !== owner.apiKeyId || client.connectedAt !== owner.connectedAt) throw new DesktopStoreError("conflict");
  return { config, client };
}
export function serviceGenerations(): string[] {
  const token = readServiceApiTokenState();
  const backup = readTokenBackupState();
  if (token.kind === "unsafe" || backup.kind === "unsafe") throw new DesktopStoreError("unsafe");
  return [token, backup].flatMap(t => t.kind === "present" ? [t.fingerprint] : []);
}
export function profileCredential(value: Record<string, unknown> | null): { origin: string; fingerprint: string } | null {
  if (!value || value.inferenceProvider !== "gateway" || value.inferenceCredentialKind !== "static") return null;
  if (typeof value.inferenceGatewayApiKey !== "string") throw new DesktopStoreError("unsafe");
  return { origin: origin(value.inferenceGatewayBaseUrl), fingerprint: serviceApiTokenFingerprint(value.inferenceGatewayApiKey) };
}
export function loadBundle(io: StoreIO) {
  const paths = storePaths();
  const stateFile = io.read(paths.state, 64 * 1024, true);
  const baselineFile = io.read(paths.baseline, 1024 * 1024, true);
  const state = stateFile ? parseState(stateFile.value) : null;
  const baseline = baselineFile ? parseBaseline(baselineFile.value) : null;
  if (!state && baseline) throw new DesktopStoreError("unsafe");
  if (state) {
    if (state.home !== paths.home || state.library !== paths.library) throw new DesktopStoreError("unsafe");
    if (!baseline && state.phase !== "prepared" && state.phase !== "cleaned") throw new DesktopStoreError("unsafe");
    if (baseline && (baselineFile!.hash !== state.baselineHash || baseline.home !== paths.home
      || baseline.library !== paths.library || baseline.targetId !== state.targetId || baseline.kind !== state.baselineKind
      || !sameOwner(baseline.owner, state.owner))) throw new DesktopStoreError("unsafe");
  }
  return { paths, stateFile, baselineFile, state, baseline };
}
export type Bundle = ReturnType<typeof loadBundle>;
export function requireOwner(bundle: Bundle, owner: DesktopRemoteOwner): void {
  if (bundle.state && !sameOwner(bundle.state.owner, owner)) throw new DesktopStoreError("conflict");
}
export function selectedFile(io: StoreIO, library: string, meta: Desktop3pMetadata): JsonFile | null {
  if (!meta.appliedId) return null;
  const file = io.read(profilePath(library, meta.appliedId));
  if (!file) throw new DesktopStoreError("unsafe");
  return file;
}
export function locateLegacy(io: StoreIO, owner: DesktopRemoteOwner, known: readonly string[]) {
  const paths = storePaths();
  const meta = metadata(io, paths.library);
  selectedFile(io, paths.library, meta.value);
  let found: { id: string; file: JsonFile } | null = null;
  for (const entry of meta.value.entries) {
    const file = io.read(profilePath(paths.library, entry.id));
    if (!file) { if (entry.id === meta.value.appliedId) throw new DesktopStoreError("unsafe"); continue; }
    const credential = profileCredential(file.value);
    if (!credential || credential.origin !== owner.serverUrl) continue;
    if (entry.name !== "opencodex" || !known.includes(credential.fingerprint) || found) throw new DesktopStoreError("conflict");
    found = { id: entry.id, file };
  }
  return found;
}
export function saveState(io: StoreIO, bundle: Bundle, state: StoreState): void {
  parseState(state);
  io.write(bundle.paths.state, state, bundle.stateFile, 64 * 1024);
  bundle.state = state;
  bundle.stateFile = io.read(bundle.paths.state, 64 * 1024, true);
}
export function establish(io: StoreIO, owner: DesktopRemoteOwner, known: readonly string[], onlyLegacy: boolean): Bundle | null {
  let bundle = loadBundle(io);
  const terminalFile = io.read(bundle.paths.disconnect, 64 * 1024, true);
  const terminal = terminalFile ? parseDisconnect(terminalFile.value) : null;
  if (terminal?.phase === "complete" && !sameOwner(terminal.owner, owner)) {
    currentConnection(owner);
    if (bundle.baselineFile || (bundle.state && (bundle.state.phase !== "cleaned" || !sameOwner(bundle.state.owner, terminal.owner)))) throw new DesktopStoreError("conflict");
    if (bundle.stateFile) io.remove(bundle.paths.state, bundle.stateFile);
    io.remove(bundle.paths.disconnect, terminalFile!);
    bundle = loadBundle(io);
  }
  requireOwner(bundle, owner);
  if (bundle.state && bundle.baseline) return bundle;
  if (bundle.state?.phase === "cleaned") throw new DesktopStoreError("conflict");
  const meta = metadata(io, bundle.paths.library);
  const selected = selectedFile(io, bundle.paths.library, meta.value);
  const legacy = locateLegacy(io, owner, known);
  if (onlyLegacy && !legacy && !bundle.state) return null;
  const entry = meta.value.entries.find(e => e.id === meta.value.appliedId && e.name === "opencodex")
    ?? meta.value.entries.find(e => e.name === "opencodex");
  const targetId = bundle.state?.targetId ?? legacy?.id ?? entry?.id ?? randomUUID();
  if (!meta.value.entries.some(e => e.id === targetId) && meta.value.entries.length >= MAX_DESKTOP_METADATA_ENTRIES) {
    throw new DesktopStoreError("conflict");
  }
  const target = io.read(profilePath(bundle.paths.library, targetId));
  const credential = profileCredential(target?.value ?? null);
  if (credential && known.includes(credential.fingerprint) && credential.origin !== owner.serverUrl) throw new DesktopStoreError("conflict");
  const fallback = credential?.origin === owner.serverUrl;
  if (fallback && (!known.includes(credential.fingerprint) || (entry?.name !== "opencodex" && legacy?.id !== targetId))) throw new DesktopStoreError("conflict");
  const priorSelection = meta.value.appliedId && selected && !(fallback && meta.value.appliedId === targetId)
    ? { id: meta.value.appliedId, hash: selected.hash } : null;
  const baseline: Baseline = {
    version: 1, owner, home: bundle.paths.home, library: bundle.paths.library, targetId,
    kind: fallback ? "standard_fallback" : "known", targetExisted: target !== null,
    projection: fallback ? {} : projection(target?.value ?? {}), priorSelection,
  };
  const baselineHash = digest(JSON.stringify(baseline, null, 2) + "\n");
  if (bundle.state && (bundle.state.phase !== "prepared" || bundle.state.baselineHash !== baselineHash
    || bundle.state.lastProjectionHash !== projectionHash(target?.value ?? null))) throw new DesktopStoreError("conflict");
  if (!bundle.state) saveState(io, bundle, {
    version: 1, owner, home: bundle.paths.home, library: bundle.paths.library, targetId,
    baselineRef: "baseline.json", baselineHash, baselineKind: baseline.kind, phase: "prepared",
    lastProjectionHash: projectionHash(target?.value ?? null), tokenFingerprint: known[0]!,
  });
  io.write(bundle.paths.baseline, baseline, null);
  bundle = loadBundle(io);
  saveState(io, bundle, { ...bundle.state!, phase: "active" });
  return bundle;
}

export function artifact(io: StoreIO, bundle: Bundle, next: Projection, kind: ArtifactPending["kind"], tokenFingerprint: string, desiredSelection?: string | null): void {
  const state = bundle.state!;
  const targetPath = profilePath(bundle.paths.library, state.targetId);
  let current = io.read(targetPath);
  const meta = metadata(io, bundle.paths.library);
  const existing = meta.value.entries.find(e => e.id === state.targetId);
  // An absent row is valid only while a recorded first creation is unfinished.
  // Keeping the original null projection receipt across apply -> restore proves it.
  const uncommittedCreation = bundle.baseline?.targetExisted === false && state.lastProjectionHash === projectionHash(null);
  if ((existing && existing.name !== "opencodex") || (!existing && !uncommittedCreation)) throw new DesktopStoreError("conflict");
  if (!existing && meta.value.entries.length >= MAX_DESKTOP_METADATA_ENTRIES) throw new DesktopStoreError("conflict");
  const before = projectionHash(current?.value ?? null), after = projectionHash(next);
  const selection = meta.value.appliedId ?? null;
  const pending = state.pending;
  if (pending) {
    if (pending.kind !== kind || pending.after !== after || pending.tokenFingerprint !== tokenFingerprint
      || (before !== pending.before && before !== pending.after)) throw new DesktopStoreError("conflict");
    if (kind === "apply" && selection !== pending.beforeSelection && selection !== pending.afterSelection) throw new DesktopStoreError("conflict");
  } else if (before !== state.lastProjectionHash) throw new DesktopStoreError("conflict");
  const afterSelection = desiredSelection === undefined ? selection : desiredSelection;
  const settledPhase = kind === "restore" ? "restored" : "active";
  if (!pending && existing && before === after && afterSelection === selection
    && state.phase === settledPhase && state.tokenFingerprint === tokenFingerprint) return;
  if (!pending) saveState(io, bundle, { ...state, pending: { kind, before, after, beforeSelection: selection, afterSelection, tokenFingerprint } });
  if (before !== after) {
    io.write(targetPath, mergeProjection(current?.value ?? {}, next), current);
    current = io.read(targetPath);
  }
  // Build from fresh metadata, so unrelated rows/fields are never restored from baseline bytes.
  const fresh = metadata(io, bundle.paths.library);
  const freshEntry = fresh.value.entries.find(e => e.id === state.targetId);
  if ((fresh.value.appliedId ?? null) !== selection || freshEntry?.name !== existing?.name) throw new DesktopStoreError("conflict");
  if (!existing || afterSelection !== selection) {
    if (!existing && fresh.value.entries.length >= MAX_DESKTOP_METADATA_ENTRIES) throw new DesktopStoreError("conflict");
    if (afterSelection && !io.read(profilePath(bundle.paths.library, afterSelection))) throw new DesktopStoreError("unsafe");
    const entries = existing ? fresh.value.entries : [...fresh.value.entries, { id: state.targetId, name: "opencodex" }];
    const value = { ...fresh.value, entries, ...(afterSelection ? { appliedId: afterSelection } : {}) };
    io.write(join(bundle.paths.library, "_meta.json"), value, fresh.file);
  }
  const { pending: _pending, ...settled } = bundle.state!;
  saveState(io, bundle, { ...settled, phase: kind === "restore" ? "restored" : "active", lastProjectionHash: after, tokenFingerprint });
}
export function cleanBackup(io: StoreIO, bundle: Bundle, known: readonly string[]): void {
  const path = `${profilePath(bundle.paths.library, bundle.state!.targetId)}.bak`;
  const file = io.read(path);
  if (!file) return;
  const credential = profileCredential(file.value);
  if (!credential || credential.origin !== bundle.state!.owner.serverUrl) return;
  if (!known.includes(credential.fingerprint)) throw new DesktopStoreError("conflict");
  const foreign = mergeProjection(file.value, {});
  try {
    if (Object.keys(foreign).length) io.write(path, foreign, file);
    else io.remove(path, file);
  } catch (error) {
    if (error instanceof DesktopStoreError) throw error;
    throw new DesktopStoreError("cleanup_pending");
  }
}
