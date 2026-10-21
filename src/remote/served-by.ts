/**
 * The served-by response header, the Home instance id it carries, and whether this build sends it.
 *
 * Every `GET /v1/models` response the server answers itself names the serving Home in
 * `x-opencodex-served-by`, and `GET /healthz` publishes the same value as `instanceId`, so a peer
 * (GOAT's parity check P4) can prove which Home answered without reading logs. A Remote Link Child
 * never answers `/v1/models` itself: its relay copies the Home's response headers, so the value a
 * Child returns is the Home's. A Hub-mode client's Codex calls the Hub's data listener directly, so
 * the Hub stamps its own response.
 *
 * The instance id is the install's `homeId` from `src/quota-pool/identity.ts`: a random
 * `home_<32 hex>` minted once per install, persisted owner-only, and stable across restarts. It is
 * never a hostname and is not derived from one. Until the identity exists (it is created in the
 * background after the listener starts) or when its file is unreadable, the header and the
 * `/healthz` field are omitted; an empty or malformed value is never sent.
 *
 * `SERVED_BY_HEADER_EMITTED` tells `/readyz` to advertise `served-by-header`
 * (`src/remote/features.ts`); `tests/server/readyz-features.test.ts` fails if the advertisement
 * and live responses disagree.
 */
import { readQuotaPoolIdentity } from "../quota-pool/identity";

export const SERVED_BY_HEADER = "x-opencodex-served-by";

/** Whether responses from this build carry {@link SERVED_BY_HEADER}. */
export const SERVED_BY_HEADER_EMITTED: boolean = true;

const INSTANCE_ID = /^home_[0-9a-f]{32}$/;

/** This Home's opaque instance id, or undefined while the install identity is unavailable. */
export function homeInstanceId(): string | undefined {
  let homeId: unknown;
  try { homeId = readQuotaPoolIdentity()?.homeId; } catch { return undefined; }
  return typeof homeId === "string" && INSTANCE_ID.test(homeId) ? homeId : undefined;
}

/** Stamp {@link SERVED_BY_HEADER} with this Home's instance id; leaves the response alone without one. */
export function withServedBy(response: Response, instanceId = homeInstanceId()): Response {
  if (!instanceId) return response;
  try {
    response.headers.set(SERVED_BY_HEADER, instanceId);
    return response;
  } catch {
    const headers = new Headers(response.headers);
    headers.set(SERVED_BY_HEADER, instanceId);
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  }
}

/**
 * The server's last step for every answered request: `GET /v1/models` names the serving Home,
 * whichever branch produced the response. `pathname` is the dispatch path the router matched.
 */
export function stampServedBy(method: string, pathname: string, response: Response): Response {
  if (!response || method !== "GET" || pathname !== "/v1/models") return response;
  return withServedBy(response);
}
