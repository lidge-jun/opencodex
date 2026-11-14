/**
 * Read-only live meter: generation speed, cache hit and context fill of the newest completed
 * request, overall and per client family, served on the data-plane route `GET /v1/usage/live`.
 * It is admitted like the proxy's own model requests, so the Codex desktop renderer (Codex++
 * userscript) can read it without the admin token. The projection is `src/usage/live-meter.ts`.
 *
 * The body carries numbers, model and provider names and reason codes only. A `conversation`
 * filter narrows the rows but is never echoed, and neither is any stored conversation digest.
 */
import { readCatalog, readCodexCatalogPath } from "../codex/catalog";
import { liveMeterFromEntry, selectLiveMeterEntries, type LiveMeter, type MeterClientFamily } from "../usage/live-meter";
import {
  corsHeaders, isAllowedRequestOrigin, isApiAuthRequired, isLoopbackRequestHost, resolveApiAuth, withCors,
  type DataPlaneAdmission, type RequestPolicyView,
} from "./auth-cors";
import { formatErrorResponse } from "../bridge/errors";
import { matchesLogConversationId } from "./request-log-conversation";
import { getRequestLogEntries, type RequestLogEntry } from "./request-log";
import { statSync } from "node:fs";

/** The Codex desktop renderer's page origin; it may read this one route and nothing else. */
export const LIVE_METER_APP_ORIGIN = "app://-";

export interface LiveMeterBody {
  latest: LiveMeter | null;
  byClient: Partial<Record<MeterClientFamily, LiveMeter>>;
  generatedAt: number;
}

export interface LiveMeterDeps {
  entries?: () => readonly RequestLogEntry[];
  contextLimit?: (model: string) => number | null;
  now?: () => number;
}

const FAMILIES: readonly MeterClientFamily[] = ["codex", "claude", "other"];

let catalogCache: { path: string; mtimeMs: number; size: number; limits: Map<string, number> } | null = null;

/** Window of the model as the persisted Codex catalog states it, re-read only when the file changes. */
export function catalogContextLimit(model: string, catalogPath: string = readCodexCatalogPath()): number | null {
  let stat;
  try { stat = statSync(catalogPath); } catch { return null; }
  if (!catalogCache || catalogCache.path !== catalogPath || catalogCache.mtimeMs !== stat.mtimeMs || catalogCache.size !== stat.size) {
    const limits = new Map<string, number>();
    for (const row of readCatalog(catalogPath)?.models ?? []) {
      const window = row.context_window;
      if (typeof row.slug === "string" && typeof window === "number" && Number.isFinite(window) && window > 0) {
        limits.set(row.slug, window);
      }
    }
    catalogCache = { path: catalogPath, mtimeMs: stat.mtimeMs, size: stat.size, limits };
  }
  return catalogCache.limits.get(model) ?? null;
}

export function resetLiveMeterCatalogCacheForTests(): void { catalogCache = null; }

export type LiveMeterResult = { status: 200; body: LiveMeterBody } | { status: 400; code: string; message: string };

/**
 * Rows the caller may see. A configured data key sees only the requests it sent, like `/v1/usage`
 * (hub-usage.ts), so rows of other keys and keyless rows stay hidden from it. Loopback and the
 * environment token are the operator and see every row.
 */
export function liveMeterRowVisible(admission: DataPlaneAdmission | undefined): (entry: RequestLogEntry) => boolean {
  if (admission?.kind !== "configured") return () => true;
  const keyId = admission.keyId;
  return entry => entry.apiKeyId === keyId;
}

