import { randomUUID } from "node:crypto";
import { basename, join } from "node:path";
import { getConfigDir } from "../../config/paths";
import { issueServerLeaf } from "../../claude/intercept/local-ca";
import { startConnectProxy, type ConnectProxyHandle } from "../../claude/intercept/connect-proxy";
import { didRunOptionalShutdownHooks, registerOptionalShutdownHook } from "../../lib/optional-shutdown-hooks";
import { isTestHomeGuardArmed } from "../../lib/test-home-guard";
import { desktopOutboundFetch, desktopProxyFor } from "../../lib/desktop-proxy-route";
import { windowsDefaultExec, windowsDesktopAppAdapter } from "../desktop-app/windows";
import { inspectDesktopCompatibilityAuthority, loadDesktopCompatibilityAuthority, type StoredDesktopAuthority } from "./certificate-store";
import { inspectWindowsCertificateTrust } from "./windows-certificate-trust";
import { createNativeIdentityReader } from "./native-identity";
import { UsageRelayController, type UsageIdentity } from "./usage-controller";
import { createUsageControlledFetch } from "./usage-controlled-fetch";
import { startDesktopRelay } from "./relay-listener";
import { launchWindowsCodexCompatibility } from "./windows-package-launch";
import { acquireDesktopCompatibilityRuntime } from "./runtime-ownership";
import { createDesktopConnectionStore, type DesktopConnectionStore } from "./connection-store";
import { createNativeRoutingVerifier } from "./routing-preflight";

// Reviewed usage.snapshot v1/cache/composer contract. A new build needs a new assessment.
export const DESKTOP_COMPATIBILITY_ASSESSED_VERSION = "26.924.2738.0";
export function isAssessedDesktopInstalled(): boolean {
  const install = windowsDesktopAppAdapter.discover(windowsDefaultExec);
  return !!install && basename(install.root).startsWith(`OpenAI.Codex_${DESKTOP_COMPATIBILITY_ASSESSED_VERSION}_`);
}
export interface DesktopRuntimeIo {
  platform?: string;
  loadAuthority?: () => Promise<StoredDesktopAuthority>;
  trust?: (authority: StoredDesktopAuthority) => Promise<"trusted" | "not-trusted" | "unknown">;
  identity?: ReturnType<typeof createNativeIdentityReader>;
  buildSupported?: () => boolean;
  upstreamFetch?: typeof fetch;
  connectionStore?: DesktopConnectionStore;
  routingSupported?: () => boolean;
  /** Synthetic-test execution is admitted only with explicit fixture identity and CA seams. */
  testOnly?: boolean;
}

