/**
 * Per-provider egress: which transport a request for THIS provider actually leaves by.
 *
 * The global `proxy`/`noProxy` pair is process-wide (mirrored into HTTP_PROXY/HTTPS_PROXY/
 * ALL_PROXY/NO_PROXY by `applyProxyEnv`), so it cannot express the split #2894 describes:
 * one upstream must exit through a regional proxy, another must stay direct on the local
 * network. This module is the single authority that answers that question for one request,
 * and every transport owner that can carry the answer consumes it rather than re-deriving it.
 *
 * It deliberately mirrors the shape #5087 established for the global decision in
 * `effectiveProxyFor`: the question is never "is a proxy configured" but "does a proxy apply
 * to THIS request". A provider route is resolved against the request URL, so a per-provider
 * bypass list is part of the decision rather than a second check somewhere downstream.
 *
 * The three states are exactly the ones the issue asks for, with one deliberate divergence:
 *
 * - field absent          -> `inherit`: the global decision stands, byte-identical to today;
 * - `null` or `"direct"` -> `direct`: this provider never uses the global proxy;
 * - an http(s) URL        -> `proxy`: this provider uses its own HTTP(S) proxy;
 * - a socks5(h) URL       -> `proxy`: this provider uses its own SOCKS5 proxy.
 *
 * The divergence is the empty string. #2894 sketches `""` as a third spelling of DIRECT.
 * Treating it that way would make a dashboard field the operator merely cleared silently
 * change a provider from "inherit the global proxy" to "never use the global proxy" — the
 * quiet reinterpretation this batch exists to remove. An empty or whitespace-only value is
 * therefore a configuration error naming both real alternatives.
 */
import type { OcxProviderConfig } from "../types";
import { isSocks5ProxyUrl, noProxyMatches } from "./proxy-env";

export class InvalidProviderEgressError extends Error {
  override readonly name = "InvalidProviderEgressError";
  constructor(
    /** The provider field that carries the offending value. */
    readonly field: "proxy" | "noProxy",
    /** The failure on its own, so configuration surfaces can phrase it their own way. */
    readonly reason: string,
    message: string,
  ) {
    super(message);
  }
}

/** The literal an operator writes to pin one provider to direct egress. */
export const PROVIDER_EGRESS_DIRECT = "direct";

export type ProviderEgress =
  | { kind: "inherit" }
  | { kind: "direct"; reason: "configured" | "noProxy" }
  | { kind: "proxy"; proxyUrl: string; transport: "http" | "socks5" };

export interface ProviderEgressContext {
  providerName: string;
  provider: Pick<OcxProviderConfig, "proxy" | "noProxy">;
  url: string | URL;
}

function egressFailure(providerName: string, field: "proxy" | "noProxy", reason: string): never {
  throw new InvalidProviderEgressError(field, reason, `providers.${providerName}.${field} is invalid: ${reason}`);
}

/**
 * A proxy URL reduced to scheme, host and port for operator-facing output.
 *
 * A proxy URL routinely carries `user:password@`, and this value reaches startup banners,
 * diagnostics and the dashboard DTO. `URL.origin` drops userinfo, query and path, so what is
 * left identifies the route without reproducing the credential. Nothing derived from the
 * credential is emitted either — not a hash, not a prefix — because a short digest over a
 * known host is a guessable stand-in for the secret and a durable correlation key for the
 * account behind it.
 */
export function sanitizeProxyUrlForLog(proxyUrl: string): string {
  try {
    const parsed = new URL(proxyUrl);
    return parsed.port ? `${parsed.protocol}//${parsed.hostname}:${parsed.port}` : parsed.origin;
  } catch {
    return "<unparseable-proxy-url>";
  }
}

export function describeProviderEgressForLog(egress: ProviderEgress): string {
  if (egress.kind === "inherit") return "inherit";
  if (egress.kind === "direct") return `direct(${egress.reason})`;
  return `${egress.transport}(${sanitizeProxyUrlForLog(egress.proxyUrl)})`;
}

function parseTargetUrl(providerName: string, url: string | URL): URL {
  if (url instanceof URL) return url;
  try {
    return new URL(url);
  } catch {
    return egressFailure(providerName, "proxy", "the request URL is not parseable, so no provider route can be decided for it");
  }
}

