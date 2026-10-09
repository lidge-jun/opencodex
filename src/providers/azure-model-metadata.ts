import { readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteFile } from "../config/atomic-write";
import { getConfigDir } from "../config/paths";
import { readBoundedResponseBytes } from "../lib/bounded-body";

const SOURCE_URL = "https://models.dev/api.json";
const FILENAME = "azure-model-metadata-cache.json";
const TTL_MS = 24 * 60 * 60 * 1000;

export type AzureModelMetadata = { input?: string[]; contextWindow?: number; maxTokens?: number };
type Snapshot = { version: 1; fetchedAt: number; models: Record<string, AzureModelMetadata> };
type CacheState = { snapshot?: Snapshot | null; inFlight?: Promise<void>; retryAfter: number };
const cacheByConfigDir = new Map<string, CacheState>();

function cacheState(configDir: string): CacheState {
  let state = cacheByConfigDir.get(configDir);
  if (!state) {
    state = { retryAfter: 0 };
    cacheByConfigDir.set(configDir, state);
  }
  return state;
}

export function isAzureModelMetadataDestination(baseUrl: string | undefined): boolean {
  try {
    return !!baseUrl && new URL(baseUrl).hostname.endsWith(".openai.azure.com");
  } catch {
    return false;
  }
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

function parseModels(models: unknown, published: boolean): Record<string, AzureModelMetadata> {
  const out: Record<string, AzureModelMetadata> = Object.create(null);
  for (const [id, value] of Object.entries(record(models) ?? {}).slice(0, 2000)) {
    const row = record(value);
    if (!row || id.length > 256) continue;
    const limit = published ? record(row.limit) : row;
    const input = published ? record(row.modalities)?.input : row.input;
    const modalities = Array.isArray(input)
      ? [...new Set(input.filter((item): item is string => item === "text" || item === "image" || item === "audio"))]
      : [];
    const contextWindow = positiveInteger(published ? limit?.context : limit?.contextWindow);
    const maxTokens = positiveInteger(published ? limit?.output : limit?.maxTokens);
    if (!modalities.length && contextWindow === undefined && maxTokens === undefined) continue;
    out[id.toLowerCase()] = {
      ...(modalities.length ? { input: modalities } : {}),
      ...(contextWindow !== undefined ? { contextWindow } : {}),
      ...(maxTokens !== undefined ? { maxTokens } : {}),
    };
  }
  return out;
}

function loadSnapshot(configDir: string, state: CacheState): Snapshot | null {
  if (state.snapshot !== undefined) return state.snapshot;
  state.snapshot = null;
  try {
    const raw = record(JSON.parse(readFileSync(join(configDir, FILENAME), "utf8")));
    if (raw?.version === 1 && positiveInteger(raw.fetchedAt) !== undefined && record(raw.models)) {
      state.snapshot = { version: 1, fetchedAt: raw.fetchedAt as number, models: parseModels(raw.models, false) };
    }
  } catch { /* Missing or corrupt optional metadata leaves bundled hints available. */ }
  return state.snapshot;
}

/** Synchronous catalog fallback. Generation requests never fetch this snapshot. */
export function publishedAzureModelMetadata(modelId: string, configDir = getConfigDir()): AzureModelMetadata | undefined {
  return loadSnapshot(configDir, cacheState(configDir))?.models[modelId.toLowerCase()];
}

/** Refresh once per day during discovery, coalesced and bounded; retain stale data offline. */
export async function refreshAzureModelMetadata(baseUrl: string | undefined, configDir = getConfigDir()): Promise<void> {
  if (!isAzureModelMetadataDestination(baseUrl)) return;
  // Capture state and destination together: tests and embedders can change config roots.
  const state = cacheState(configDir);
  const current = loadSnapshot(configDir, state);
  if ((current && Date.now() - current.fetchedAt < TTL_MS) || Date.now() < state.retryAfter) return;
  if (state.inFlight) return state.inFlight;
  const path = join(configDir, FILENAME);
  state.inFlight = (async () => {
    try {
      const signal = AbortSignal.timeout(2000);
      const response = await fetch(SOURCE_URL, {
        headers: { accept: "application/json" },
        redirect: "error",
        signal,
      });
      if (!response.ok) return;
      const body = await readBoundedResponseBytes(response, { maxBytes: 16 * 1024 * 1024, signal });
      if (body.oversized) return;
      const raw = record(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body.bytes)));
      // Provider-specific rows matter: Azure may expose text only where the direct vendor has vision.
      const models = parseModels(record(raw?.azure)?.models, true);
      if (!Object.keys(models).length) return;
      state.snapshot = { version: 1, fetchedAt: Date.now(), models };
      try { atomicWriteFile(path, JSON.stringify(state.snapshot) + "\n"); } catch { /* Memory still serves discovery. */ }
    } catch { /* A public metadata outage must not fail provider discovery. */ }
    finally { state.retryAfter = Date.now() + 60_000; }
  })().finally(() => { state.inFlight = undefined; });
  return state.inFlight;
}

export function resetAzureModelMetadataForTests(): void {
  cacheByConfigDir.clear();
}
