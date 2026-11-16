/**
 * Standalone native originals for a linked Child.
 *
 * A Child applying its Home's route intent writes the Child's own native switches
 * (clientIntegrations.codex|grok|claude-desktop, claudeCode.enabled, and as side effects
 * claudeCode.authModeMigratedAt and apiSurfaces.messages). This private, machine-scoped
 * record remembers, per field, the value that existed before route intent first changed it
 * (absent is a value: null), plus the last value this writer published and any value it was
 * about to publish (pending). It is captured once and never overwritten by later syncs or
 * connects, and it is not bound to a link: it means "the standalone value before route intent
 * touched it", which stays true after a crashed connect followed by a different link.
 *
 * Callers hold the client lifecycle lock; every function here takes the config mutation lock,
 * preserving the documented lifecycle -> config order. Writes are write-ahead: the original and
 * pending value reach this file before the atomic config write, and the value is marked
 * published after it. Restore (disconnect, failed enrollment) puts the original back only for a
 * field whose current value this writer published or had pending; any other value is the
 * person's own edit and is kept. The record is removed only after the restored config is read
 * back and verified, so an interrupted restore is retried safely by the next disconnect.
 *
 * Limit (ABA): a person who sets a field to exactly the value this writer published cannot be
 * told apart from the writer, and that field is restored. The Child's local opt-out list is the
 * person's own choice and is not part of this record.
 */
import { chmodSync, lstatSync, mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteFile, isMissingPathError } from "../config/atomic-write";
import { withConfigMutationLockSync } from "../config/mutation-lock";
import { mutatePersistedConfig, readConfigForAdmittedMutation } from "../config/persisted-mutation";
import { deleteConfigObjectChildKey } from "../config/rebase-provenance";
import { assertNotRealHomeUnderTest } from "../lib/test-home-guard";
import { hardenSecretDir } from "../lib/windows-secret-acl";
import { linkDir } from "../link/paths";
import type { OcxConfig } from "../types";

export const NATIVE_INTENT_FIELDS = ["codex", "grok", "claude-desktop", "claude", "claudeMigratedAt", "messages"] as const;
export type NativeIntentField = typeof NATIVE_INTENT_FIELDS[number];
/** null means the key is absent; anything else is the exact persisted value. */
export type NativeIntentSlot = boolean | string | Record<string, unknown> | null;
export type NativeIntentFields = Record<NativeIntentField, NativeIntentSlot>;
type Entry = { original: NativeIntentSlot; published?: NativeIntentSlot; pending?: NativeIntentSlot };
export type NativeIntentOriginals = { version: 1; fields: Partial<Record<NativeIntentField, Entry>> };

const RECORD_MAX_BYTES = 16 * 1024;
const unsafe = (): never => {
  throw new Error(`Native intent originals record is unreadable; inspect or remove ${nativeIntentOriginalsPath()} and retry`);
};
const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const sameSlot = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

export function nativeIntentOriginalsPath(): string { return join(linkDir(), "native-intent-originals.json"); }

const integrationField = (field: NativeIntentField): field is "codex" | "grok" | "claude-desktop" =>
  field === "codex" || field === "grok" || field === "claude-desktop";
const parentKey = (field: NativeIntentField) => integrationField(field) ? "clientIntegrations" as const
  : field === "messages" ? "apiSurfaces" as const : "claudeCode" as const;
const childKey = (field: NativeIntentField): string => integrationField(field) ? field
  : field === "messages" ? "messages" : field === "claude" ? "enabled" : "authModeMigratedAt";

export function readNativeIntentField(config: OcxConfig, field: NativeIntentField): NativeIntentSlot {
  const parent = (config as unknown as Record<string, unknown>)[parentKey(field)];
  if (!isRecord(parent) || !Object.hasOwn(parent, childKey(field)) || parent[childKey(field)] === undefined) return null;
  return structuredClone(parent[childKey(field)]) as NativeIntentSlot;
}

export function nativeIntentFields(config: OcxConfig): NativeIntentFields {
  return Object.fromEntries(NATIVE_INTENT_FIELDS.map(field => [field, readNativeIntentField(config, field)])) as NativeIntentFields;
}

function writeNativeIntentField(config: OcxConfig, field: NativeIntentField, value: NativeIntentSlot): void {
  const key = parentKey(field);
  if (value === null) { deleteConfigObjectChildKey(config, key, childKey(field)); return; }
  const record = config as unknown as Record<string, unknown>;
  const parent = isRecord(record[key]) ? record[key] as Record<string, unknown> : {};
  record[key] = { ...parent, [childKey(field)]: structuredClone(value) };
}

function validSlot(field: NativeIntentField, value: unknown): value is NativeIntentSlot {
  if (value === null) return true;
  if (field === "claudeMigratedAt") return typeof value === "string" && value.length <= 64;
  if (field === "messages") return isRecord(value) && Object.values(value).every(item => item === null || ["boolean", "string", "number"].includes(typeof item));
  return typeof value === "boolean";
}

