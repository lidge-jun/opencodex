import type { NativeResponseControl } from "./native-response-control";
import type { Server } from "bun";
import {
  codexWsUpstreamFetch,
  currentBunRuntimeIdentity,
  shouldUseCodexWsUpstream,
  type BunRuntimeGateInput,
} from "./ws-upstream";
import type { OcxProviderConfig } from "../../types";
import type { WsData } from "../ws-bridge";
import { waitForProviderRequestSlot } from "../../providers/request-pacing";
import { withUpstreamHttpVersion } from "../../lib/upstream-http-version";
import type { CodexWsQuotaObserver } from "./codex-ws-metadata";
import { configuredOutboundFetch } from "../../lib/proxy-env";

export { withUpstreamHttpVersion };

export function disableResponsesRequestTimeout(req: Request, server: Pick<Server<WsData>, "timeout"> | undefined): boolean {
  if (!server) return false;
  try {
    server.timeout(req, 0);
    return true;
  } catch {
    return false;
  }
}



export function safeHostLabel(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "upstream";
  }
}

/** Canonical origin (scheme + host) for failure-attribution keys: http and
 * https for the same host must not share one ledger entry (#914 review). */
export function safeOriginLabel(url: string): string {
  try {
    return new URL(url).origin.toLowerCase();
  } catch {
    return "upstream";
  }
}

/**
 * Check whether a target host should bypass Bun's keep-alive pool reuse.
 * Configured via the `OCX_FRESH_CONNECTION_HOSTS` environment variable (comma-separated).
 */
export function wantsFreshConnection(
  input: Parameters<typeof globalThis.fetch>[0],
  hostsEnv = process.env.OCX_FRESH_CONNECTION_HOSTS,
): boolean {
  if (!hostsEnv) return false;
  try {
    const rawUrl = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const host = new URL(rawUrl).hostname.toLowerCase();
    const targets = hostsEnv
      .split(",")
      .map(h => h.trim().toLowerCase().replace(/^\.+/, ""))
      .filter(Boolean);
    for (const target of targets) {
      if (host === target || host.endsWith(`.${target}`)) return true;
    }
  } catch {
    /* unparseable target URL keeps default connection behavior */
  }
  return false;
}



export interface PaceAwareFetch {
  waitForPacing?: (signal?: AbortSignal) => Promise<void>;
  unpacedFetch?: typeof globalThis.fetch;
}

export type ProviderFetch = typeof globalThis.fetch & PaceAwareFetch;

/**
 * Apply the physical-send connection policy to whichever fetch actually performs the send.
 *
 * The executor `providerFetch` builds is not the only physical boundary. A `dispatchOverride`
 * that revalidates credentials re-reads `route.provider.fetch` at send time -- reselection can
 * install a different provider transport after this wrapper was constructed -- and then calls
 * that fetch directly instead of the supplied executor. Keeping the policy inside the executor
 * alone therefore left every provider-scoped transport reusing a pooled socket for a host the
 * operator had named in `OCX_FRESH_CONNECTION_HOSTS` (#4992). The policy belongs around the
 * selected fetch so it follows the selection rather than the construction.
 *
 * Idempotent on purpose: an override that hands the send back to the supplied executor passes
 * through here twice, and both passes derive the same headers from the same wire URL.
 */
export function sendWithConnectionPolicy(
  physicalFetch: typeof globalThis.fetch,
  input: Parameters<typeof globalThis.fetch>[0],
  init?: RequestInit,
): Promise<Response> {
  const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
  const fresh = wantsFreshConnection(input);
  if (fresh) {
    headers.set("Connection", "close");
  }
  return physicalFetch(input, {
    ...init,
    headers,
    redirect: "manual",
    ...(fresh ? { keepalive: false } : {}),
  });
}

export interface ProviderFetchOptions {
  /** A replacement HTTP body must not initiate a fresh WebSocket exchange. */
  httpOnly?: boolean;
  nativeControl?: NativeResponseControl;
  providerName?: string;
  modelId?: string;
  /** One pacing slot was acquired immediately before this fetch wrapper was created. */
  pacingSlotAcquired?: boolean;
  /** Captured selected-account observer, attached before the native WS send. */
  onCodexWsQuota?: CodexWsQuotaObserver;
  /** Synchronous admission at actual credential dispatch, after pacing/backoff. */
  beforeDispatch?: (headers: Headers) => void;
  /** Revalidate/rebuild a queued request at its physical send boundary, after pacing. */
  dispatchOverride?: (input: Parameters<typeof globalThis.fetch>[0], init: RequestInit, execute: typeof globalThis.fetch) => Promise<Response>;
}