function normalizeNoProxy(providerName: string, raw: string | string[] | undefined): string | null {
  if (raw === undefined) return null;
  const entries = Array.isArray(raw) ? raw : [raw];
  for (const entry of entries) {
    if (typeof entry !== "string") {
      return egressFailure(providerName, "noProxy", "every entry must be a string host pattern");
    }
  }
  const joined = entries.join(",").trim();
  return joined.length > 0 ? joined : null;
}

function parseProviderProxyRoute(providerName: string, raw: string): ProviderEgress {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return egressFailure(
      providerName,
      "proxy",
      `an empty value is ambiguous; write "${PROVIDER_EGRESS_DIRECT}" to force direct egress, or remove the field to inherit the global proxy`,
    );
  }
  if (trimmed.toLowerCase() === PROVIDER_EGRESS_DIRECT) return { kind: "direct", reason: "configured" };
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return egressFailure(
      providerName,
      "proxy",
      `"${PROVIDER_EGRESS_DIRECT}" or an absolute proxy URL is required; this value is neither`,
    );
  }
  if (isSocks5ProxyUrl(trimmed)) {
    if (!parsed.hostname) {
      return egressFailure(providerName, "proxy", "the SOCKS5 proxy URL has no host");
    }
    return { kind: "proxy", proxyUrl: trimmed, transport: "socks5" };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return egressFailure(
      providerName,
      "proxy",
      `unsupported proxy scheme "${parsed.protocol}"; supported schemes are http, https, socks5 and socks5h`,
    );
  }
  if (!parsed.hostname) {
    return egressFailure(providerName, "proxy", "the proxy URL has no host");
  }
  return { kind: "proxy", proxyUrl: parsed.toString(), transport: "http" };
}

/**
 * The route this provider's request leaves by, or `inherit` when the global decision stands.
 *
 * Throws `InvalidProviderEgressError` rather than degrading to `inherit`: a malformed egress
 * field is the one case where guessing is worst. Falling back to the global proxy would send a
 * credential through a route the operator did not choose, and falling back to direct would
 * leave a restricted network with no exit. Both read as success at the call site.
 *
 * A per-provider `noProxy` match outranks the provider's own proxy for the same reason it
 * outranks the global one: it names destinations this provider must reach without a proxy.
 * It is evaluated against the resolved route, so it also carves holes in an inherited global
 * proxy — which is how a provider exempts one host without owning a proxy of its own.
 */
export function resolveProviderEgress(context: ProviderEgressContext): ProviderEgress {
  const { providerName, provider } = context;
  const raw = provider.proxy;
  let route: ProviderEgress;
  if (raw === undefined) {
    route = { kind: "inherit" };
  } else if (raw === null) {
    route = { kind: "direct", reason: "configured" };
  } else if (typeof raw !== "string") {
    return egressFailure(providerName, "proxy", "the value must be a proxy URL string, \"direct\", null, or absent");
  } else {
    route = parseProviderProxyRoute(providerName, raw);
  }
  const noProxy = normalizeNoProxy(providerName, provider.noProxy);
  if (noProxy !== null) {
    const target = parseTargetUrl(providerName, context.url);
    if (noProxyMatches(target, { NO_PROXY: noProxy })) return { kind: "direct", reason: "noProxy" };
  }
  return route;
}

/**
 * Whether this provider decided the route itself, as opposed to deferring to the global one.
 *
 * Transport owners use this to tell "the operator chose this" from "nothing was configured",
 * which are the two cases that must not be collapsed when a transport cannot carry the choice.
 */
export function providerEgressIsExplicit(egress: ProviderEgress): boolean {
  return egress.kind !== "inherit";
}

/**
 * The request-scoped fetch options that express `egress` to Bun's fetch.
 *
 * `proxy: false` is Bun's documented per-request direct connection: it ignores HTTP_PROXY,
 * HTTPS_PROXY and ALL_PROXY, and it ignores NO_PROXY as well, which is what makes it a
 * decision rather than a hint. `undefined`, `null` and `""` all mean "no option given" to
 * Bun and fall through to the environment, so none of them can express direct egress — the
 * reason this returns the literal `false` and never an empty string.
 *
 * A SOCKS5 route is returned as the same `proxy` string; `configuredOutboundFetch` recognises
 * the scheme and hands the request to the SOCKS transport, because Bun's own fetch ignores a
 * socks5 value.
 */
export function providerEgressFetchInit(egress: ProviderEgress): { proxy?: string | false } {
  if (egress.kind === "inherit") return {};
  if (egress.kind === "direct") return { proxy: false };
  return { proxy: egress.proxyUrl };
}

