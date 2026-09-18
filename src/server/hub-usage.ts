import type { OcxConfig } from "../types";
import { MAX_HUB_USAGE_BYTES, parseHubUsage } from "../remote/hub-usage";
import { parseRange, parseUsageSurface, USAGE_RANGES, USAGE_SURFACES } from "../usage/summary";
import { parseUsageTimeWindow } from "../usage/time-range";
import { getFilteredUsageAggregate } from "./management/usage-aggregate-cache";
import { isAllowedRequestOrigin, resolveDataPlaneAdmissionSecret, withCors, type RequestPolicyView } from "./auth-cors";

/** Read only the ledger rows belonging to an explicitly authenticated configured key. */
export async function handleHubUsage(req: Request, config: OcxConfig, policy: RequestPolicyView): Promise<Response> {
  const reply = (body: unknown, status = 200) => withCors(Response.json(body, {
    status, headers: { "cache-control": "no-store" },
  }), req, policy);
  const error = (code: string, message: string, status: number) => reply({ error: { code, message } }, status);
  const token = req.headers.get("x-opencodex-api-key") ?? "";
  const admission = resolveDataPlaneAdmissionSecret(token, config);
  if (admission?.kind !== "configured") return error("hub_usage_unauthorized", "A configured client data key is required", 401);
  if (!isAllowedRequestOrigin(req, policy)) return error("origin_rejected", "Cross-origin request blocked", 403);
  if (config.runtimeRole !== "hub") return error("hub_usage_not_a_hub", "Usage is served here only by a hub", 404);
  const keyId = admission.keyId;
  // The existing aggregate filter trims IDs. Never let that normalization turn
  // this authenticated identity into another configured key (or no filter).
  if (!keyId || keyId.trim() !== keyId) return error("hub_usage_key_id_invalid", "Client key identity needs repair on the hub", 403);
  const query = new URL(req.url).searchParams;
  const allowed = new Set(["range", "surface", "provider", "model", "since", "until"]);
  for (const key of query.keys()) {
    if (!allowed.has(key) || query.getAll(key).length !== 1) return error("hub_usage_query_invalid", "Unknown or repeated usage option", 400);
  }
  const rangeInput = query.get("range") ?? "30d";
  const surfaceInput = query.get("surface") ?? "all";
  if (!(rangeInput === "1d" || (USAGE_RANGES as readonly string[]).includes(rangeInput))
    || !(USAGE_SURFACES as readonly string[]).includes(surfaceInput)) {
    return error("hub_usage_query_invalid", "Invalid usage range or surface", 400);
  }
  let window;
  try { window = parseUsageTimeWindow(query.get("since"), query.get("until")); }
  catch { return error("hub_usage_query_invalid", "Invalid usage time window", 400); }
  try {
    const aggregate = await getFilteredUsageAggregate({
      apiKeyId: keyId, provider: query.get("provider"), model: query.get("model"),
    }, window);
    const current = resolveDataPlaneAdmissionSecret(token, config);
    if (current?.kind !== "configured" || current.keyId !== keyId) {
      return error("hub_usage_unauthorized", "The client key changed during the read", 401);
    }
    const summary = aggregate.accumulator.summarize(parseRange(rangeInput), Date.now(), parseUsageSurface(surfaceInput));
    const body = parseHubUsage({ ...summary, schemaVersion: 1, source: "hub", scope: "client",
      ...(aggregate.usageIncomplete ? { usageIncomplete: true, usageIncompleteReason: "oversized_rows" } : {}),
    });
    if (!body) return error("hub_usage_unavailable", "Usage could not be represented; narrow the requested range", 503);
    if (Buffer.byteLength(JSON.stringify(body), "utf8") > MAX_HUB_USAGE_BYTES) {
      return error("hub_usage_too_large", "Usage exceeds the response bound; narrow the requested range", 507);
    }
    return reply(body);
  } catch {
    return error("hub_usage_read_failed", "Hub usage could not be read", 503);
  }
}
