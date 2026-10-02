/**
 * Claude Desktop picker mode: narrowly rewrite the Code bootstrap catalog.
 * A failed or inapplicable transform leaves the upstream bytes untouched.
 */
import { brotliDecompressSync, gunzipSync, inflateSync } from "node:zlib";
import { PICKER_MAX_OUTPUT_BYTES, PickerRewriteBudget, pickerRowBytes } from "./picker-budget";

/** One opencodex model offered in Desktop's Code-tab picker. */
export interface PickerModelEntry {
  id: string;
  name: string;
  contextWindow?: number;
  /** Row description; Desktop entries never carry one, so their rows keep the stripped template. */
  description?: string;
  /** The route an alias was minted for (CLI rows), so a later registry rebuild can be re-checked. */
  route?: string;
}

export const BOOTSTRAP_MAX_ENCODED_BYTES = 4 * 1024 * 1024;
export const BOOTSTRAP_MAX_DECODED_BYTES = PICKER_MAX_OUTPUT_BYTES;
const BOOTSTRAP_PATH = /^\/(?:edge-api|api)\/bootstrap(?:\/[A-Za-z0-9-]+\/app_start)?\/?$/;
const REWRITE_REMOVED_HEADERS = new Set([
  "content-encoding", "content-length", "etag", "digest", "content-md5", "transfer-encoding",
]);

export function isPickerBootstrapRequest(method: string, pathname: string): boolean {
  return method === "GET" && BOOTSTRAP_PATH.test(pathname);
}

