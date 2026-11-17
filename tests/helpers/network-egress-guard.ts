/**
 * Refuse real network egress from a test process (#8848).
 *
 * A full suite run sent fixture credentials to nine real provider hosts: every leak was a request
 * that got past a mock, not a test that meant to go online. This guard turns any such request into
 * a local connection failure, which is what an offline runner already produces, so the fixture
 * credential never leaves the machine and no test depends on a third party's latency.
 *
 * Three entry points cover every outbound path Bun offers (measured on Bun 1.4.4):
 * - globalThis.fetch;
 * - globalThis.WebSocket;
 * - net.Socket.prototype.connect, which Bun's net.connect, tls.connect, http(s).request and
 *   http2.connect all reach, passing Node's normalized [options, callback] array.
 *
 * Allowed: loopback (127.0.0.0/8, ::1, IPv4-mapped loopback, localhost, *.localhost), the
 * wildcard addresses, the reserved .test / .example / .invalid names (they fail in DNS, which many
 * tests rely on), Unix sockets, non-network fetch schemes, and a fetch or WebSocket whose proxy is
 * loopback. The machine's own interface addresses are allowed only after
 * allowOwnInterfaceAddressesForTest(), for the one suite that connects to them on purpose.
 *
 * Header values are never read, so nothing secret reaches an error message.
 */
import net, { isIP } from "node:net";
import { networkInterfaces } from "node:os";
import { join } from "node:path";

const INSTALLED = Symbol.for("opencodex.test.networkEgressGuard");
/** Where a refused WebSocket is sent: a Unix path that does not exist, so it fails without TCP. */
export const REFUSED_WEBSOCKET_URL = "ws+unix:///nonexistent/opencodex-test-network-guard.sock";
const RESERVED_SUFFIXES = [".test", ".example", ".invalid", ".localhost"];
const RESERVED_NAMES = new Set(["localhost", "test", "example", "invalid"]);

let ownInterfaceAddresses: Set<string> | null = null;

/**
 * Let this process reach literal addresses of its own network interfaces until the returned
 * function runs. Test files share one process, so a suite that needs this restores it after.
 */
export function allowOwnInterfaceAddressesForTest(): () => void {
  const previous = ownInterfaceAddresses;
  const addresses = new Set<string>();
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) addresses.add(entry.address.toLowerCase());
  }
  ownInterfaceAddresses = addresses;
  return () => { ownInterfaceAddresses = previous; };
}

function isLoopbackAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return address.startsWith("127.") || address === "0.0.0.0";
  if (family !== 6) return false;
  // Canonicalize so every spelling of one address compares equal: the URL parser compresses
  // zeros and prints an IPv4-mapped address in hex (::ffff:127.0.0.1 -> ::ffff:7f00:1).
  let canonical: string;
  try { canonical = new URL("http://[" + address + "]/").hostname.slice(1, -1); } catch { return false; }
  if (canonical === "::1" || canonical === "::") return true;
  const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(canonical);
  if (!mapped) return false;
  const high = Number.parseInt(mapped[1]!, 16);
  return high >> 8 === 127 || (high === 0 && Number.parseInt(mapped[2]!, 16) === 0);
}

/** Whether a test process may open a connection to this host name or address. */
export function isTestEgressAllowed(rawHost: string | null | undefined): boolean {
  // node:net defaults a missing host to localhost.
  if (rawHost === undefined || rawHost === null || rawHost === "") return true;
  const host = rawHost.trim().replace(/^\[(.*)\]$/, "$1").replace(/\.$/, "").toLowerCase();
  if (host === "") return true;
  if (isIP(host) !== 0) return isLoopbackAddress(host) || (ownInterfaceAddresses?.has(host) ?? false);
  if (RESERVED_NAMES.has(host)) return true;
  return RESERVED_SUFFIXES.some(suffix => host.endsWith(suffix));
}

const LOCAL_FETCH_SCHEMES = new Set(["data:", "blob:", "file:"]);
const NETWORK_SCHEMES = new Set(["http:", "https:", "ws:", "wss:"]);

function urlHostAllowed(raw: string | URL): { allowed: boolean; label: string; parsed: boolean } {
  let url: URL;
  try { url = typeof raw === "string" ? new URL(raw) : raw; } catch { return { allowed: true, label: "", parsed: false }; }
  if (LOCAL_FETCH_SCHEMES.has(url.protocol)) return { allowed: true, label: url.protocol, parsed: true };
  // Any other scheme Bun can fetch (s3:) reaches the network without a host this guard can judge.
  if (!NETWORK_SCHEMES.has(url.protocol)) return { allowed: false, label: url.protocol + "//" + url.host, parsed: true };
  return { allowed: isTestEgressAllowed(url.hostname), label: url.protocol + "//" + url.hostname, parsed: true };
}

/** A proxy option that actually routes the request; null, false, "" and absent mean none. */
function hasExplicitProxy(proxy: unknown): boolean {
  return proxy !== undefined && proxy !== null && proxy !== false && proxy !== "";
}

function proxyAllowed(proxy: unknown): boolean {
  if (!hasExplicitProxy(proxy)) return false;
  const raw = typeof proxy === "string" ? proxy : typeof proxy === "object" && proxy !== null && "url" in proxy ? String((proxy as { url: unknown }).url) : null;
  if (raw === null) return false;
  try { return isTestEgressAllowed(new URL(raw).hostname); } catch { return false; }
}

