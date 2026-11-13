/**
 * `GET|PUT /api/combo-suggestions`: the providers left out of the Combos page's suggested
 * combos (`comboSuggestionExcludedProviders`). Suggestions are computed in the dashboard; this
 * only persists the exclusion list in config.json so it follows the operator across browsers.
 * It never touches routing: a combo that already names an excluded provider keeps it.
 */
import type { ManagementContext } from "./context";
import { jsonResponse } from "../auth-cors";
import { mutatePersistedConfig } from "../../config";
import { managementBodyTooLargeResponse, readManagementJsonBody } from "./body";
import { isPlainRecord } from "./shared";

const MAX_PROVIDERS = 256;
const MAX_NAME_LENGTH = 256;

/** Trimmed, deduplicated, in the order given; null when the value is not a list of names. */
export function parseExcludedProviders(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length > MAX_PROVIDERS) return null;
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") return null;
    const name = entry.trim();
    if (!name || name.length > MAX_NAME_LENGTH) return null;
    if (!out.includes(name)) out.push(name);
  }
  return out;
}

function view(ctx: ManagementContext): Response {
  const response = jsonResponse({ excludedProviders: ctx.config.comboSuggestionExcludedProviders ?? [] }, 200, ctx.req, ctx.config);
  response.headers.set("cache-control", "no-store");
  return response;
}

export async function handleComboSuggestionRoutes(ctx: ManagementContext): Promise<Response | null> {
  const { req, url } = ctx;
  if (url.pathname === "/api/combo-suggestions" && req.method === "GET") return view(ctx);
  if (url.pathname === "/api/combo-suggestions" && req.method === "PUT") return await writeExcluded(ctx);
  return null;
}

async function writeExcluded(ctx: ManagementContext): Promise<Response> {
  const { req, config } = ctx;
  let body: unknown;
  try {
    body = await readManagementJsonBody(req);
  } catch (error) {
    return managementBodyTooLargeResponse(error, req, config)
      ?? jsonResponse({ error: "invalid JSON body", code: "invalid_request" }, 400, req, config);
  }
  const excluded = isPlainRecord(body) && Object.keys(body).every(key => key === "excludedProviders")
    ? parseExcludedProviders(body.excludedProviders)
    : null;
  if (!excluded) {
    return jsonResponse({ error: "excludedProviders must be a list of provider names", code: "invalid_request" }, 400, req, config);
  }
  const outcome = mutatePersistedConfig(persisted => {
    const before = JSON.stringify(persisted.comboSuggestionExcludedProviders ?? []);
    if (excluded.length === 0) delete persisted.comboSuggestionExcludedProviders;
    else persisted.comboSuggestionExcludedProviders = excluded;
    return { changed: before !== JSON.stringify(excluded), value: excluded };
  });
  if (outcome.status === "unavailable") {
    return jsonResponse({ error: `config.json is ${outcome.reason}; excluded providers were not saved`, code: "config_unavailable" }, 409, req, config);
  }
  if (excluded.length === 0) delete config.comboSuggestionExcludedProviders;
  else config.comboSuggestionExcludedProviders = excluded;
  return view(ctx);
}
