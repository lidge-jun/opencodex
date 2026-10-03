/**
 * Claude Code CLI first-party picker: rewrite the catalogs the standalone CLI builds `/model` from.
 *
 * A first-party `claude` reads its picker from `GET /api/organizations/<org>/model_selector/cc` (or
 * `/api/model_selector/cc` without an org scope): the same row shape as Desktop's bootstrap, on the
 * `cc` surface. When that served catalog is off, the CLI falls back to its compiled list plus
 * `additional_model_options` from `GET /api/claude_cli/bootstrap`. Both arrive on the intercepted
 * api.anthropic.com tunnel; this module decides which may be rewritten and merges opencodex rows in.
 * Every failure returns the upstream bytes unchanged.
 *
 * The CLI only offers Claude-shaped ids (an `ocx-claude-*` row renders "Update Claude Code"), so the
 * rows carry Desktop 3P registry aliases; `buildCliPickerModels` in picker-models.ts chooses them.
 * Import-light on purpose: the TLS listener loads this file.
 */
import { readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { ClaudeFirstPartyDesired } from "../first-party-settings";
import { classifyInterceptClient } from "./client-class";
import { BOOTSTRAP_MAX_DECODED_BYTES, injectPickerModels, type PickerModelEntry } from "./picker-bootstrap";
import { PickerRewriteBudget } from "./picker-budget";

export type CliCatalogKind = "model_selector" | "bootstrap";

/** The CLI's own picker surface. Desktop's `ccd`/`code` surfaces belong to picker mode. */
export const CLI_PICKER_SURFACE_IDS = ["cc"] as const;
/** Template notices describe the Anthropic model a row was cloned from, never the routed one. */
const CLI_EXTRA_STRIPPED_KEYS = ["notice", "selection_notice"] as const;
const MODEL_SELECTOR_PATH = /^\/api\/(?:organizations\/[^/]+\/)?model_selector\/cc\/?$/;
const BOOTSTRAP_PATH = /^\/api\/claude_cli\/bootstrap\/?$/;
const REWRITE_DROPPED_HEADERS = ["content-length", "content-encoding", "etag", "digest", "content-md5", "transfer-encoding"];

export function cliCatalogKind(method: string, pathname: string): CliCatalogKind | null {
  if (method !== "GET") return null;
  if (MODEL_SELECTOR_PATH.test(pathname)) return "model_selector";
  if (BOOTSTRAP_PATH.test(pathname)) return "bootstrap";
  return null;
}

/**
 * Whether this request's catalog may carry opencodex rows. The cc catalog is cached on disk and
 * shared by every Claude Code process, so only a CLI-classified client with CLI first-party on gets
 * rows (a Desktop-spawned process would otherwise seed rows a plain `claude` cannot route). The
 * bootstrap request carries a bare `claude-code/<v>` User-Agent with no entrypoint, so it follows
 * CLI intent alone. Like the Messages split, the User-Agent is a routing hint, not a trust boundary.
 */
export function cliCatalogEligible(kind: CliCatalogKind, userAgent: string | null, desired: ClaudeFirstPartyDesired): boolean {
  if (!desired.cli) return false;
  if (kind === "bootstrap") return true;
  return classifyInterceptClient(userAgent) === "cli";
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

/** Append rows to `additional_model_options` (`{model, name, description}`), skipping ids already present. */
export function injectCliBootstrapOptions(bootstrap: unknown, models: readonly PickerModelEntry[]): number {
  const body = record(bootstrap);
  if (!body) return 0;
  const current = body.additional_model_options;
  if (current !== undefined && current !== null && !Array.isArray(current)) return 0;
  const options = Array.isArray(current) ? current : [];
  const existing = new Set(options.map(option => record(option)?.model));
  const additions: Record<string, unknown>[] = [];
  try {
    const budget = new PickerRewriteBudget(body);
    // A missing/null property needs a key and array, plus a possible separator (conservative).
    if (!Array.isArray(current)) budget.reserveBytes(32);
    for (const model of models) {
      if (existing.has(model.id)) continue;
      const row = { model: model.id, name: model.name, description: model.description ?? "" };
      budget.reserveRow(row);
      additions.push(row);
      existing.add(model.id);
    }
  } catch { return 0; } // Fail open without mutating the original options.
  for (const row of additions) options.push(row);
  if (additions.length > 0) body.additional_model_options = options;
  return additions.length;
}

/** Rewrite a decoded catalog body; `null` when nothing was added or the body is not the expected shape. */
export function rewriteCliCatalogBody(kind: CliCatalogKind, text: string, models: readonly PickerModelEntry[]): string | null {
  if (models.length === 0 || Buffer.byteLength(text) > BOOTSTRAP_MAX_DECODED_BYTES) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    const added = kind === "bootstrap"
      ? injectCliBootstrapOptions(parsed, models)
      : injectPickerModels(parsed, models, undefined, { surfaces: CLI_PICKER_SURFACE_IDS, extraStrippedKeys: CLI_EXTRA_STRIPPED_KEYS });
    if (added === 0) return null;
    const rewritten = JSON.stringify(parsed);
    return Buffer.byteLength(rewritten) <= BOOTSTRAP_MAX_DECODED_BYTES ? rewritten : null;
  } catch { return null; }
}

/** Read at most `cap` bytes; null (and the stream cancelled) once the body would exceed it. */
async function readCapped(body: ReadableStream<Uint8Array>, cap: number): Promise<Uint8Array<ArrayBuffer> | null> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > cap) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