/**
 * Marker for an executor that forwards its `RequestInit` to a transport which honours the
 * request-scoped proxy option.
 *
 * A provider route is refused on an executor that owns its own transport, because applying it
 * is impossible and ignoring it is worse. But not every `provider.fetch` owns a transport:
 * some are internal wrappers that add a header and delegate, and `src/providers/xai-transport.ts`
 * installs exactly such a wrapper on every xAI route. Refusing those would make the per-provider
 * proxy unusable on one of the two providers the original issue names.
 *
 * The marker is opt-in and applied by the wrapper's author, so an executor that arrives from
 * configuration or from a caller is opaque by default and still refused. `Symbol.for` keeps the
 * mark readable across duplicated module instances.
 */
const EGRESS_TRANSPARENT_EXECUTOR = Symbol.for("opencodex.provider-egress.transparent-executor");

export function markEgressTransparentExecutor<Fetch extends typeof globalThis.fetch>(executor: Fetch): Fetch {
  (executor as unknown as Record<symbol, boolean>)[EGRESS_TRANSPARENT_EXECUTOR] = true;
  return executor;
}

export function isEgressTransparentExecutor(executor: unknown): boolean {
  return typeof executor === "function"
    && (executor as unknown as Record<symbol, unknown>)[EGRESS_TRANSPARENT_EXECUTOR] === true;
}

/** The destination of a fetch input, or null when it cannot be read as a URL. */
export function egressTargetUrl(input: string | URL | Request): string | null {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return typeof input?.url === "string" ? input.url : null;
}

/** Everything a physical send needs to decide the route for the request it is about to make. */
export interface ProviderEgressBinding {
  providerName: string;
  provider: Pick<OcxProviderConfig, "proxy" | "noProxy">;
}

/**
 * The request options expressing `binding`'s route for the destination actually being sent to.
 *
 * Resolved at the physical send rather than when the executor was built, for the reason #4992
 * already established for the connection policy: a queued request can be rebuilt against a
 * different upstream host before it leaves, and a route decided against the original
 * destination would then be applied to a different one. With a host-scoped `noProxy` that
 * inverts the decision, and the credential leaves by a route the operator did not choose.
 *
 * Refuses rather than degrades when the selected executor owns its own transport.
 */
export function providerEgressSendInit(
  binding: ProviderEgressBinding,
  physicalFetch: unknown,
  input: string | URL | Request,
): { proxy?: string | false } {
  const url = egressTargetUrl(input);
  if (url === null) return {};
  const egress = resolveProviderEgress({ providerName: binding.providerName, provider: binding.provider, url });
  if (providerEgressIsExplicit(egress) && !isEgressTransparentExecutor(physicalFetch)) {
    // Name the field that actually made the route explicit. A bypass-list match with no
    // `proxy` field at all would otherwise tell the operator to remove an override they
    // never wrote.
    const field = egress.kind === "direct" && egress.reason === "noProxy" ? "noProxy" : "proxy";
    throw new InvalidProviderEgressError(
      field,
      "the selected transport owns its own routing, so this route cannot be applied",
      `providers.${binding.providerName}.${field} cannot be applied to the selected provider transport; `
      + "remove the provider egress override or the custom executor",
    );
  }
  return providerEgressFetchInit(egress);
}

/**
 * A destination used only to exercise the resolver at configuration time.
 *
 * Validation has no request URL, but `noProxy` is only meaningful against one. Resolving a
 * reserved name checks the shape of both fields without asserting anything about which route a
 * real request would take.
 */
const EGRESS_VALIDATION_URL = "https://validation.invalid/";

/**
 * The configuration error for a provider's egress fields, or null when they are usable.
 *
 * Delegates to `resolveProviderEgress` so configuration and request time cannot drift apart:
 * a value accepted by `ocx config set` or the dashboard is one the transport will accept, and
 * one rejected here is rejected there for the identical reason. Restating the rules would give
 * this repository two definitions of a valid proxy value and no check that they agree.
 */
export function providerEgressConfigError(
  provider: Pick<OcxProviderConfig, "proxy" | "noProxy">,
): string | null {
  try {
    resolveProviderEgress({ providerName: "<validation>", provider, url: EGRESS_VALIDATION_URL });
    return null;
  } catch (error) {
    if (error instanceof InvalidProviderEgressError) return `${error.field} is invalid: ${error.reason}`;
    throw error;
  }
}
