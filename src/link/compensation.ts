import { chmodSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { atomicWriteFile, isMissingPathError } from "../config/atomic-write";
import { assertNotRealHomeUnderTest } from "../lib/test-home-guard";
import { hardenSecretDir } from "../lib/windows-secret-acl";
import { linkDir } from "./paths";

export interface CompensationEntry {
  reason: "compensation_failed";
  since: string;
}

export interface CompensationStore {
  version: 1;
  entries: Record<string, CompensationEntry>;
}

export class CompensationStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CompensationStoreError";
  }
}

const LINK_ID = /^lnk_[0-9a-f]{16}$/;

export function compensationPath(configDir?: string): string {
  return join(linkDir(configDir), "compensation.json");
}

function cloneEmpty(): CompensationStore {
  return { version: 1, entries: {} };
}

function assertOnlyKeys(value: Record<string, unknown>, keys: readonly string[], where: string): void {
  for (const key of Object.keys(value)) {
    if (!keys.includes(key)) throw new CompensationStoreError(`${where} has an unknown field ${JSON.stringify(key)}`);
  }
}

export function parseCompensation(text: string): CompensationStore {
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { throw new CompensationStoreError("compensation.json is not valid JSON"); }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new CompensationStoreError("compensation.json is not an object");
  const body = raw as Record<string, unknown>;
  assertOnlyKeys(body, ["version", "entries"], "compensation.json");
  if (body.version !== 1 || !body.entries || typeof body.entries !== "object" || Array.isArray(body.entries)) {
    throw new CompensationStoreError("compensation.json has an invalid shape");
  }
  const entries: Record<string, CompensationEntry> = {};
  for (const [linkId, value] of Object.entries(body.entries)) {
    if (!LINK_ID.test(linkId) || !value || typeof value !== "object" || Array.isArray(value)) {
      throw new CompensationStoreError("compensation.json has an invalid entry");
    }
    const entry = value as Record<string, unknown>;
    assertOnlyKeys(entry, ["reason", "since"], `compensation.json.entries.${linkId}`);
    if (entry.reason !== "compensation_failed" || typeof entry.since !== "string" || Number.isNaN(Date.parse(entry.since))) {
      throw new CompensationStoreError("compensation.json has an invalid entry");
    }
    entries[linkId] = { reason: "compensation_failed", since: entry.since };
  }
  return { version: 1, entries };
}

/** Damaged compensation state is display-only evidence and therefore fails closed to empty. */
export function readCompensation(path: string = compensationPath()): CompensationStore {
  let text: string;
  try { text = readFileSync(path, "utf8"); } catch (error) {
    if (isMissingPathError(error)) return cloneEmpty();
    return cloneEmpty();
  }
  try { return parseCompensation(text); } catch { return cloneEmpty(); }
}

export function writeCompensation(path: string, store: CompensationStore): void {
  const normalized = parseCompensation(JSON.stringify(store));
  const dir = dirname(path);
  assertNotRealHomeUnderTest(dirname(dir));
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (process.platform === "win32") hardenSecretDir(dir, { required: true });
  else chmodSync(dir, 0o700);
  atomicWriteFile(path, `${JSON.stringify(normalized, null, 2)}\n`);
  if (process.platform !== "win32") chmodSync(path, 0o600);
}

export function markCompensationFailed(linkId: string, since: string, path: string = compensationPath()): void {
  const current = readCompensation(path);
  writeCompensation(path, {
    version: 1,
    entries: { ...current.entries, [linkId]: { reason: "compensation_failed", since } },
  });
}

export function clearCompensationFailed(linkId: string, path: string = compensationPath()): void {
  const current = readCompensation(path);
  if (!current.entries[linkId]) return;
  const entries = { ...current.entries };
  delete entries[linkId];
  writeCompensation(path, { version: 1, entries });
}
