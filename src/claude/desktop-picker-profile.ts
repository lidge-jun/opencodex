/**
 * Claude Desktop picker mode: the owned egress profile in Desktop's config library.
 *
 * The profile is an owned standard row named `opencodex-picker` whose file holds only
 * `egressProxyUrl`, pointing Desktop at the dedicated picker CONNECT proxy
 * (`ClaudeInterceptState.pickerProxyPort`). The previous selection is kept in opencodex state
 * (`<configDir>/claude-picker/profile-state.json`), never in Desktop's `_meta.json`.
 */
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { withClientLifecycleSync } from "../client/lifecycle-lock";
import { atomicWriteFile, getConfigDir, withConfigMutationLockSync } from "../config";
import {
  DESKTOP_PICKER_ENTRY_NAME,
  isOwnedDesktopGatewayEntry,
  parseMetadata,
  profilePath,
  resolveDesktop3pConfigLibraryPath,
  SAFE_DESKTOP_PROFILE_ID,
  type Desktop3pConfigLibraryOptions,
  type Desktop3pMetadata,
  type Desktop3pMetadataEntry,
} from "./desktop-3p-library";

// Keep a module-local rollback writer. Tests and callers may replace the public config writer to
// inject a forward-write failure; rollback must still be able to restore the prior bytes.
const rollbackAtomicWriteFile = atomicWriteFile;

export interface DesktopPickerProfileState { entryId: string; previousAppliedId: string | null }
export type DesktopPickerProfileInspection =
  | { kind: "absent" }
  | { kind: "applied"; entryId: string; proxyUrl: string }
  | { kind: "not_selected"; entryId: string }
  | { kind: "unsafe"; reason: string };

export type DesktopPickerProfileOptions = Desktop3pConfigLibraryOptions & { configDir?: string };

const PICKER_DIRECTORY = "claude-picker";

function pickerStatePath(configDir: string): string {
  return join(configDir, PICKER_DIRECTORY, "profile-state.json");
}

function metadataPath(libraryPath: string): string {
  return join(libraryPath, "_meta.json");
}

function metadataJson(metadata: Desktop3pMetadata): string {
  return JSON.stringify(metadata, null, 2) + "\n";
}

function isValidMetadata(metadata: Desktop3pMetadata): boolean {
  return metadata.entries.every(entry =>
    entry !== null && typeof entry === "object" && typeof entry.id === "string" && typeof entry.name === "string");
}

function readPickerState(path: string): DesktopPickerProfileState | null {
  if (!existsSync(path)) return null;
  const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<DesktopPickerProfileState>;
  if (typeof parsed.entryId !== "string" || !SAFE_DESKTOP_PROFILE_ID.test(parsed.entryId)) {
    throw new Error("picker_profile_state_unreadable");
  }
  if (parsed.previousAppliedId !== null
    && parsed.previousAppliedId !== undefined
    && (typeof parsed.previousAppliedId !== "string" || !SAFE_DESKTOP_PROFILE_ID.test(parsed.previousAppliedId))) {
    throw new Error("picker_profile_state_unreadable");
  }
  return { entryId: parsed.entryId, previousAppliedId: parsed.previousAppliedId ?? null };
}

function readFileSnapshot(path: string): { exists: boolean; content?: string } {
  return existsSync(path) ? { exists: true, content: readFileSync(path, "utf8") } : { exists: false };
}

function restoreFile(path: string, snapshot: { exists: boolean; content?: string }): void {
  if (snapshot.exists) {
    rollbackAtomicWriteFile(path, snapshot.content ?? "");
  } else if (existsSync(path)) {
    unlinkSync(path);
  }
}

function unlinkIfPresent(path: string): void {
  if (existsSync(path)) unlinkSync(path);
}

function pickerEntries(metadata: Desktop3pMetadata): Desktop3pMetadataEntry[] {
  return metadata.entries.filter(entry => entry.name === DESKTOP_PICKER_ENTRY_NAME);
}

function pickerEntry(metadata: Desktop3pMetadata): Desktop3pMetadataEntry | undefined {
  const entries = pickerEntries(metadata);
  if (entries.length > 1) throw new Error("duplicate_picker_entries");
  const entry = entries[0];
  if (entry && !SAFE_DESKTOP_PROFILE_ID.test(entry.id)) throw new Error("unsafe_picker_id");
  return entry;
}

function profileObject(path: string): Record<string, unknown> {
  const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("picker_profile_unreadable");
  }
  return parsed as Record<string, unknown>;
}

function validPickerProfile(profile: Record<string, unknown>): profile is { egressProxyUrl: string } {
  const keys = Object.keys(profile);
  const proxyUrl = profile.egressProxyUrl;
  const port = typeof proxyUrl === "string" ? /^http:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})$/.exec(proxyUrl)?.[1] : undefined;
  return keys.length === 1
    && keys[0] === "egressProxyUrl"
    && typeof proxyUrl === "string"
    && port !== undefined
    && Number(port) <= 65535;
}

