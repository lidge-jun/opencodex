import { PARSE_FAILED, parseConfig } from "./config-io";
import { serializeDocument, UnserializableValueError } from "./serialize";

/** Private journal representation, never written into either Cline file. */
export interface ClineRawPair { settings: string | null; catalog: string | null }

export function isClineObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function encodeClinePair(pair: ClineRawPair): string | null {
  return pair.settings === null && pair.catalog === null ? null : JSON.stringify(pair);
}

export function decodeClinePair(text: string | null): ClineRawPair {
  if (text === null) return { settings: null, catalog: null };
  let value: unknown;
  try { value = JSON.parse(text); }
  catch { throw new UnserializableValueError("invalid Cline snapshot bundle"); }
  if (!isClineObject(value) || Object.keys(value).length !== 2
    || !(value.settings === null || typeof value.settings === "string")
    || !(value.catalog === null || typeof value.catalog === "string")) {
    throw new UnserializableValueError("invalid Cline snapshot bundle");
  }
  return { settings: value.settings, catalog: value.catalog };
}

function nativeDocument(value: unknown): value is Record<string, unknown> {
  return isClineObject(value) && (value.version === undefined || value.version === 1)
    && (value.providers === undefined || isClineObject(value.providers));
}

export function parseClineDocument(text: string | null): unknown | typeof PARSE_FAILED {
  try {
    const pair = decodeClinePair(text);
    const settings = parseConfig(pair.settings, "json");
    const catalog = parseConfig(pair.catalog, "json");
    if (!nativeDocument(settings) || !nativeDocument(catalog)
      || (settings.modes !== undefined && !isClineObject(settings.modes))) return PARSE_FAILED;
    return { settings, catalog };
  } catch { return PARSE_FAILED; }
}

export function serializeClineDocument(value: unknown): string {
  if (!isClineObject(value)) throw new UnserializableValueError("invalid Cline document");
  const settings = value.settings ?? {};
  const catalog = value.catalog ?? {};
  if (!nativeDocument(settings) || !nativeDocument(catalog)) {
    throw new UnserializableValueError("unsupported Cline document version or providers shape");
  }
  return JSON.stringify({
    settings: serializeDocument({ version: 1, modes: {}, providers: {}, ...settings }, "json"),
    catalog: serializeDocument({ version: 1, providers: {}, ...catalog }, "json"),
  });
}

/** Cline saves these two fields during normal model selection. Keep only a still-routed choice. */
export function preserveClineSelection(previous: unknown, next: unknown): void {
  if (!isClineObject(previous) || !isClineObject(next)) return;
  const entry = (document: Record<string, unknown>, part: string): Record<string, unknown> | undefined => {
    const root = document[part];
    const providers = isClineObject(root) ? root.providers : undefined;
    return isClineObject(providers) && isClineObject(providers.opencodex) ? providers.opencodex : undefined;
  };
  const old = entry(previous, "settings");
  const current = entry(next, "settings");
  const models = entry(next, "catalog")?.models;
  if (!current || !isClineObject(current.settings) || !old || !isClineObject(old.settings)) return;
  if (typeof old.settings.model === "string" && isClineObject(models) && Object.hasOwn(models, old.settings.model)) {
    current.settings.model = old.settings.model;
  }
  if (typeof old.updatedAt === "string") current.updatedAt = old.updatedAt;
}
