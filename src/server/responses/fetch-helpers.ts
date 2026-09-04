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



export interface PaceAwareFetch {
  waitForPacing?: (signal?: AbortSignal) => Promise<void>;
  unpacedFetch?: typeof globalThis.fetch;
}

export type ProviderFetch = typeof globalThis.fetch & PaceAwareFetch;

export interface ProviderFetchOptions {
  providerName?: string;
  modelId?: string;
  /** One pacing slot was acquired immediately before this fetch wrapper was created. */
  pacingSlotAcquired?: boolean;
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
  const httpFetch = Object.assign(
    (input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) =>
      base(input, { ...withUpstreamHttpVersion(input, init, provider), timeout: 0 }),
    { preconnect },
  ) as typeof globalThis.fetch;
  // ChatGPT Codex backend: streaming turns ride the responses_websockets
  // transport (measured ~3s faster TTFT than the SSE POST queue); everything
  // else keeps the provider's HTTP fetch. See ws-upstream.ts for the details.
  const unpaced = async (input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
    const upstreamWebsocket = provider.upstreamWebsocket === true;
    if (typeof input === "string" && init && shouldUseCodexWsUpstream(input, init, runtime, upstreamWebsocket)) {
      // The fallback has to be the same HTTP fetch the non-WS branch would have
      // used, protocol pin included: a WS turn that falls back is serving the
      // request over HTTP, and dropping the provider's `upstreamHttpVersion`
      // there would silently negotiate a transport the operator ruled out.
      return codexWsUpstreamFetch(input, init, httpFetch, runtime);
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

export async function fetchWithHeaderTimeout(
  url: string,
  init: Omit<RequestInit, "signal">,
  abortSignal: AbortSignal,
  timeoutMs: number,
  preferIdentityEncoding = false,
  executor: typeof globalThis.fetch = globalThis.fetch,
  manualRedirect = false,
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
      // Credential-bearing sends opt into manual redirects so a 3xx is relayed
      // as a Response instead of being followed into a rejection that is
      // indistinguishable from a pre-connection failure (#914).
      ...(manualRedirect ? { redirect: "manual" as const } : {}),
      signal: AbortSignal.any([abortSignal, timeout.signal]),
      timeout: 0,
    });
  } finally {
    clearTimeout(timer);
  }
}