function refusal(label: string): TypeError {
  return Object.assign(new TypeError("test network guard refused " + label + " (#8848): mock this request or use a loopback fixture"), { code: "ECONNREFUSED" });
}

function connectTarget(args: unknown[]): { host?: string; path?: string } {
  const first = Array.isArray(args[0]) ? args[0][0] : args[0];
  if (first !== null && typeof first === "object") {
    const options = first as { host?: unknown; path?: unknown };
    if (typeof options.path === "string" && options.path !== "") return { path: options.path };
    return { host: typeof options.host === "string" ? options.host : undefined };
  }
  if (typeof first === "string" && !/^\d+$/.test(first)) return { path: first };
  const second = Array.isArray(args[0]) ? undefined : args[1];
  return { host: typeof second === "string" ? second : undefined };
}

type GuardedInit = RequestInit & { proxy?: unknown; unix?: unknown };

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 20;
const BODY_HEADERS = ["content-type", "content-length", "content-encoding", "content-language", "content-location"];

/**
 * Follow redirects one hop at a time so every destination passes the guard: real fetch follows
 * them internally, past both this wrapper and the patched socket API, so a loopback fixture that
 * redirected to a public host would otherwise carry the request off the machine.
 */
async function followGuardedRedirects(realFetch: typeof fetch, self: unknown, start: Request, init: GuardedInit | undefined, label: string): Promise<Response> {
  const { method: _method, headers: _headers, body: _body, redirect: _redirect, ...extras } = init ?? {};
  let request = start;
  for (let hop = 0; ; hop++) {
    const replay = request.clone();
    const response = await realFetch.call(self, request, { ...extras, redirect: "manual" } as RequestInit);
    const location = response.headers.get("location");
    if (!REDIRECT_STATUSES.has(response.status) || location === null) {
      if (hop > 0) Object.defineProperty(response, "redirected", { value: true });
      return response;
    }
    await response.body?.cancel();
    const next = new URL(location, request.url);
    const target = urlHostAllowed(next);
    if (!target.allowed) throw refusal(target.label + " (redirected from " + label + ")");
    if (hop >= MAX_REDIRECTS) throw new TypeError("fetch: too many redirects");
    const toGet = response.status === 303
      ? replay.method !== "GET" && replay.method !== "HEAD"
      : (response.status === 301 || response.status === 302) && replay.method === "POST";
    const headers = new Headers(replay.headers);
    if (toGet) for (const name of BODY_HEADERS) headers.delete(name);
    // A cross-origin hop drops credentials, as the Fetch standard does.
    if (next.origin !== new URL(request.url).origin) headers.delete("authorization");
    request = new Request(next, {
      method: toGet ? "GET" : replay.method,
      headers,
      body: toGet ? null : replay.body,
      signal: replay.signal,
      duplex: "half",
    } as RequestInit);
  }
}

/** Preload file for child Bun processes, which never run tests/preload.ts. */
export const NETWORK_EGRESS_GUARD_PRELOAD = join(import.meta.dir, "network-egress-guard-preload.ts");

/** Install the guard once per process; later calls are no-ops. */
export function installNetworkEgressGuard(): void {
  const registry = globalThis as unknown as Record<symbol, boolean>;
  if (registry[INSTALLED]) return;
  registry[INSTALLED] = true;

  const realFetch = globalThis.fetch;
  const guardedFetch = async function (this: unknown, input: RequestInfo | URL, init?: GuardedInit): Promise<Response> {
    const raw = input instanceof Request ? input.url : input instanceof URL ? input : String(input);
    const proxied = hasExplicitProxy(init?.proxy);
    // A public proxy receives the request line and headers whatever the target is.
    if (proxied && !proxyAllowed(init?.proxy)) throw refusal("a non-loopback proxy");
    const first = urlHostAllowed(raw);
    if (!first.allowed && !init?.unix && !proxied) throw refusal(first.label);
    const mode = init?.redirect ?? (input instanceof Request ? input.redirect : "follow");
    // Through a loopback proxy or a Unix socket every hop stays on this machine; an unparseable URL
    // keeps real fetch's own error.
    if (mode !== "follow" || proxied || init?.unix || !first.parsed) return realFetch.call(this, input, init);
    return followGuardedRedirects(realFetch, this, new Request(input as RequestInfo, init), init, first.label);
  };
  Object.assign(guardedFetch, realFetch);
  globalThis.fetch = guardedFetch as typeof fetch;

  const RealWebSocket = globalThis.WebSocket;
  class GuardedWebSocket extends RealWebSocket {
    constructor(url: string | URL, options?: unknown) {
      const opts = options as { proxy?: unknown } | string | string[] | undefined;
      const proxy = opts !== null && typeof opts === "object" && !Array.isArray(opts) ? opts.proxy : undefined;
      const allowed = hasExplicitProxy(proxy) ? proxyAllowed(proxy) : urlHostAllowed(url).allowed;
      super(allowed ? url : REFUSED_WEBSOCKET_URL, options as never);
    }
  }
  globalThis.WebSocket = GuardedWebSocket as typeof WebSocket;

  const realConnect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function (this: net.Socket, ...args: unknown[]) {
    const target = connectTarget(args);
    if (target.path !== undefined || isTestEgressAllowed(target.host)) {
      return (realConnect as (...a: unknown[]) => net.Socket).apply(this, args);
    }
    const error = refusal("tcp://" + target.host);
    process.nextTick(() => this.destroy(error));
    return this;
  } as typeof net.Socket.prototype.connect;
}

