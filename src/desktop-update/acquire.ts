/**
 * Bounded HTTPS acquisition for the headless Desktop updater (#8246).
 *
 * The contract is the acquisition rule in devlog/_plan/261107_auto_update_parity/030_desktop_engine.md:
 * HTTPS only, the exact lidge-jun/opencodex release source, at most three redirects to the
 * listed GitHub asset hosts, no userinfo or non-default port, no credentials, a size cap counted
 * before each chunk is kept, and connect, idle-read and total deadlines. A Content-Length header
 * is advisory: it can refuse early but never raises the bound. The transport and the timers are
 * injected so tests drive every hop and deadline without a network or a sleep; a loopback mock is
 * reachable only through that injected transport, never through a production setting.
 */
import {
  DESKTOP_ACQUIRE_LIMITS,
  DESKTOP_REDIRECT_HOSTS,
  DESKTOP_RELEASE_PATH_PREFIX,
} from "./trust";

export type DesktopAcquireErrorCode =
  | "url_refused"
  | "redirect_refused"
  | "too_many_redirects"
  | "http_status"
  | "connect_timeout"
  | "idle_timeout"
  | "total_timeout"
  | "oversize"
  | "truncated"
  | "transport";

export class DesktopAcquireError extends Error {
  constructor(readonly code: DesktopAcquireErrorCode, readonly retryable: boolean, message: string) {
    super(message);
    this.name = "DesktopAcquireError";
  }
}

export interface AcquireResponse {
  status: number;
  headers: { get(name: string): string | null };
  body: AsyncIterable<Uint8Array> | null;
  /** Release the connection of a response that is not read to the end. */
  cancel?: () => void;
}

export interface AcquireTransport {
  request(url: string, signal: AbortSignal): Promise<AcquireResponse>;
}

export interface AcquireTimers {
  /** Run `fire` once after `ms`; the returned function cancels it. */
  schedule(ms: number, fire: () => void): () => void;
}

