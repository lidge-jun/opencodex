import { runningProxyUpdateHeaders } from "../oauth/login-cli";
import { runtimeBaseUrl, RuntimeApiError } from "./runtime-api";
import { validateStatus, type LinkStatusPayload } from "./link";

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
    try { response = await (deps.fetchImpl ?? fetch)(`${base}/api/link/status`, { headers: (deps.headers ?? runningProxyUpdateHeaders)(), signal: controller.signal }); }
    catch (cause) { throw new LinkStatusError("home-link-status-unavailable", { cause }); }
    if (response.status === 401 || response.status === 403) throw new LinkStatusError("home-link-status-unauthorized");
    if (!response.ok) throw new LinkStatusError("home-link-status-unavailable");
    let text: string;
    try { text = await response.text(); } catch (cause) { throw new LinkStatusError("home-link-status-unavailable", { cause }); }
    try { return validateStatus(JSON.parse(text)); } catch (cause) { throw new LinkStatusError("home-link-status-invalid", { cause }); }
  };
  try { return await Promise.race([work(), timeout]); }
  finally { if (timer !== undefined) clearTimeout(timer); controller.abort(); }
}
