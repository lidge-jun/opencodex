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
import {
  requestPacingMaxConcurrentRequests,
  sendTrackingRequestSlot,
  waitForProviderRequestSlot,
  type ProviderRequestSlot,
} from "../../providers/request-pacing";
import { withUpstreamHttpVersion } from "../../lib/upstream-http-version";
import type { CodexWsQuotaObserver } from "./codex-ws-metadata";
import { configuredOutboundFetch } from "../../lib/proxy-env";
import { isLoopbackUrl, rewriteUpstream } from "../../plugins/upstream-hooks";
import {
  describeProviderEgressForLog,
  markEgressTransparentExecutor,
  providerEgressSendInit,
  providerEgressIsExplicit,
  resolveProviderEgress,
  type ProviderEgressBinding,
} from "../../lib/provider-egress";
import { redactSecretString } from "../../lib/redact";

export { withUpstreamHttpVersion };

const egressWebsocketDowngradeWarned = new Set<string>();
/** A provider name is configuration-controlled, so the notice set is bounded like any cache. */
const EGRESS_DOWNGRADE_NOTICE_LIMIT = 64;
const pacingWebsocketDowngradeWarned = new Set<string>();
/**
 * Marks an init whose provider egress route an outer physical-send boundary already decided.
 *
 * Own symbol keys survive object spread, so the mark travels through the rebuild a
 * `dispatchOverride` performs, and an unknown symbol on a `RequestInit` is inert at the wire.
 */
const EGRESS_DECIDED = Symbol.for("opencodex.provider-egress.decided");
const UPSTREAM_REWRITTEN = Symbol.for("opencodex.plugins.upstream-rewritten");

/**
 * Announce once, per provider, that an explicit egress route moved this provider off the
 * WebSocket fast lane.
 *
 * The WebSocket upstream selects its proxy from the process environment when it dials, so it
 * cannot carry a per-provider route. Serving the turn over HTTP/SSE honours the operator's
 * egress choice, which is the one that has to win — but a transport change the operator did
 * not ask for is exactly the kind of substitution this batch refuses to make silently, so it
 * is stated rather than merely done.
 */
function warnEgressWebsocketDowngradeOnce(providerName: string, egress: string): void {
  if (egressWebsocketDowngradeWarned.has(providerName)) return;
  if (egressWebsocketDowngradeWarned.size >= EGRESS_DOWNGRADE_NOTICE_LIMIT) return;
  egressWebsocketDowngradeWarned.add(providerName);
  console.warn(
    // The name is caller-controlled and can be token-shaped, so it is redacted and JSON-escaped
    // before it reaches a log, exactly as at the management error boundary.
    `[opencodex] provider ${JSON.stringify(redactSecretString(providerName))} declares egress ${egress}; the WebSocket upstream `
    + "selects its proxy from the process environment and cannot carry a per-provider route, "
    + "so these turns are served over HTTP/SSE.",
  );
}

/** Test seam: the downgrade notice is once per provider per process, not once per request. */
export function __resetEgressWebsocketDowngradeNotices(): void {
  egressWebsocketDowngradeWarned.clear();
  pacingWebsocketDowngradeWarned.clear();
}

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
  waitForPacing?: (signal?: AbortSignal) => Promise<ProviderRequestSlot | undefined>;
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
  rawInput: Parameters<typeof globalThis.fetch>[0],
  init?: RequestInit,
  egress?: ProviderEgressBinding,
): Promise<Response> {
  let input = rawInput;
  let headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
  // Plugin rewrites (src/plugins/upstream-hooks.ts) run here, after the caller chose between
  // the Codex WebSocket and HTTP, and before the connection and egress decisions below so
  // those follow the rewritten destination. Nested passes rewrite once, like the egress mark.
  // A rewrite onto this machine's loopback dials directly: a proxy chosen for the provider
  // (per-provider or HTTP_PROXY) cannot reach a local sidecar. The WebSocket dial does the same.
  const rewriteDone = (init as Record<symbol, unknown> | undefined)?.[UPSTREAM_REWRITTEN] === true;
  let redirectedToLoopback = false;
  if (!rewriteDone) {
    const original = input instanceof Request ? input.url : String(input);
    const target = rewriteUpstream(original, headers, "http");
    headers = target.headers as Headers;
    if (target.url !== original) {
      redirectedToLoopback = isLoopbackUrl(target.url);
      input = input instanceof Request ? new Request(target.url, input) : target.url;
    }
  }
  const fresh = wantsFreshConnection(input);
  if (fresh) {
    headers.set("Connection", "close");
  }
  // Decided here, against the destination this send is actually going to, and around whichever
  // executor was just selected. A `dispatchOverride` that rebuilds a queued request can change
  // both the upstream host and the provider transport after the wrapper was constructed, so a
  // route resolved at construction could be applied to a different host than it was decided for.
  // These calls nest: an override decides with its own binding and then hands the send to the
  // executor `providerFetch` supplied, which is another one of these. The outermost caller holds
  // the reselected provider and the rebuilt destination, so it decides and marks the init; the
  // inner pass honours that mark rather than recomputing from a stale closure.
  const alreadyDecided = (init as Record<symbol, unknown> | undefined)?.[EGRESS_DECIDED] === true;
  const decide = egress !== undefined && !alreadyDecided && !redirectedToLoopback;
  const egressInit = redirectedToLoopback
    ? { proxy: false as const }
    : decide ? providerEgressSendInit(egress, physicalFetch, input) : {};
  return physicalFetch(input, {
    ...init,
    headers,
    redirect: "manual",
    ...(fresh ? { keepalive: false } : {}),
    ...egressInit,
    ...(decide || redirectedToLoopback ? { [EGRESS_DECIDED]: true } : {}),
    ...{ [UPSTREAM_REWRITTEN]: true },
  });
}