/**
 * Rewrite a relayed catalog response. Only a 2xx JSON body under the decoded cap is touched; the
 * relay already decoded any content-encoding (and dropped content-length), so the cap is enforced
 * while streaming; an oversized catalog is answered with a gateway error rather than buffered.
 */
export async function rewriteCliCatalogResponse(
  response: Response,
  kind: CliCatalogKind,
  models: readonly PickerModelEntry[],
): Promise<Response> {
  if (response.status < 200 || response.status >= 300 || models.length === 0) return response;
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > BOOTSTRAP_MAX_DECODED_BYTES) return response;
  if (!response.body) return response;
  const bytes = await readCapped(response.body, BOOTSTRAP_MAX_DECODED_BYTES);
  if (bytes === null) {
    return Response.json({ type: "error", error: { type: "api_error", message: "model catalog exceeded the intercept size cap" } }, { status: 502 });
  }
  const original = (): Response => new Response(bytes, { status: response.status, statusText: response.statusText, headers: response.headers });
  const rewritten = rewriteCliCatalogBody(kind, new TextDecoder().decode(bytes), models);
  if (rewritten === null) return original();
  const headers = new Headers(response.headers);
  for (const name of REWRITE_DROPPED_HEADERS) headers.delete(name);
  headers.set("content-type", "application/json");
  return new Response(rewritten, { status: response.status, statusText: response.statusText, headers });
}

/**
 * Drop the CLI's cached served catalogs (`<claudeConfigDir>/cache/model-catalog/*-cc.json`). The CLI
 * trusts a fresh copy for about an hour without refetching, so after first-party turns on or off the
 * next launch would otherwise keep the previous list — opencodex rows that now go to Anthropic, or
 * no rows at all. Desktop's `*-ccd.json` and failure markers are left alone. Best effort; returns the
 * number of files removed.
 */
export function invalidateClaudeCodeServedCatalog(claudeDir: string): number {
  const dir = join(claudeDir, "cache", "model-catalog");
  let names: string[];
  try { names = readdirSync(dir); } catch { return 0; } // no-excuse-ok: catch -- no cache directory means nothing to drop.
  let removed = 0;
  for (const name of names) {
    if (!name.endsWith("-cc.json")) continue;
    try { unlinkSync(join(dir, name)); removed++; } catch { /* A concurrent writer or removal wins; the next reconcile retries. */ }
  }
  return removed;
}