export interface AcquireLimits {
  maxBytes: number;
  maxRedirects?: number;
  connectMs?: number;
  idleReadMs?: number;
  totalMs?: number;
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/**
 * Admit one hop. The first request must name the exact release source on github.com; a redirect
 * may move to a listed asset host, and a redirect back to github.com stays inside the same
 * repository's releases.
 */
export function admitAcquireUrl(raw: string, initial: boolean): URL {
  let url: URL;
  try { url = new URL(raw); } catch { throw new DesktopAcquireError(initial ? "url_refused" : "redirect_refused", false, "not an absolute URL"); }
  const code = initial ? "url_refused" : "redirect_refused";
  if (url.protocol !== "https:") throw new DesktopAcquireError(code, false, `${url.protocol} is not https`);
  if (url.username || url.password) throw new DesktopAcquireError(code, false, "a URL with credentials is refused");
  if (url.port !== "") throw new DesktopAcquireError(code, false, "a non-default port is refused");
  const host = url.hostname.toLowerCase();
  if (initial || host === "github.com") {
    if (host !== "github.com" || !url.pathname.startsWith(DESKTOP_RELEASE_PATH_PREFIX)) {
      throw new DesktopAcquireError(code, false, `${host}${url.pathname} is not the OpenCodex release source`);
    }
  } else if (!DESKTOP_REDIRECT_HOSTS.includes(host)) {
    throw new DesktopAcquireError(code, false, `${host} is not a listed GitHub release-asset host`);
  }
  return url;
}

/** Fetch one resource under the acquisition contract and return its exact bytes. */
export async function acquireBounded(
  url: string,
  limits: AcquireLimits,
  deps: { transport: AcquireTransport; timers: AcquireTimers },
): Promise<Uint8Array> {
  const maxRedirects = limits.maxRedirects ?? DESKTOP_ACQUIRE_LIMITS.maxRedirects;
  const connectMs = limits.connectMs ?? DESKTOP_ACQUIRE_LIMITS.connectMs;
  const idleReadMs = limits.idleReadMs ?? DESKTOP_ACQUIRE_LIMITS.idleReadMs;
  const totalMs = limits.totalMs ?? DESKTOP_ACQUIRE_LIMITS.totalMs;
  const controller = new AbortController();
  let failure: DesktopAcquireError | null = null;
  let rejectFailure: (error: DesktopAcquireError) => void = () => {};
  const failed = new Promise<never>((_, reject) => { rejectFailure = reject; });
  failed.catch(() => {});
  const fail = (code: DesktopAcquireErrorCode, message: string) => {
    if (failure) return;
    failure = new DesktopAcquireError(code, true, message);
    controller.abort(failure);
    rejectFailure(failure);
  };
  const raced = async <T>(work: Promise<T>): Promise<T> => {
    try { return await Promise.race([work, failed]); }
    catch (error) {
      if (failure) throw failure;
      if (error instanceof DesktopAcquireError) throw error;
      throw new DesktopAcquireError("transport", true, "the download connection failed");
    }
  };
  const cancelTotal = deps.timers.schedule(totalMs, () => fail("total_timeout", `no complete response within ${totalMs} ms`));
  try {
    let current = url;
    let redirects = 0;
    for (;;) {
      const target = admitAcquireUrl(current, redirects === 0);
      const cancelConnect = deps.timers.schedule(connectMs, () => fail("connect_timeout", `no response within ${connectMs} ms`));
      let response: AcquireResponse;
      try { response = await raced(deps.transport.request(target.href, controller.signal)); }
      finally { cancelConnect(); }
      if (REDIRECT_STATUSES.has(response.status)) {
        response.cancel?.();
        const location = response.headers.get("location");
        if (!location) throw new DesktopAcquireError("redirect_refused", false, "a redirect named no location");
        if (++redirects > maxRedirects) throw new DesktopAcquireError("too_many_redirects", false, `more than ${maxRedirects} redirects`);
        current = new URL(location, target).href;
        continue;
      }
      if (response.status !== 200) {
        response.cancel?.();
        const retryable = response.status === 429 || response.status >= 500;
        throw new DesktopAcquireError("http_status", retryable, `the release source answered HTTP ${response.status}`);
      }
      // A transfer encoding changes what Content-Length counts, so only an identity body binds it.
      const declaredRaw = response.headers.get("content-encoding") ? null : response.headers.get("content-length");
      const declared = declaredRaw !== null && /^\d{1,15}$/.test(declaredRaw) ? Number(declaredRaw) : null;
      if (declared !== null && declared > limits.maxBytes) {
        response.cancel?.();
        throw new DesktopAcquireError("oversize", false, `the response declares ${declared} bytes, over the ${limits.maxBytes}-byte cap`);
      }
      if (!response.body) throw new DesktopAcquireError("truncated", true, "the response had no body");
      const iterator = response.body[Symbol.asyncIterator]();
      const chunks: Uint8Array[] = [];
      let total = 0;
      for (;;) {
        const cancelIdle = deps.timers.schedule(idleReadMs, () => fail("idle_timeout", `no data for ${idleReadMs} ms`));
        let step: IteratorResult<Uint8Array>;
        try { step = await raced(iterator.next()); }
        finally { cancelIdle(); }
        if (step.done) break;
        const chunk = step.value;
        // Count before keeping: an oversized chunk is never retained.
        if (total + chunk.byteLength > limits.maxBytes) {
          try { await iterator.return?.(); } catch { /* the cap already decided */ }
          throw new DesktopAcquireError("oversize", false, `the response exceeded the ${limits.maxBytes}-byte cap`);
        }
        chunks.push(chunk);
        total += chunk.byteLength;
      }
      if (declared !== null && declared !== total) {
        throw new DesktopAcquireError("truncated", true, `received ${total} of ${declared} declared bytes`);
      }
      const bytes = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      return bytes;
    }
  } finally {
    cancelTotal();
    if (!controller.signal.aborted) controller.abort();
  }
}

/** Production transport: manual redirects so every hop is admitted here, and no credentials. */
export const fetchAcquireTransport: AcquireTransport = {
  async request(url, signal) {
    const response = await fetch(url, {
      redirect: "manual",
      signal,
      credentials: "omit",
      headers: { "user-agent": "opencodex-desktop-updater", accept: "application/octet-stream, application/json" },
    });
    return {
      status: response.status,
      headers: response.headers,
      body: response.body as unknown as AsyncIterable<Uint8Array> | null,
      cancel: () => { response.body?.cancel().catch(() => {}); },
    };
  },
};

export const realAcquireTimers: AcquireTimers = {
  schedule(ms, fire) {
    const timer = setTimeout(fire, ms);
    return () => clearTimeout(timer);
  },
};
