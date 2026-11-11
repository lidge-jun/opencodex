import { runningProxyUpdateHeaders } from "../oauth/login-cli";
import { runtimeBaseUrl, RuntimeApiError } from "./runtime-api";
import { validateStatus, type LinkStatusPayload } from "./link";
import { validateChildOps } from "./link-status-child";

export type LinkStatusFailure = "home-runtime-not-running" | "home-link-status-unauthorized" | "home-link-status-timeout" | "home-link-status-unavailable" | "home-link-status-invalid";
export class LinkStatusError extends Error {
  constructor(readonly reason: LinkStatusFailure, options?: ErrorOptions) { super(reason, options); this.name = "LinkStatusError"; }
}

/** A single absolute deadline covers discovery, response headers and the response body. */
export async function readHomeLinkStatus(deadlineMs = 5000, deps: {
  baseUrl?: () => Promise<string | null>; fetchImpl?: typeof fetch; headers?: () => Headers;
} = {}): Promise<LinkStatusPayload> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { controller.abort(); reject(new LinkStatusError("home-link-status-timeout")); }, Math.max(0, deadlineMs));
  });
  const work = async (): Promise<LinkStatusPayload> => {
    let base: string | null;
    try { base = await (deps.baseUrl ?? (() => runtimeBaseUrl()))(); }
    catch (cause) {
      if (cause instanceof RuntimeApiError && cause.code === "proxy_not_running") throw new LinkStatusError("home-runtime-not-running", { cause });
      throw new LinkStatusError("home-link-status-unavailable", { cause });
    }
    if (controller.signal.aborted) throw new LinkStatusError("home-link-status-timeout");
    if (!base) throw new LinkStatusError("home-runtime-not-running");
    let response: Response;
    // wp2: children=1 adds each row's child block (activity, active job); an older Home ignores the query.
    try { response = await (deps.fetchImpl ?? fetch)(`${base}/api/link/status?children=1`, { headers: (deps.headers ?? runningProxyUpdateHeaders)(), signal: controller.signal }); }
    catch (cause) { throw new LinkStatusError("home-link-status-unavailable", { cause }); }
    if (response.status === 401 || response.status === 403) throw new LinkStatusError("home-link-status-unauthorized");
    if (!response.ok) throw new LinkStatusError("home-link-status-unavailable");
    let text: string;
    try { text = await response.text(); } catch (cause) { throw new LinkStatusError("home-link-status-unavailable", { cause }); }
    try { return validateStatus(withoutInvalidChildBlocks(JSON.parse(text))); } catch (cause) { throw new LinkStatusError("home-link-status-invalid", { cause }); }
  };
  try { return await Promise.race([work(), timeout]); }
  finally { if (timer !== undefined) clearTimeout(timer); controller.abort(); }
}

/**
 * 040 Revision 6: a row whose child block fails validation reads as a row without one (no busy skip, restarts withheld
 * as activity-unknown); it never fails the whole status read, so the other rows keep their results.
 */
function withoutInvalidChildBlocks(value: unknown): unknown {
  if (!value || typeof value !== "object" || !Array.isArray((value as { links?: unknown }).links)) return value;
  const links = (value as { links: unknown[] }).links.map((row, index) => {
    if (!row || typeof row !== "object" || Array.isArray(row) || !Object.hasOwn(row, "child")) return row;
    try { validateChildOps((row as { child: unknown }).child, index); return row; }
    catch { const { child: _dropped, ...rest } = row as Record<string, unknown>; return rest; }
  });
  return { ...value, links };
}