/** Optional runtime. Import/construction/status do not start listeners or touch credentials. */
export function createDesktopCompatibilityRuntime(io: DesktopRuntimeIo = {}) {
  const platform = io.platform ?? process.platform;
  const buildSupported = io.buildSupported ?? isAssessedDesktopInstalled;
  let routingSupported = io.routingSupported ?? (() => false);
  let contextFailure: "build_unverified" | "native_routing_unverified" | null = null;
  const contextValid = () => {
    try { contextFailure = !routingSupported() ? "native_routing_unverified" : !buildSupported() ? "build_unverified" : null; }
    catch { contextFailure = "build_unverified"; }
    return contextFailure === null;
  };
  let phase: "off" | "starting" | "running" | "stopping" | "cleanup-required" = "off";
  let owned: { controller: UsageRelayController; close(): Promise<void>; pacUrl: string; fingerprint: string; deadline: number } | null = null;
  let closing: Promise<void> | null = null;
  let pendingCleanup: (() => Promise<void>) | null = null;
  let releaseOwner: (() => void) | null = null;
  const status = () => ({ phase, supported: platform === "win32", running: owned !== null, contextFailure,
    ...(owned ? { fingerprint: owned.fingerprint, safetyDeadline: owned.deadline, usage: owned.controller.snapshot() } : {}) });
  async function stop(): Promise<ReturnType<typeof status>> {
    if (phase === "starting") throw new Error("desktop_compatibility_busy");
    if (closing) { await closing; return status(); }
    if (!pendingCleanup) return status();
    phase = "stopping";
    closing = pendingCleanup().then(() => { owned = null; pendingCleanup = null; phase = "off"; releaseOwner?.(); releaseOwner = null; })
      .catch(error => { phase = "cleanup-required"; throw error; }).finally(() => { closing = null; });
    await closing; return status();
  }
  async function start() {
    if (phase !== "off") throw new Error("desktop_compatibility_busy");
    if (platform !== "win32") throw new Error("desktop_compatibility_unsupported");
    if (isTestHomeGuardArmed() && !(io.testOnly && io.identity && io.loadAuthority && io.trust && io.buildSupported && io.connectionStore && io.routingSupported)) throw new Error("desktop_compatibility_test_environment");
    if (didRunOptionalShutdownHooks()) throw new Error("desktop_compatibility_stopping");
    if (!buildSupported()) throw new Error("desktop_compatibility_build_unverified");
    try { desktopProxyFor(new URL("https://chatgpt.com")); } catch { throw new Error("desktop_compatibility_egress_proxy_invalid"); }
    releaseOwner = acquireDesktopCompatibilityRuntime(); phase = "starting";
    let relay: Awaited<ReturnType<typeof startDesktopRelay>> | undefined, proxy: ConnectProxyHandle | undefined;
    let pac: ReturnType<typeof Bun.serve> | undefined, timer: ReturnType<typeof setInterval> | undefined;
    let detach: (() => void) | undefined, controller: UsageRelayController | undefined;
    const cleanup = async () => {
      if (timer) clearInterval(timer); detach?.();
      // Abort transport before awaiting stream refresh so a stuck reader cannot retain sockets.
      const results = await Promise.allSettled([pac?.stop(true), proxy?.close(), relay?.close(), controller?.observeOnly()]);
      if (results.some(result => result.status === "rejected")) throw new Error("desktop_compatibility_cleanup_incomplete");
    };
    pendingCleanup = cleanup;
    try {
      if (!io.routingSupported) routingSupported = createNativeRoutingVerifier((await import("../paths")).getCodexHome());
      if (!contextValid()) throw new Error(`desktop_compatibility_${contextFailure}`);
      const directory = join(getConfigDir(), "codex-desktop-compatibility");
      if (!io.loadAuthority) {
        const saved = inspectDesktopCompatibilityAuthority(directory);
        if (saved.status === "missing") throw new Error("desktop_compatibility_certificate_not_prepared");
        if (saved.status === "invalid") throw new Error("desktop_compatibility_certificate_invalid");
        if (saved.status === "expired") throw new Error("desktop_compatibility_certificate_expired");
      }
      const authority = await (io.loadAuthority?.() ?? loadDesktopCompatibilityAuthority({ directory }));
      const trust = await (io.trust?.(authority) ?? inspectWindowsCertificateTrust(authority.authority.certPem, authority.fingerprint));
      if (trust !== "trusted") throw new Error("desktop_compatibility_trust_required");
      const connections = io.connectionStore ?? createDesktopConnectionStore(directory);
      const previousConnection = connections.read();
      const deadline = authority.expiresAt - 300_000;
      if (deadline <= Date.now()) throw new Error("desktop_compatibility_certificate_expiring");
      const identity = io.identity ?? createNativeIdentityReader(join((await import("../paths")).getCodexHome(), "auth.json"), desktopOutboundFetch as typeof fetch);
      const account: UsageIdentity | null = await identity.verifyFreshIdentity();
      if (!account) throw new Error("desktop_compatibility_native_identity_unverified");
      if (didRunOptionalShutdownHooks()) throw new Error("desktop_compatibility_stopping");
      controller = new UsageRelayController(account, identity.readCurrentIdentity, identity.verifyFreshIdentity, Date.now, deadline, 180000, contextValid);
      relay = await startDesktopRelay({ leaf: issueServerLeaf(authority.authority, authority.commonName, ["chatgpt.com"]),
        fetchImpl: createUsageControlledFetch(controller, io.upstreamFetch ?? desktopOutboundFetch as typeof fetch) });
      try { proxy = await startConnectProxy(previousConnection?.connectPort ?? 0, { interceptPort: relay.port, interceptHosts: ["chatgpt.com"], allowedTargets: ["chatgpt.com:443"] }); }
      catch { throw new Error("desktop_compatibility_connection_unavailable"); }
      const runId = previousConnection?.id ?? randomUUID(), proxyPort = proxy.port;
      try { pac = Bun.serve({ hostname: "127.0.0.1", port: previousConnection?.pacPort ?? 0, fetch(req) {
        const url = new URL(req.url);
        if (req.method !== "GET" || req.headers.has("origin") || url.origin !== `http://127.0.0.1:${pac!.port}` || url.pathname !== `/${runId}/proxy.pac`) return new Response(null, { status: 404 });
        return new Response(`function FindProxyForURL(url, host) { return Date.now() < ${deadline} && host.toLowerCase() === "chatgpt.com" && url.indexOf("https:") === 0 ? "PROXY 127.0.0.1:${proxyPort}; DIRECT" : "DIRECT"; }`,
          { headers: { "content-type": "application/x-ns-proxy-autoconfig", "cache-control": "no-store" } });
      } }); } catch { throw new Error("desktop_compatibility_connection_unavailable"); }
      const connection = await connections.publish({ version: 1, id: runId, connectPort: proxyPort, pacPort: pac.port! });
      if (connection.id !== runId || connection.connectPort !== proxyPort || connection.pacPort !== pac.port) throw new Error("desktop_compatibility_connection_changed");
      if (didRunOptionalShutdownHooks()) throw new Error("desktop_compatibility_stopping");
      const active = controller; let ticking = false, deadlineHandled = false, lastContextCheck = 0;
      timer = setInterval(() => {
        if (ticking) return; ticking = true;
        const expired = Date.now() >= deadline;
        if (active.snapshot().mode === "apply" && Date.now() - lastContextCheck >= 10000) {
          lastContextCheck = Date.now();
          if (!contextValid()) { void active.observeOnly().catch(() => {}).finally(() => { ticking = false; }); return; }
        }
        const work = expired && !deadlineHandled ? (deadlineHandled = true, active.observeOnly()) : active.expireIfNeeded();
        void work.catch(() => {}).finally(() => { ticking = false; });
      }, 1000); timer.unref();
      owned = { controller, close: cleanup, fingerprint: authority.fingerprint, deadline, pacUrl: `http://127.0.0.1:${pac.port}/${runId}/proxy.pac` };
      phase = "running";
      detach = registerOptionalShutdownHook("codex-desktop-compatibility", () => { void stop().catch(() => {}); });
      return status();
    } catch (error) {
      try { await cleanup(); pendingCleanup = null; phase = "off"; releaseOwner?.(); releaseOwner = null; }
      catch { phase = "cleanup-required"; throw new Error("desktop_compatibility_cleanup_incomplete"); }
      throw error;
    }
  }
  async function apply(accountWideConsent: boolean) {
    const current = owned;
    if (!current || phase !== "running") throw new Error("desktop_compatibility_not_running");
    if (!contextValid()) { await current.controller.observeOnly(); throw new Error(`desktop_compatibility_${contextFailure}`); }
    const result = await current.controller.activate({ scope: "account-ui-compatibility", accountWideConsent });
    if (owned !== current || phase !== "running") { await current.controller.observeOnly(); return { ...result, accepted: false, reason: "runtime-stopped" }; }
    return result;
  }
  return { status, start, stop, apply,
    async observe() { if (owned) await owned.controller.observeOnly(); return status(); },
    launch() {
      if (!owned || phase !== "running") throw new Error("desktop_compatibility_not_running");
      if (!contextValid()) throw new Error(`desktop_compatibility_${contextFailure}`);
      return launchWindowsCodexCompatibility(owned.pacUrl);
    },
    /** Internal native launch context; management status never returns the control endpoint. */
    getPacUrl: () => owned?.pacUrl ?? null,
  };
}
export type DesktopCompatibilityRuntime = ReturnType<typeof createDesktopCompatibilityRuntime>;