export function pickerEgressUrl(proxyPort: number): string {
  return `http://127.0.0.1:${proxyPort}`;
}

type ApplyPickerProfileResult =
  | { ok: true; changed: boolean; path: string }
  | { ok: false; reason: "gateway_selected" | "foreign_unreadable" | "write_failed" };
type RemovePickerProfileResult = { ok: true; changed: boolean } | { ok: false; reason: string; residualPaths?: string[] };

/**
 * Select the picker profile. Runs under the client lifecycle lock and the config mutation lock,
 * the same boundary as the gateway writer (src/claude/desktop-3p.ts), so another process cannot
 * interleave a gateway or catalog write with the selection.
 */
export function applyDesktopPickerProfile(options: { proxyPort: number } & DesktopPickerProfileOptions): ApplyPickerProfileResult {
  try {
    return withClientLifecycleSync(() => withConfigMutationLockSync(() => applyDesktopPickerProfileLocked(options)));
  } catch {
    return { ok: false, reason: "write_failed" };
  }
}

/** Remove the picker profile under the same locks as `applyDesktopPickerProfile`. */
export function removeDesktopPickerProfile(options: DesktopPickerProfileOptions = {}): RemovePickerProfileResult {
  try {
    return withClientLifecycleSync(() => withConfigMutationLockSync(() => removeDesktopPickerProfileLocked(options)));
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : "lock_unavailable" };
  }
}

function applyDesktopPickerProfileLocked(options: { proxyPort: number } & DesktopPickerProfileOptions): ApplyPickerProfileResult {
  const libraryPath = resolveDesktop3pConfigLibraryPath(options);
  const configDir = options.configDir ?? getConfigDir();
  const metaPath = metadataPath(libraryPath);
  let profile = join(libraryPath, "picker.json");
  try {
    if (!Number.isInteger(options.proxyPort) || options.proxyPort < 1 || options.proxyPort > 65535) {
      return { ok: false, reason: "write_failed" };
    }
    mkdirSync(libraryPath, { recursive: true, mode: 0o700 });
    const metadata = parseMetadata(metaPath);
    if (!isValidMetadata(metadata)) return { ok: false, reason: "foreign_unreadable" };
    if (metadata.appliedId !== undefined
      && (typeof metadata.appliedId !== "string" || !SAFE_DESKTOP_PROFILE_ID.test(metadata.appliedId))) {
      return { ok: false, reason: "foreign_unreadable" };
    }
    const selectedId = typeof metadata.appliedId === "string" ? metadata.appliedId : null;
    const selected = selectedId === null ? undefined : metadata.entries.find(entry => entry.id === selectedId);
    if (selected && isOwnedDesktopGatewayEntry(selected)) return { ok: false, reason: "gateway_selected" };

    const existing = pickerEntry(metadata);
    const entryId = existing?.id ?? randomUUID();
    profile = profilePath(libraryPath, entryId);
    const target = JSON.stringify({ egressProxyUrl: pickerEgressUrl(options.proxyPort) }) + "\n";
    const previousStatePath = pickerStatePath(configDir);
    const alreadySelected = selectedId === entryId;
    const priorState = readPickerState(previousStatePath);
    const previousAppliedId = alreadySelected ? priorState?.previousAppliedId ?? null : selectedId;
    const oldMeta = readFileSnapshot(metaPath);
    const oldProfile = readFileSnapshot(profile);
    const backupPath = `${profile}.bak`;
    const oldBackup = readFileSnapshot(backupPath);
    const oldState = readFileSnapshot(previousStatePath);
    const changed = !alreadySelected || !oldProfile.exists || oldProfile.content !== target;
    if (!changed) return { ok: true, changed: false, path: profile };

    mkdirSync(join(configDir, PICKER_DIRECTORY), { recursive: true, mode: 0o700 });
    try {
      // Keep the same backup convention as the existing Desktop writer. It is removed with the
      // picker row and also gives this transaction a private rollback source.
      if (oldProfile.exists) atomicWriteFile(backupPath, oldProfile.content ?? "");
      atomicWriteFile(profile, target);
      if (!alreadySelected) {
        atomicWriteFile(previousStatePath, JSON.stringify({ entryId, previousAppliedId }) + "\n");
      }
      const entries = existing
        ? metadata.entries.map(entry => entry.id === entryId ? { ...entry, name: DESKTOP_PICKER_ENTRY_NAME } : entry)
        : [...metadata.entries, { id: entryId, name: DESKTOP_PICKER_ENTRY_NAME }];
      atomicWriteFile(metaPath, metadataJson({ ...metadata, appliedId: entryId, entries }));
    } catch {
      try {
        restoreFile(metaPath, oldMeta);
        restoreFile(profile, oldProfile);
        restoreFile(backupPath, oldBackup);
        restoreFile(previousStatePath, oldState);
      } catch {
        // The public result remains deliberately opaque; callers can inspect the library.
      }
      return { ok: false, reason: "write_failed" };
    }
    return { ok: true, changed: true, path: profile };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { ok: false, reason: reason === "picker_profile_state_unreadable" || reason === "duplicate_picker_entries" || reason === "unsafe_picker_id" || reason === "picker_profile_unreadable"
      ? "foreign_unreadable" : "write_failed" };
  }
}

