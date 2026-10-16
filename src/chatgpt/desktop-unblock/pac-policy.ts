import { lookup } from "node:dns";
import { isIP } from "node:net";
import wasmPath from "quickjs-wasi/quickjs.wasm" with { type: "file" };
import { spawnWorker } from "../../lib/worker-embed";
import { PAC_LIMITS, ipv4Number, validDnsName } from "./pac-helpers";

export interface RuntimePacPolicy {
  resolve(url: string, signal?: AbortSignal): Promise<readonly (string | null)[]>;
  close(): void;
}

/** Tests may only tighten resource limits. No seam supplies guest code or host globals. */
export interface RuntimePacPolicyOptions {
  cpuMs?: number;
  heapBytes?: number;
  wallMs?: number;
  startupMs?: number;
  dnsMs?: number;
  queueLimit?: number;
  lookup?: (host: string, signal: AbortSignal) => Promise<string | null>;
}

/** Validate the entire chain before a caller is allowed to attempt its first route. */
export function parsePacRoutes(value: unknown): readonly (string | null)[] {
  if (typeof value !== "string" || !value || Buffer.byteLength(value) > PAC_LIMITS.resultBytes) {
    throw new Error("Invalid PAC route result");
  }
  const tokens = value.split(";");
  if (tokens.length > PAC_LIMITS.routes) throw new Error("PAC route chain exceeds its limit");
  const routes = tokens.map(token => {
    const trimmed = token.trim();
    if (trimmed === "DIRECT") return null;
    const match = /^(PROXY|HTTPS|SOCKS5) ([^\s;]+)$/.exec(trimmed);
    if (!match) throw new Error("Unsupported or malformed PAC route");
    const address = /^(\[[^\]]+\]|[^:]+):([1-9]\d{0,4})$/.exec(match[2]!);
    if (!address || +address[2]! > 65535) throw new Error("Invalid PAC proxy address");
    const rawHost = address[1]!;
    let host: string;
    if (rawHost.startsWith("[")) {
      if (isIP(rawHost.slice(1, -1)) !== 6) throw new Error("Invalid PAC proxy address");
      host = new URL(`http://${rawHost}/`).hostname;
    } else {
      if (!validDnsName(rawHost)) throw new Error("Invalid PAC proxy address");
      host = rawHost.toLowerCase();
      // WHATWG's legacy numeric IPv4 parsing must never change a PAC endpoint.
      if (new URL(`http://${host}/`).hostname !== host) throw new Error("Noncanonical PAC proxy address");
    }
    const protocol = match[1] === "PROXY" ? "http" : match[1] === "HTTPS" ? "https" : "socks5";
    return `${protocol}://${host}:${address[2]}`;
  });
  return Object.freeze(routes);
}

function bounded(value: number | undefined, maximum: number): number {
  if (value === undefined) return maximum;
  if (!Number.isInteger(value) || value < 1 || value > maximum) throw new Error("Invalid PAC resource limit");
  return value;
}

function nativeLookup(host: string, signal: AbortSignal): Promise<string | null> {
  // getaddrinfo follows the operating system resolver (including hosts/scoped DNS).
  // Its native operation cannot be cancelled. Cancellation rejects the policy, which
  // is permanently poisoned; no later operation can be started by that policy.
  return new Promise((resolve, reject) => {
    const abort = () => reject(new Error("PAC DNS lookup cancelled"));
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) { abort(); return; }
    lookup(host, { family: 4 }, (error, address) => {
      signal.removeEventListener("abort", abort);
      if (signal.aborted) return;
      // ENOTFOUND also covers non-DNS failures on some platforms. Do not guess that
      // it is a harmless negative response and let isResolvable choose DIRECT.
      if (error) reject(new Error("PAC system DNS lookup failed"));
      else resolve(address);
    });
  });
}

function pacUrl(raw: string): { url: string; host: string } {
  if (typeof raw !== "string" || Buffer.byteLength(raw) > PAC_LIMITS.inputBytes) throw new Error("Invalid PAC request URL");
  const url = new URL(raw);
  if (!["http:", "https:", "ws:", "wss:"].includes(url.protocol)) throw new Error("Unsupported PAC request scheme");
  url.username = ""; url.password = ""; url.hash = "";
  if (url.protocol === "https:" || url.protocol === "wss:") { url.pathname = "/"; url.search = ""; }
  return { url: url.href, host: url.hostname.replace(/^\[|\]$/g, "") };
}

interface Pending {
  id: number;
  url: string;
  host: string;
  finish(value?: readonly (string | null)[], error?: Error): void;
}