export interface ProviderFetchOptions {
  /**
   * Keep this send on HTTP even where the WebSocket upstream would normally be selected.
   *
   * Set by a caller replacing an HTTP stream that already failed: a WS create frame is a
   * different send on a different transport, and the replacement has to be the same kind of
   * exchange the client is already reading.
   */
  httpOnly?: boolean;
  nativeControl?: NativeResponseControl;
  providerName?: string;
  modelId?: string;
  /** One pacing slot was acquired immediately before this fetch wrapper was created. */
  pacingSlotAcquired?: boolean;
  pacingSlot?: ProviderRequestSlot;
  /** A runTurn transport holds one concurrency lease across overlapping physical sends. */
  turnScopedPacing?: boolean;
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
  const providerName = options.providerName ?? "<unnamed provider>";
  const customExecutor = (provider as OcxProviderConfig & { fetch?: typeof globalThis.fetch }).fetch;
  // The route is applied at the physical send (see `sendWithConnectionPolicy`). This binding is
  // only what that boundary needs to decide it.
  const egressBinding: ProviderEgressBinding = { providerName, provider };
  // Resolved per request, not once per wrapper: `providers.<name>.noProxy` is evaluated against
  // the destination, so two requests through the same executor can legitimately take different
  // routes. A malformed value throws and rejects the request rather than degrading to the
  // global proxy or to direct, either of which would read as success at the call site.
  const egressFor = (input: Parameters<typeof globalThis.fetch>[0]) => resolveProviderEgress({
    providerName,
    provider,
    url: typeof input === "string" ? input : input instanceof URL ? input : input.url,
  });
  // The built-in executor forwards its init to a transport that honours the proxy option.
  const configuredFetch = markEgressTransparentExecutor(Object.assign(
    (input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => configuredOutboundFetch(input, init),
    { preconnect: globalThis.fetch.preconnect?.bind(globalThis.fetch) },
  ) as typeof globalThis.fetch);
  const base = customExecutor ?? configuredFetch;
  const preconnect = (...args: Parameters<typeof globalThis.fetch.preconnect>): void => {
    base.preconnect?.(...args);
  };
  // Rebuilt dispatches must use the same physical-send boundary as ordinary HTTP sends.
  // Return the original 3xx so the response owner retains its retry/health/relay contract.
  //
  // Marked transparent because it forwards its init to a transport that honours the proxy
  // option. Leaving it unmarked would make an ordinary configured provider refuse its own route
  // on every overridden path, after the attempt had already been recorded — an override selects
  // `provider.fetch ?? execute`, and `execute` is this wrapper. It still carries the binding, so
  // an override that simply calls it gets the route decided rather than dropped; an override
  // that decided for itself has already marked the init and this pass defers to that decision.
  const dispatch = markEgressTransparentExecutor(Object.assign(
    (input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) =>
      sendWithConnectionPolicy(base, input, init, egressBinding),
    { preconnect },
  ) as typeof globalThis.fetch);
  const httpFetch = Object.assign(
    async (input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
      // Refuse before any dispatch side effect where that is sound. `beforeDispatch` commits
      // attempt accounting and consumes admission state, so a refusal firing after it would
      // charge an attempt for a send that never happens, and a throwing hook would mask the
      // egress error with an unrelated one.
      //
      // With no override, this input and `base` ARE the final destination and executor, so the
      // full decision can be made now. With an override, only the configured value is checked:
      // the override may rebuild against a different host and select a different transport, and
      // refusing on this destination would reject a request whose real route is fine.
      if (options.dispatchOverride) egressFor(input);
      else providerEgressSendInit(egressBinding, base, input);
      // The hook inspects the outgoing headers and refuses the send by throwing; it is not a
      // mutator, and the copy it receives is deliberately not threaded onward. `Connection`
      // is decided inside `dispatch`, which runs after this, so the fresh-connection policy
      // wins regardless of what any caller or hook put in the header.
      options.beforeDispatch?.(new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined)));
      // No proxy option is attached here: a `dispatchOverride` may rebuild this request against
      // a different destination, so the route is decided at the physical send instead.
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
    const upstreamWebsocket = provider.upstreamWebsocket;
    if (!options.httpOnly && typeof input === "string" && init
      && shouldUseCodexWsUpstream(input, init, runtime, upstreamWebsocket)) {
      if (options.providerName && requestPacingMaxConcurrentRequests(provider, options.modelId) > 0) {
        if (!pacingWebsocketDowngradeWarned.has(providerName)
          && pacingWebsocketDowngradeWarned.size < EGRESS_DOWNGRADE_NOTICE_LIMIT) {
          pacingWebsocketDowngradeWarned.add(providerName);
          console.warn(`[opencodex] provider ${JSON.stringify(redactSecretString(providerName))} has a request concurrency cap; serving over HTTP/SSE.`);
        }
        return httpFetch(input, init);
      }
      const egress = egressFor(input);
      if (providerEgressIsExplicit(egress)) {
        warnEgressWebsocketDowngradeOnce(providerName, describeProviderEgressForLog(egress));
        return httpFetch(input, init);
      }
      // The fallback has to be the same HTTP fetch the non-WS branch would have
      // used, protocol pin included: a WS turn that falls back is serving the
      // request over HTTP, and dropping the provider's `upstreamHttpVersion`
      // there would silently negotiate a transport the operator ruled out.
      return codexWsUpstreamFetch(input, init, httpFetch, runtime, options.onCodexWsQuota, options.beforeDispatch, options.nativeControl,
        async () => { (await waitForPacing(init.signal ?? undefined))?.release(); });
    }
    return httpFetch(input, init);
  };
  let pacingSlotAcquired = options.pacingSlotAcquired === true;
  const waitForPacing = async (signal?: AbortSignal): Promise<ProviderRequestSlot | undefined> => {
    if (pacingSlotAcquired) {
      pacingSlotAcquired = false;
      if (!options.pacingSlot && requestPacingMaxConcurrentRequests(provider, options.modelId) > 0) {
        throw new Error("A pre-acquired concurrency slot must be passed to providerFetch");
      }
      // Cursor RunSSE and BidiAppend can overlap. The runTurn owner releases this slot when
      // the whole turn finishes; transferring it to RunSSE's body would admit another turn
      // while a BidiAppend from this one is still active.
      return options.turnScopedPacing ? undefined : options.pacingSlot;
    }
    if (options.providerName) {
      return waitForProviderRequestSlot(options.providerName, provider, options.modelId, signal,
        options.turnScopedPacing && options.pacingSlot?.leased && !options.pacingSlot.released
          ? { concurrency: false } : undefined);
    }
    if (requestPacingMaxConcurrentRequests(provider, options.modelId) > 0) {
      throw new Error("A provider name is required for request concurrency pacing");
    }
  };
  const wrapped = async (input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
    return sendTrackingRequestSlot(await waitForPacing(init?.signal ?? undefined), () => unpaced(input, init));
  };
  // The returned wrapper forwards its init down to `dispatch`, which applies the route at the
  // physical send. Adapters that hand this executor back as `provider.fetch` (Cursor does)
  // therefore still carry a per-provider route instead of being refused as opaque.
  const paceAware = Object.assign(wrapped, {
    preconnect,
    waitForPacing,
    unpacedFetch: Object.assign(unpaced, { preconnect }),
  });
  markEgressTransparentExecutor(paceAware as unknown as typeof globalThis.fetch);
  return paceAware;
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
    return sendTrackingRequestSlot(await executor.waitForPacing?.(init?.signal ?? undefined), () => unpaced!(input, init));
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
  const slot = await pacing.waitForPacing?.(abortSignal);
  const fetchExecutor = pacing.unpacedFetch ?? executor;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new AbortController();
    timer = setTimeout(() => {
      if (!timeout.signal.aborted) timeout.abort(new DOMException("Timeout elapsed", "TimeoutError"));
    }, timeoutMs);
    const headers = new Headers(init.headers);
    // Compressed SSE can be held until the decompressor has a complete block. Streaming calls
    // default to identity for low-latency frame delivery, while an explicit caller choice wins.
    if (preferIdentityEncoding && !headers.has("accept-encoding")) {
      headers.set("accept-encoding", "identity");
    }
    return await sendTrackingRequestSlot(slot, () => fetchExecutor(url, {
      ...init,
      headers,
      // Never replay provider credentials or request bodies to a redirect destination.
      // Preserve the 3xx for the owner's existing response/health policy (#914, #1471).
      redirect: "manual",
      signal: AbortSignal.any([abortSignal, timeout.signal]),
      timeout: 0,
    }));
  } finally {
    if (timer) clearTimeout(timer);
    if (!slot?.bodyTracked) slot?.release();
  }
}