function parse(value: unknown): NativeIntentOriginals {
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.fields) || Object.keys(value).length !== 2) return unsafe();
  for (const [field, entry] of Object.entries(value.fields)) {
    if (!(NATIVE_INTENT_FIELDS as readonly string[]).includes(field) || !isRecord(entry) || !Object.hasOwn(entry, "original")) return unsafe();
    for (const [key, slot] of Object.entries(entry)) {
      if (!["original", "published", "pending"].includes(key) || !validSlot(field as NativeIntentField, slot)) return unsafe();
    }
  }
  return value as NativeIntentOriginals;
}

/** Missing reads as null. A present but unsafe or malformed record refuses rather than losing originals. */
export function readNativeIntentOriginals(): NativeIntentOriginals | null {
  const path = nativeIntentOriginalsPath();
  let stat;
  try { stat = lstatSync(path); } catch (error) { if (isMissingPathError(error)) return null; throw error; }
  if (!stat.isFile() || stat.size > RECORD_MAX_BYTES) return unsafe();
  let value: unknown;
  try { value = JSON.parse(readFileSync(path, "utf8")); } catch { return unsafe(); }
  return parse(value);
}

function writeRecord(record: NativeIntentOriginals): void {
  parse(record);
  const path = nativeIntentOriginalsPath(), dir = linkDir();
  assertNotRealHomeUnderTest(join(dir, ".."));
  const body = `${JSON.stringify(record, null, 2)}\n`;
  if (Buffer.byteLength(body) > RECORD_MAX_BYTES) unsafe();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (process.platform === "win32") hardenSecretDir(dir, { required: true });
  else chmodSync(dir, 0o700);
  atomicWriteFile(path, body);
  if (process.platform !== "win32") chmodSync(path, 0o600);
}

function clearRecord(): void {
  assertNotRealHomeUnderTest(join(linkDir(), ".."));
  try { unlinkSync(nativeIntentOriginalsPath()); } catch (error) { if (!isMissingPathError(error)) throw error; }
}

/** True when the value is one this writer published or was about to publish. */
function ownedByWriter(entry: Entry, current: NativeIntentSlot): boolean {
  return (Object.hasOwn(entry, "published") && sameSlot(entry.published, current))
    || (Object.hasOwn(entry, "pending") && sameSlot(entry.pending, current));
}

/**
 * Write-ahead half: call under the config mutation lock before the atomic config write. Only
 * fields that actually change are recorded, so a no-op toggle claims nothing. The first capture
 * of a field keeps its original forever; a pending value a crash left behind and the config
 * shows is promoted to published first.
 */
export function prepareNativeIntentWrite(before: NativeIntentFields, after: NativeIntentFields): boolean {
  return withConfigMutationLockSync(() => {
    const changed = NATIVE_INTENT_FIELDS.filter(field => !sameSlot(before[field], after[field]));
    if (!changed.length) return false;
    const record = readNativeIntentOriginals() ?? { version: 1 as const, fields: {} };
    for (const field of changed) {
      const entry: Entry = record.fields[field] ?? { original: structuredClone(before[field]) };
      if (Object.hasOwn(entry, "pending") && sameSlot(entry.pending, before[field])) entry.published = entry.pending;
      entry.pending = structuredClone(after[field]);
      record.fields[field] = entry;
    }
    writeRecord(record);
    return true;
  });
}

/** Completion half: mark each pending value the committed config now shows as published. */
export function publishNativeIntentWrite(actual: NativeIntentFields): void {
  withConfigMutationLockSync(() => {
    const record = readNativeIntentOriginals();
    if (!record) return;
    let changed = false;
    for (const field of NATIVE_INTENT_FIELDS) {
      const entry = record.fields[field];
      if (!entry || !Object.hasOwn(entry, "pending") || !sameSlot(entry.pending, actual[field])) continue;
      entry.published = entry.pending;
      delete entry.pending;
      changed = true;
    }
    if (changed) writeRecord(record);
  });
}

/**
 * Restore standalone values and remove the record once the restored config is verified.
 * Idempotent: a retry after an interrupted restore finds the original or the person's own
 * value and only removes the record. Returns whether a record existed.
 */
export function restoreNativeIntentOriginals(guard: () => void): boolean {
  return withConfigMutationLockSync(() => {
    guard();
    const record = readNativeIntentOriginals();
    if (!record) return false;
    const fields = Object.entries(record.fields) as [NativeIntentField, Entry][];
    const result = mutatePersistedConfig(config => {
      guard();
      let changed = false;
      for (const [field, entry] of fields) {
        const current = readNativeIntentField(config, field);
        if (!ownedByWriter(entry, current) || sameSlot(current, entry.original)) continue;
        writeNativeIntentField(config, field, entry.original);
        changed = true;
      }
      return { changed, value: config };
    });
    if (result.status === "unavailable") throw new Error(`Standalone native intent could not be restored (${result.reason})`);
    const verified = nativeIntentFields(readConfigForAdmittedMutation());
    if (fields.some(([field, entry]) => ownedByWriter(entry, verified[field]) && !sameSlot(verified[field], entry.original))) {
      throw new Error("Standalone native intent restore was not verified; rerun the operation");
    }
    guard();
    clearRecord();
    return true;
  });
}