export function narrowBootstrapAcceptEncoding(): string {
  return "gzip, deflate, br";
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

/** Why a bootstrap was left unchanged, for the metadata-only picker log. Never carries values. */
export type PickerInjectionOutcome =
  | { kind: "rewritten"; added: number }
  | { kind: "unchanged"; reason: string };

/**
 * Surfaces whose picker the local Desktop Code tab can show. Desktop reads "ccd" and falls back to
 * "code" only when "ccd" carries no catalog; "ccr" (remote sessions) is left alone because a
 * remote session never reaches this machine's proxy, so an opencodex route could not run there.
 */
export const PICKER_SURFACE_IDS = ["ccd", "code"] as const;
/** Surface names the log may print; anything else from the body is counted, never echoed. */
const KNOWN_SURFACE_IDS = new Set(["ccd", "code", "cc", "ccr", "cowork", "chat", "design"]);
const TEMPLATE_STRIPPED_KEYS = ["disabled", "disabled_reason", "badge", "tooltip", "description", "fast_mode"];

/** Which surfaces to rewrite and which extra template keys to drop; the defaults are Desktop's. */
export interface PickerInjectionOptions {
  surfaces?: readonly string[];
  extraStrippedKeys?: readonly string[];
}

interface SurfaceInjection { entries: unknown[]; additions: Record<string, unknown>[] }

function planSurfaceInjection(
  surface: Record<string, unknown>,
  models: readonly PickerModelEntry[],
  stripped: readonly string[],
  budget: PickerRewriteBudget,
): SurfaceInjection | string {
  if (!Array.isArray(surface.models)) return "no_models";
  const entries = surface.models as unknown[];
  const template = entries.map(record).find(entry =>
    typeof entry?.id === "string" && entry.id.startsWith("claude-")
    && !entry.disabled && !entry.disabled_reason && entry.section !== "deprecated");
  if (!template) return `no_template(models=${entries.length})`;
  const existing = new Set(entries.map(record).map(entry => entry?.id));
  // Strip by shallow projection before measuring or cloning retained metadata. Native rows stay intact.
  const retained = { ...template };
  for (const key of Object.keys(retained)) {
    if (stripped.includes(key) || /version/i.test(key)
      || ["id", "name", "section", "context_window"].includes(key)) delete retained[key];
  }
  pickerRowBytes(retained);
  const additions: Record<string, unknown>[] = [];
  for (const model of models) {
    if (existing.has(model.id)) continue;
    const copy = { ...retained };
    copy.id = model.id;
    copy.name = model.name;
    copy.section = "main";
    if (model.contextWindow === undefined) delete copy.context_window;
    else copy.context_window = model.contextWindow;
    if (model.description !== undefined) copy.description = model.description;
    budget.reserveRow(copy);
    additions.push(copy);
    existing.add(model.id);
  }
  return { entries, additions };
}

export function injectPickerModels(
  bootstrap: unknown,
  models: readonly PickerModelEntry[],
  explain?: (outcome: PickerInjectionOutcome) => void,
  options: PickerInjectionOptions = {},
): number {
  const unchanged = (reason: string): number => { explain?.({ kind: "unchanged", reason }); return 0; };
  const surfaces = record(bootstrap)?.model_selector_config;
  if (!Array.isArray(surfaces)) return unchanged("no_model_selector_config");
  const rows = surfaces.map(record);
  const surfaceIds: readonly unknown[] = options.surfaces ?? PICKER_SURFACE_IDS;
  const stripped = [...TEMPLATE_STRIPPED_KEYS, ...(options.extraStrippedKeys ?? [])];
  const targets = rows.filter((entry): entry is Record<string, unknown> =>
    entry !== null && surfaceIds.includes(entry.id));
  if (targets.length === 0) {
    // Only known surface names reach the log; any other body-derived value is counted.
    const known = rows.flatMap(entry => typeof entry?.id === "string" && KNOWN_SURFACE_IDS.has(entry.id) ? [entry.id] : []);
    const other = rows.length - known.length;
    return unchanged(`no_code_surface(${[...known, ...(other > 0 ? [`other:${other}`] : [])].join(",")})`);
  }
  let added = 0;
  const skipped: string[] = [];
  try {
    const budget = new PickerRewriteBudget(bootstrap);
    const plans: SurfaceInjection[] = [];
    for (const surface of targets) {
      const result = planSurfaceInjection(surface, models, stripped, budget);
      if (typeof result === "string") skipped.push(`${String(surface.id)}:${result}`);
      else { plans.push(result); added += result.additions.length; }
    }
    // All surfaces must fit before any deep clone or mutation; a refusal cannot publish a partial list.
    const copies = plans.map(plan => plan.additions.map(row => structuredClone(row)));
    for (let i = 0; i < plans.length; i++) {
      for (const row of copies[i]!) plans[i]!.entries.push(row);
    }
  } catch {
    return unchanged("rewrite_limit");
  }
  if (added === 0) return unchanged(skipped.length > 0 ? skipped.join(";") : models.length === 0 ? "no_routes" : "all_present");
  explain?.({ kind: "rewritten", added });
  return added;
}

export function rewriteBootstrapBody(
  encoded: Buffer,
  contentEncoding: string | undefined,
  models: readonly PickerModelEntry[],
  explain?: (outcome: PickerInjectionOutcome) => void,
): Buffer | null {
  const unchanged = (reason: string): null => { explain?.({ kind: "unchanged", reason }); return null; };
  if (encoded.length > BOOTSTRAP_MAX_ENCODED_BYTES) return unchanged("encoded_cap");
  const encoding = contentEncoding?.trim().toLowerCase() || "identity";
  let decoded: Buffer;
  try {
    switch (encoding) {
      case "identity": decoded = encoded; break;
      case "gzip":
      case "x-gzip": decoded = gunzipSync(encoded, { maxOutputLength: BOOTSTRAP_MAX_DECODED_BYTES }); break;
      case "deflate": decoded = inflateSync(encoded, { maxOutputLength: BOOTSTRAP_MAX_DECODED_BYTES }); break;
      case "br": decoded = brotliDecompressSync(encoded, { maxOutputLength: BOOTSTRAP_MAX_DECODED_BYTES }); break;
      default: return unchanged("unsupported_encoding");
    }
    if (decoded.length > BOOTSTRAP_MAX_DECODED_BYTES) return unchanged("decoded_cap");
    const parsed: unknown = JSON.parse(decoded.toString("utf8"));
    if (injectPickerModels(parsed, models, explain) === 0) return null;
    const text = JSON.stringify(parsed);
    if (Buffer.byteLength(text) > BOOTSTRAP_MAX_DECODED_BYTES) return unchanged("rewrite_limit");
    return Buffer.from(text, "utf8");
  } catch {
    return unchanged("decode_or_parse_failed");
  }
}

/** Rewritten payloads are identity encoded, so stale validators and sizes must go. */
export function rewrittenHeaders(raw: readonly string[], bodyLength: number): string[] {
  const result: string[] = [];
  for (let i = 0; i + 1 < raw.length; i += 2) {
    if (!REWRITE_REMOVED_HEADERS.has(raw[i]!.toLowerCase())) result.push(raw[i]!, raw[i + 1]!);
  }
  result.push("Content-Length", String(bodyLength));
  return result;
}