export function buildLiveMeter(params: URLSearchParams, deps: LiveMeterDeps = {}, admission?: DataPlaneAdmission): LiveMeterResult {
  const bad = (message: string): LiveMeterResult => ({ status: 400, code: "live_meter_query_invalid", message });
  for (const key of params.keys()) {
    if ((key !== "client" && key !== "conversation") || params.getAll(key).length !== 1) return bad("Unknown or repeated option");
  }
  const client = params.get("client");
  if (client !== null && !(FAMILIES as readonly string[]).includes(client)) return bad("client must be codex, claude or other");
  const conversation = params.get("conversation");
  if (conversation !== null && !conversation.trim()) return bad("conversation must not be empty");
  const limitOf = deps.contextLimit ?? ((model: string) => catalogContextLimit(model));
  const visible = liveMeterRowVisible(admission);
  const selection = selectLiveMeterEntries(
    (deps.entries ?? getRequestLogEntries)(),
    conversation === null ? visible : entry => visible(entry) && matchesLogConversationId(entry.conversationId, conversation),
  );
  const project = (entry: RequestLogEntry): LiveMeter => liveMeterFromEntry(entry, entry.model ? limitOf(entry.model) : null);
  const byClient: LiveMeterBody["byClient"] = {};
  for (const family of FAMILIES) {
    const entry = selection.byFamily[family];
    if (entry) byClient[family] = project(entry);
  }
  const filtered = client === null ? selection.overall : selection.byFamily[client as MeterClientFamily] ?? null;
  return { status: 200, body: {
    latest: filtered ? project(filtered) : null,
    byClient: client === null ? byClient : (byClient[client as MeterClientFamily] ? { [client]: byClient[client as MeterClientFamily] } : {}),
    generatedAt: (deps.now ?? Date.now)(),
  } };
}

export function liveMeterResponse(params: URLSearchParams, deps?: LiveMeterDeps, admission?: DataPlaneAdmission): Response {
  const result = buildLiveMeter(params, deps, admission);
  const headers = { "cache-control": "no-store" };
  return result.status === 200
    ? Response.json(result.body, { headers })
    : Response.json({ error: { type: "invalid_request_error", code: result.code, message: result.message } }, { status: 400, headers });
}

/** `GET /v1/usage/live`: same admission as the proxy's model requests; never the admin token. */
export async function handleLiveMeterData(req: Request, config: RequestPolicyView, deps?: LiveMeterDeps): Promise<Response> {
  const appRenderer = req.headers.get("Origin") === LIVE_METER_APP_ORIGIN;
  const reply = (response: Response, admittedOrigin = false): Response => {
    const out = withCors(response, req, config);
    if (admittedOrigin) out.headers.set("Access-Control-Allow-Origin", LIVE_METER_APP_ORIGIN);
    return out;
  };
  const admission = resolveApiAuth(req, config);
  if (!admission) return reply(formatErrorResponse(401, "authentication_error", "opencodex API key required"));
  // The renderer is not loopback-by-origin; the loopback Host gate still binds it when no key is required.
  const originOk = appRenderer
    ? isApiAuthRequired(config) || isLoopbackRequestHost(req.headers.get("Host"))
    : isAllowedRequestOrigin(req, config);
  if (!originOk) return reply(formatErrorResponse(403, "origin_rejected", "cross-origin data-plane request blocked"));
  return reply(liveMeterResponse(new URL(req.url).searchParams, deps, admission), appRenderer);
}

/**
 * Preflight for the renderer's cross-origin read of `/v1/usage/live` (a key header makes it non-simple).
 * `null` for every other origin, so the data-plane preflight policy is untouched.
 */
export function liveMeterPreflight(req: Request, config: RequestPolicyView): Response | null {
  if (req.headers.get("Origin") !== LIVE_METER_APP_ORIGIN) return null;
  if (!isApiAuthRequired(config) && !isLoopbackRequestHost(req.headers.get("Host"))) return null;
  const headers = corsHeaders(req, config);
  headers["Access-Control-Allow-Origin"] = LIVE_METER_APP_ORIGIN;
  headers["Access-Control-Allow-Methods"] = "GET, OPTIONS";
  return new Response(null, { status: 204, headers });
}
