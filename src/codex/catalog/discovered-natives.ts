import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteFile } from "../../config/atomic-write";
import { getConfigDir } from "../../config/paths";
import { assertNotRealHomeUnderTest } from "../../lib/test-home-guard";
import { isEligibleConfiguredNativeOpenAiModel, setDiscoveredNativeOpenAiModels } from "./native-models";

export const DISCOVERED_NATIVE_MAX_ROWS = 32;
/**
 * A real row carries its full base instructions twice (`base_instructions` and the
 * `model_messages` template): GPT-6.1 Sol's live row was 87,183 bytes on 2026-09-30, so a
 * 64 KiB bound silently rejected exactly the model this store exists to discover.
 */
export const DISCOVERED_NATIVE_MAX_ROW_BYTES = 256 * 1024;
export const DISCOVERED_NATIVE_MAX_FILE_BYTES = DISCOVERED_NATIVE_MAX_ROWS * (DISCOVERED_NATIVE_MAX_ROW_BYTES + 1024);
export const DISCOVERED_NATIVE_RETENTION_MS = 14 * 24 * 60 * 60 * 1000;
const FILE_NAME = "discovered-native-models.json";

export interface DiscoveredNativeModel {
  slug: string;
  row: Record<string, unknown>;
  firstSeenAt: number;
  lastSeenAt: number;
  clientVersion: string;
}

let loadedPath: string | undefined;
let models: DiscoveredNativeModel[] = [];
let fingerprint = "[]";
let generation = 0;

/** Validate untrusted roster rows without filesystem effects; keep upstream capability metadata. */
export function validateDiscoveredNativeRows(rows: unknown): Record<string, unknown>[] {
  if (!Array.isArray(rows)) return [];
  const accepted = new Map<string, Record<string, unknown>>();
  for (const candidate of rows) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue;
    const row = candidate as Record<string, unknown>;
    if (typeof row.slug !== "string" || row.slug.length > 128
      || !isEligibleConfiguredNativeOpenAiModel(row.slug)
      || row.supported_in_api !== true || row.visibility === "hide"
      || typeof row.display_name !== "string" || !row.display_name.trim()
      || !Array.isArray(row.supported_reasoning_levels)
      || row.supported_reasoning_levels.length > 16
      || !row.supported_reasoning_levels.every(level => level && typeof level === "object"
        && !Array.isArray(level) && typeof level.effort === "string" && level.effort.length > 0
        && level.effort.length <= 32 && typeof level.description === "string")) continue;
    if ([row.context_window, row.max_context_window].some(value => value !== undefined && value !== null
      && (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0))) continue;
    try {
      const serialized = JSON.stringify(row);
      if (Buffer.byteLength(serialized, "utf8") > DISCOVERED_NATIVE_MAX_ROW_BYTES) continue;
      if (accepted.size >= DISCOVERED_NATIVE_MAX_ROWS && !accepted.has(row.slug)) continue;
      accepted.set(row.slug, JSON.parse(serialized) as Record<string, unknown>);
    } catch { /* Cyclic/non-JSON rows cannot be persisted or sent to Codex. */ }
  }
  return [...accepted.values()];
}

function boundedModels(entries: DiscoveredNativeModel[], now: number): DiscoveredNativeModel[] {
  return entries.filter(entry => entry.lastSeenAt >= now - DISCOVERED_NATIVE_RETENTION_MS)
    .sort((a, b) => b.lastSeenAt - a.lastSeenAt || a.slug.localeCompare(b.slug))
    .slice(0, DISCOVERED_NATIVE_MAX_ROWS);
}

function readModels(path: string, now: number): DiscoveredNativeModel[] {
  try {
    if (statSync(path).size > DISCOVERED_NATIVE_MAX_FILE_BYTES) return [];
    const bytes = readFileSync(path, "utf8");
    if (Buffer.byteLength(bytes, "utf8") > DISCOVERED_NATIVE_MAX_FILE_BYTES) return [];
    const data = JSON.parse(bytes) as { version?: unknown; models?: unknown };
    if (data.version !== 1 || !Array.isArray(data.models) || data.models.length > DISCOVERED_NATIVE_MAX_ROWS) return [];
    const valid = new Map<string, DiscoveredNativeModel>();
    for (const entry of data.models) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
      const row = validateDiscoveredNativeRows([entry.row])[0];
      if (!row || entry.slug !== row.slug
        || !Number.isSafeInteger(entry.firstSeenAt) || entry.firstSeenAt < 0
        || !Number.isSafeInteger(entry.lastSeenAt) || entry.lastSeenAt < entry.firstSeenAt
        || entry.lastSeenAt > now
        || typeof entry.clientVersion !== "string" || entry.clientVersion.length > 64) continue;
      valid.set(entry.slug, { slug: entry.slug, row, firstSeenAt: entry.firstSeenAt,
        lastSeenAt: entry.lastSeenAt, clientVersion: entry.clientVersion });
    }
    return boundedModels([...valid.values()], now);
  } catch { return []; }
}

function publish(entries: DiscoveredNativeModel[]): void {
  models = entries;
  // Seen-at timestamps extend retention but do not invalidate an otherwise identical catalog.
  const next = JSON.stringify(entries.map(({ slug, row }) => ({ slug, row })).sort((a, b) => a.slug.localeCompare(b.slug)));
  if (next === fingerprint) return;
  fingerprint = next;
  generation += 1;
  setDiscoveredNativeOpenAiModels(entries.map(entry => entry.row));
}

/** Load on config activation; switching OpenCodex homes never carries the previous home's rows. */
export function loadDiscoveredNativeModels(now = Date.now()): void {
  const path = join(getConfigDir(), FILE_NAME);
  loadedPath = path;
  publish(readModels(path, now));
}

/** Monotonic process-local catalog evidence generation, independent of account identity. */
export function discoveredNativeModelsGeneration(): number {
  return generation;
}

/** A confirmed nonempty roster owns discovery. Optional persistence must never fail entitlement. */
export function recordDiscoveredNativeModels(rows: unknown, clientVersion: string, now = Date.now()): void {
  try {
    if (!Number.isSafeInteger(now) || now < 0 || clientVersion.length > 64) return;
    const dir = getConfigDir();
    const path = join(dir, FILE_NAME);
    if (loadedPath !== path) loadDiscoveredNativeModels(now);
    const merged = new Map(models.map(entry => [entry.slug, entry]));
    for (const row of validateDiscoveredNativeRows(rows)) {
      const slug = row.slug as string;
      const previous = merged.get(slug);
      if (previous && previous.lastSeenAt > now) continue;
      merged.set(slug, { slug, row, firstSeenAt: previous?.firstSeenAt ?? now, lastSeenAt: now, clientVersion });
    }
    const next = boundedModels([...merged.values()], now);
    const serialized = JSON.stringify({ version: 1, models: next });
    if (Buffer.byteLength(serialized, "utf8") > DISCOVERED_NATIVE_MAX_FILE_BYTES) return;
    const hadModels = models.length > 0;
    publish(next);
    // Avoid filesystem work for unchanged empty rosters (including existing entitlement fixtures).
    if (next.length === 0 && !hadModels && !existsSync(path)) return;
    assertNotRealHomeUnderTest(dir);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    atomicWriteFile(path, serialized + "\n");
  } catch { /* Discovery is optional; current in-memory metadata survives a disk write failure. */ }
}

export function resetDiscoveredNativeModelsForTests(): void {
  loadedPath = undefined;
  models = [];
  fingerprint = "[]";
  generation += 1;
  setDiscoveredNativeOpenAiModels([]);
}