export async function createRuntimePacPolicy(source: string, options: RuntimePacPolicyOptions = {}): Promise<RuntimePacPolicy> {
  if (typeof source !== "string" || !source.trim() || Buffer.byteLength(source) > PAC_LIMITS.sourceBytes) {
    throw new Error("Invalid or oversized PAC source");
  }
  const limits = {
    heapBytes: bounded(options.heapBytes, PAC_LIMITS.heapBytes),
    cpuMs: bounded(options.cpuMs, PAC_LIMITS.cpuMs), wallMs: bounded(options.wallMs, PAC_LIMITS.wallMs),
    startupMs: bounded(options.startupMs, PAC_LIMITS.startupMs), dnsMs: bounded(options.dnsMs, PAC_LIMITS.dnsMs),
    queue: bounded(options.queueLimit, PAC_LIMITS.queue),
  };
  const wasm = await Bun.file(wasmPath).arrayBuffer();
  const worker = spawnWorker(new URL("./pac-worker.ts", import.meta.url).href, "pac-worker");
  let failure: Error | undefined, ready = false, nextId = 1, active: Pending | undefined;
  let dnsController: AbortController | undefined;
  let dnsCalls = 0;
  const pending: Pending[] = [];
  let startupResolve: () => void, startupReject: (error: Error) => void;
  const started = new Promise<void>((resolve, reject) => { startupResolve = resolve; startupReject = reject; });
  const startupTimer = setTimeout(() => poison(new Error("PAC startup deadline exceeded")), limits.startupMs);
  function poison(error: Error): void {
    if (failure) return;
    failure = error;
    clearTimeout(startupTimer);
    dnsController?.abort(); dnsController = undefined;
    startupReject(error);
    active?.finish(undefined, error); active = undefined;
    for (const item of pending.splice(0)) item.finish(undefined, error);
    worker.terminate();
  }
  function dispatch(): void {
    if (failure || !ready || active || !pending.length) return;
    active = pending.shift()!; dnsCalls = 0;
    worker.postMessage({ type: "resolve", id: active.id, url: active.url, host: active.host });
  }
  worker.onerror = event => { event.preventDefault(); poison(new Error("PAC worker failed")); };
  worker.addEventListener("close", () => { if (!failure) poison(new Error("PAC worker closed unexpectedly")); });
  worker.onmessage = (event: MessageEvent) => {
    if (failure) return;
    const data = event.data;
    if (data?.type === "ready" && !ready) {
      ready = true; clearTimeout(startupTimer); startupResolve(); return;
    }
    if (data?.type === "error") { poison(new Error("PAC evaluation failed or used unsupported semantics")); return; }
    if (!active || data?.id !== active.id) { poison(new Error("Invalid PAC worker response")); return; }
    if (data.type === "dns") {
      if (dnsController || ++dnsCalls > PAC_LIMITS.dnsCalls || typeof data.host !== "string"
        || !validDnsName(data.host) || !(data.shared instanceof SharedArrayBuffer) || data.shared.byteLength !== 264) {
        poison(new Error("Invalid PAC DNS request")); return;
      }
      const shared = new Int32Array(data.shared, 0, 2), bytes = new Uint8Array(data.shared, 8);
      const controller = new AbortController(); dnsController = controller;
      const timeout = setTimeout(() => poison(new Error("PAC DNS deadline exceeded")), limits.dnsMs);
      Promise.resolve().then(() => (options.lookup ?? nativeLookup)(data.host, controller.signal)).then(address => {
        if (failure || controller.signal.aborted) return;
        if (address !== null && (typeof address !== "string" || ipv4Number(address) === null)) throw new Error("Invalid PAC DNS answer");
        const encoded = new TextEncoder().encode(address ?? "");
        bytes.set(encoded); Atomics.store(shared, 1, encoded.length);
        Atomics.store(shared, 0, address === null ? 2 : 1); Atomics.notify(shared, 0);
      }).catch(() => poison(new Error("PAC DNS lookup failed"))).finally(() => {
        clearTimeout(timeout);
        if (dnsController === controller) dnsController = undefined;
      });
      return;
    }
    if (data.type !== "result" || dnsController) { poison(new Error("Invalid PAC worker result")); return; }
    try {
      const routes = parsePacRoutes(data.value);
      active.finish(routes); active = undefined; dispatch();
    } catch { poison(new Error("PAC returned an invalid route chain")); }
  };
  worker.postMessage({ type: "init", source, wasm, limits }, [wasm]);
  await started;
  return {
    resolve(raw, signal) {
      if (failure) return Promise.reject(failure);
      return new Promise((resolve, reject) => {
        let parsed: { url: string; host: string };
        try { parsed = pacUrl(raw); } catch { poison(new Error("Invalid PAC request URL")); reject(failure); return; }
        if (signal?.aborted) { poison(new Error("PAC request aborted")); reject(failure); return; }
        if (pending.length + Number(!!active) >= limits.queue) { poison(new Error("PAC queue limit exceeded")); reject(failure); return; }
        const abort = () => poison(new Error("PAC request aborted"));
        const timer = setTimeout(() => poison(new Error("PAC request deadline exceeded")), limits.wallMs);
        signal?.addEventListener("abort", abort, { once: true });
        pending.push({ id: nextId++, ...parsed, finish(value, error) {
          clearTimeout(timer); signal?.removeEventListener("abort", abort);
          if (error) reject(error); else resolve(value!);
        } });
        dispatch();
      });
    },
    close() { poison(new Error("PAC policy is closed")); },
  };
}
