import type { OcxConfig } from "../../types";
import { routeIntentDigest, ROUTE_INTENT_DIGEST_PATTERN } from "../../link/route-intent";
import { homeRouteIntentWatch, ROUTE_INTENT_AFTER_HEADER, ROUTE_INTENT_WAKE_HEADER, ROUTE_INTENT_WATCH_HEADER } from "../../link/route-intent-watch";
import { projectChildRouteIntent } from "../../routing/home-route-intent";
import { linkStorePath } from "../../link/paths";
import { readLinkStore } from "../../link/store";

function refused(status: number, error: string): Response {
  return Response.json({ error }, { status, headers: { "cache-control": "no-store" } });
}
/**
 * Called only after the shared exact GET/no-query/no-upgrade gate. `readmit` repeats the
 * listener's key admission against current policy and returns the key id it admits now.
 */
export async function readLinkRouteIntent(req: Request, config: OcxConfig, version: string, admittedKeyId?: string,
  readmit?: () => string | undefined): Promise<Response> {
  if (!admittedKeyId) return refused(403, "link_key_required");
  const watch = req.headers.get(ROUTE_INTENT_WATCH_HEADER);
  const after = req.headers.get(ROUTE_INTENT_AFTER_HEADER);
  if ((watch !== null && watch !== "1") || (after !== null && (watch !== "1" || !ROUTE_INTENT_DIGEST_PATTERN.test(after)))) {
    return refused(400, "invalid_route_intent_watch");
  }
  try {
    const ownedLink = () => {
      const links = readLinkStore(linkStorePath()).links.filter(link => link.apiKeyId === admittedKeyId);
      return links.length === 1 ? links[0]!.id : null;
    };
    const linkId = ownedLink();
    if (!linkId) return refused(403, "link_mismatch");
    const project = () => projectChildRouteIntent(config, version, linkId);
    let document = project();
    let wakeReason: "changed" | "notified" | "timeout" = "changed";
    if (watch === "1" && after === routeIntentDigest(document)) {
      const wake = await homeRouteIntentWatch.wait(linkId, req.signal);
      if (wake === "cancelled") return refused(499, "route_intent_watch_cancelled");
      if (wake === "busy") return refused(429, "route_intent_watch_busy");
      wakeReason = wake;
      // Trust, the key itself and effective policy can all have changed during the wait.
      if (readmit && readmit() !== admittedKeyId) return refused(403, "link_key_required");
      if (ownedLink() !== linkId) return refused(403, "link_mismatch");
      document = project();
    }
    if (req.signal.aborted) return refused(499, "route_intent_watch_cancelled");
    return Response.json(document, { headers: { "cache-control": "no-store", [ROUTE_INTENT_WATCH_HEADER]: "1",
      ...(watch === "1" ? { [ROUTE_INTENT_WAKE_HEADER]: wakeReason } : {}) } });
  } catch { return refused(503, "route_intent_unavailable"); }
}
