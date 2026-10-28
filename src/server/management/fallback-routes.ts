/**
 * `GET|PUT /api/fallback`: the OCX-11 fallback state (`ocx.fallback/1`) and its one scoped write.
 *
 * GET is a passive read. A Remote Link Child reaches it through the read-only link relay
 * (`LINK_MANAGEMENT_READ_PATHS`); there it drops link aliases (`buildFallbackState` passive). PUT
 * runs on the Home only: a Child's relay and CLI refuse writes before sending.
 */
import type { ManagementContext } from "./context";
import { jsonResponse } from "../auth-cors";
import { mutatePersistedConfig } from "../../config";
import { isPassiveRead } from "../../lib/passive-read";
import { readLinkStore, type LinkRecord } from "../../link/store";
import { linkStorePath } from "../../link/paths";
import { applyFallbackWrite, buildFallbackState, parseFallbackWrites } from "../../routing/fallback-state";
import { managementBodyTooLargeResponse, readManagementJsonBody } from "./body";

function links(ctx: ManagementContext): LinkRecord[] {
  try {
    return (ctx.deps.readLinkStore?.() ?? readLinkStore(linkStorePath())).links;
  } catch {
    return [];
  }
}

function view(ctx: ManagementContext): Response {
  const response = jsonResponse(buildFallbackState(ctx.config, { links: links(ctx), passive: isPassiveRead() }), 200, ctx.req, ctx.config);
  response.headers.set("cache-control", "no-store");
  return response;
}

export async function handleFallbackRoutes(ctx: ManagementContext): Promise<Response | null> {
  const { req, url, config } = ctx;
  if (url.pathname === "/api/fallback" && req.method === "GET") return view(ctx);
  if (url.pathname === "/api/fallback" && req.method === "PUT") return await writeFallback(ctx);
  return null;
}

async function writeFallback(ctx: ManagementContext): Promise<Response> {
  const { req, config } = ctx;
  let body: unknown;
  try {
    body = await readManagementJsonBody(req);
  } catch (error) {
    return managementBodyTooLargeResponse(error, req, config)
      ?? jsonResponse({ error: "invalid JSON body", code: "invalid_request" }, 400, req, config);
  }
  const parsed = parseFallbackWrites(body);
  if (!parsed.ok) return jsonResponse({ error: parsed.error, code: "invalid_request" }, 400, req, config);
  const known = links(ctx);
  for (const write of parsed.writes) {
    if (write.scope !== "device") continue;
    // A link alias names its link; otherwise the key must be a known link id or data key id.
    const byAlias = known.find(link => link.alias === write.key);
    if (byAlias) write.key = byAlias.id;
    // Clearing stays possible for a device that is gone (a revoked link, a deleted data key):
    // its entry still lists in the state, and clearing a missing entry is a no-op.
    if (write.value === null) continue;
    const exists = known.some(link => link.id === write.key)
      || (config.apiKeys ?? []).some(entry => entry.id === write.key);
    if (!exists) {
      return jsonResponse({ error: "unknown device: use a link id or alias from ocx link status, or a Hub data key id", code: "unknown_device" }, 404, req, config);
    }
  }
  const outcome = mutatePersistedConfig(persisted => {
    let changed = false;
    for (const write of parsed.writes) changed = applyFallbackWrite(persisted, write) || changed;
    return { changed, value: persisted.fallback === undefined ? undefined : structuredClone(persisted.fallback) };
  });
  if (outcome.status === "unavailable") {
    return jsonResponse({ error: "config.json is " + outcome.reason + "; fallback settings were not saved", code: "config_unavailable" }, 409, req, config);
  }
  if (outcome.value === undefined) delete config.fallback;
  else config.fallback = outcome.value;
  return view(ctx);
}