function removeDesktopPickerProfileLocked(options: DesktopPickerProfileOptions): RemovePickerProfileResult {
  const libraryPath = resolveDesktop3pConfigLibraryPath(options);
  const configDir = options.configDir ?? getConfigDir();
  const statePath = pickerStatePath(configDir);
  const metaPath = metadataPath(libraryPath);
  try {
    if (!existsSync(metaPath)) {
      const hadState = existsSync(statePath);
      unlinkIfPresent(statePath);
      return { ok: true, changed: hadState };
    }
    const metadata = parseMetadata(metaPath);
    if (!isValidMetadata(metadata)) return { ok: false, reason: "metadata_unreadable" };
    const picker = pickerEntry(metadata);
    if (!picker) {
      const hadState = existsSync(statePath);
      unlinkIfPresent(statePath);
      return { ok: true, changed: hadState };
    }
    const selected = metadata.appliedId === picker.id;
    let state: DesktopPickerProfileState | null = null;
    try { state = readPickerState(statePath); } catch { return { ok: false, reason: "profile_state_unreadable" }; }

    let metadataAfterPivot = metadata;
    if (selected) {
      const previous = state?.entryId === picker.id ? state.previousAppliedId : null;
      const previousExists = previous !== null && previous !== picker.id && metadata.entries.some(entry => entry.id === previous);
      if (previousExists) {
        metadataAfterPivot = { ...metadata, appliedId: previous };
      } else {
        const standardId = randomUUID();
        atomicWriteFile(profilePath(libraryPath, standardId), "{}\n");
        metadataAfterPivot = {
          ...metadata,
          appliedId: standardId,
          entries: [...metadata.entries, { id: standardId, name: "opencodex-standard" }],
        };
      }
      atomicWriteFile(metaPath, metadataJson(metadataAfterPivot));
    }

    const residualPaths: string[] = [];
    for (const path of [profilePath(libraryPath, picker.id), `${profilePath(libraryPath, picker.id)}.bak`]) {
      try { unlinkIfPresent(path); } catch { /* report the path without exposing file contents */ }
      if (existsSync(path)) residualPaths.push(path);
    }
    if (residualPaths.length > 0) {
      return { ok: false, reason: "cleanup_incomplete", residualPaths };
    }

    const entries = metadataAfterPivot.entries.filter(entry => entry.id !== picker.id);
    try {
      atomicWriteFile(metaPath, metadataJson({ ...metadataAfterPivot, entries }));
      try { unlinkIfPresent(statePath); } catch { /* residual is reported below */ }
      if (existsSync(statePath)) return { ok: false, reason: "cleanup_incomplete", residualPaths: [statePath] };
    } catch {
      return { ok: false, reason: "write_failed", residualPaths: [metaPath] };
    }
    return { ok: true, changed: true };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : "cleanup_failed" };
  }
}

export function inspectDesktopPickerProfile(options: DesktopPickerProfileOptions = {}): DesktopPickerProfileInspection {
  const libraryPath = resolveDesktop3pConfigLibraryPath(options);
  const metaPath = metadataPath(libraryPath);
  if (!existsSync(metaPath)) return { kind: "absent" };
  try {
    const metadata = parseMetadata(metaPath);
    if (!isValidMetadata(metadata)) return { kind: "unsafe", reason: "metadata_unreadable" };
    const picker = pickerEntry(metadata);
    if (!picker) return { kind: "absent" };
    const path = profilePath(libraryPath, picker.id);
    if (!existsSync(path)) return { kind: "unsafe", reason: "profile_missing" };
    const profile = profileObject(path);
    if (!validPickerProfile(profile)) return { kind: "unsafe", reason: "invalid_profile" };
    return metadata.appliedId === picker.id
      ? { kind: "applied", entryId: picker.id, proxyUrl: profile.egressProxyUrl }
      : { kind: "not_selected", entryId: picker.id };
  } catch (error) {
    const reason = error instanceof Error ? error.message : "metadata_unreadable";
    return { kind: "unsafe", reason };
  }
}