export function providerFetch(
  provider: OcxProviderConfig,
  runtime: BunRuntimeGateInput = currentBunRuntimeIdentity(),
  options: ProviderFetchOptions = {},
): ProviderFetch {
  const configuredFetch = Object.assign(
    (input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => configuredOutboundFetch(input, init),
    { preconnect: globalThis.fetch.preconnect?.bind(globalThis.fetch) },
  ) as typeof globalThis.fetch;
  const base = (provider as OcxProviderConfig & { fetch?: typeof globalThis.fetch }).fetch ?? configuredFetch;
  const preconnect = (...args: Parameters<typeof globalThis.fetch.preconnect>): void => {
    base.preconnect?.(...args);
  };
  // Rebuilt dispatches must use the same physical-send boundary as ordinary HTTP sends.
  // Return the original 3xx so the response owner retains its retry/health/relay contract.
  const dispatch = Object.assign(
    (input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) =>
      sendWithConnectionPolicy(base, input, init),
    { preconnect },
  ) as typeof globalThis.fetch;
  const httpFetch = Object.assign(
    async (input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
      // The hook inspects the outgoing headers and refuses the send by throwing; it is not a
      // mutator, and the copy it receives is deliberately not threaded onward. `Connection`
      // is decided inside `dispatch`, which runs after this, so the fresh-connection policy
      // wins regardless of what any caller or hook put in the header.
      options.beforeDispatch?.(new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined)));
      const dispatchInit = { ...withUpstreamHttpVersion(input, init, provider), timeout: 0 };
      return options.dispatchOverride
        ? options.dispatchOverride(input, dispatchInit, dispatch)
        : dispatch(input, dispatchInit);
    },
    { preconnect },
  ) as typeof globalThis.fetch;
  // ChatGPT Codex backend: streaming turns ride the responses_websockets
  // transport (measured ~3s faster TTFT than the SSE POST queue); everything
  // else keeps the provider's HTTP fetch. See ws-upstream.ts for the details.
  const unpaced = async (input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
    const upstreamWebsocket = provider.upstreamWebsocket === true;
    if (!options.httpOnly && typeof input === "string" && init && shouldUseCodexWsUpstream(input, init, runtime, upstreamWebsocket)) {
      // The fallback has to be the same HTTP fetch the non-WS branch would have
      // used, protocol pin included: a WS turn that falls back is serving the
      // request over HTTP, and dropping the provider's `upstreamHttpVersion`
      // there would silently negotiate a transport the operator ruled out.
      return codexWsUpstreamFetch(input, init, httpFetch, runtime, options.onCodexWsQuota, options.beforeDispatch, options.nativeControl,
        () => waitForPacing(init.signal ?? undefined));
    }
    return httpFetch(input, init);
  };
  let pacingSlotAcquired = options.pacingSlotAcquired === true;
  const waitForPacing = (signal?: AbortSignal) => {
    if (pacingSlotAcquired) {
      pacingSlotAcquired = false;
      return Promise.resolve();
    }
    return options.providerName
      ? waitForProviderRequestSlot(options.providerName, provider, options.modelId, signal)
      : Promise.resolve();
  };
  const wrapped = async (input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
    await waitForPacing(init?.signal ?? undefined);
    return unpaced(input, init);
  };
  return Object.assign(wrapped, {
    preconnect,
    waitForPacing,
    unpacedFetch: Object.assign(unpaced, { preconnect }),
  });
}



/**
 * Wrap a provider fetch so `onDispatch` fires immediately before the send, not before pacing.
 *
 * `fetchWithHeaderTimeout` awaits `waitForPacing` and only then calls the executor, so a caller
 * that signals at the call site records a dispatch even when a rejected pacing wait means nothing
 * reached the network. That matters when the signal bounds later recovery: the request would lose
 * its fallback on the strength of a send that never happened.
 *
 * The pacing surface is preserved deliberately. `waitForPacing` and `unpacedFetch` are read off
 * the executor by `fetchWithHeaderTimeout`, so a plain function wrapper would silently drop
 * provider pacing and double-send the slot.
 */
export function storedPoolReplayDispatchNotifier(
  executor: ProviderFetch,
  onDispatch: (() => void) | undefined,
): ProviderFetch {
  if (!onDispatch) return executor;
  let notified = false;
  const notifyOnce = (): void => {
    if (notified) return;
    notified = true;
    onDispatch();
  };
  const unpacedSource = executor.unpacedFetch ?? executor;
  const unpaced = Object.assign(
    (input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
      notifyOnce();
      return unpacedSource(input, init);
    },
    { preconnect: unpacedSource.preconnect },
  ) as ProviderFetch["unpacedFetch"];
  const wrapped = async (input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
    await executor.waitForPacing?.(init?.signal ?? undefined);
    return unpaced!(input, init);
  };
  return Object.assign(wrapped, {
    preconnect: executor.preconnect,
    waitForPacing: executor.waitForPacing,
    unpacedFetch: unpaced,
  }) as ProviderFetch;
}

/**
 * Fetch through the header deadline with redirects always manual.
 * @param _manualRedirect Ignored; retained for call compatibility. Even false uses manual.
 */
export async function fetchWithHeaderTimeout(
  url: string,
  init: Omit<RequestInit, "signal">,
  abortSignal: AbortSignal,
  timeoutMs: number,
  preferIdentityEncoding = false,
  executor: typeof globalThis.fetch = globalThis.fetch,
  // Retained for existing callers; credential-bearing transport no longer opts out.
  _manualRedirect = false,
): Promise<Response> {
  const pacing = executor as ProviderFetch;
  await pacing.waitForPacing?.(abortSignal);
  const fetchExecutor = pacing.unpacedFetch ?? executor;
  const timeout = new AbortController();
  const timer = setTimeout(() => {
    if (!timeout.signal.aborted) timeout.abort(new DOMException("Timeout elapsed", "TimeoutError"));
  }, timeoutMs);
  const headers = new Headers(init.headers);
  // Compressed SSE can be held until the decompressor has a complete block. Streaming calls
  // default to identity for low-latency frame delivery, while an explicit caller choice wins.
  if (preferIdentityEncoding && !headers.has("accept-encoding")) {
    headers.set("accept-encoding", "identity");
  }
  try {
    return await fetchExecutor(url, {
      ...init,
      headers,
      // Never replay provider credentials or request bodies to a redirect destination.
      // Preserve the 3xx for the owner's existing response/health policy (#914, #1471).
      redirect: "manual",
      signal: AbortSignal.any([abortSignal, timeout.signal]),
      timeout: 0,
    });
  } finally {
    clearTimeout(timer);
  }
}
