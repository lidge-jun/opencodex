import { effectiveProxyFor, noProxyMatches, type ProxyEnvMap } from "../../lib/proxy-env";
import { startCloudEntry } from "./entry";
import { acquireCloudMapping, cloudHelperRequest } from "./helper-client";
import { CLOUD_HOST, CLOUD_HELPER_SOCKET, CloudNetworkError } from "./contract";

export function cloudNetworkProxy(env: ProxyEnvMap = process.env): string {
  const target = new URL(`https://${CLOUD_HOST}`);
  if (noProxyMatches(target, env)) throw new CloudNetworkError("cloud_proxy_bypassed");
  const proxy = effectiveProxyFor(target, env);
  if (!proxy) throw new CloudNetworkError("cloud_proxy_missing");
  const endpoint = new URL(proxy);
  if (endpoint.hostname === CLOUD_HOST || (["localhost", "127.0.0.1", "[::1]"].includes(endpoint.hostname)
    && (endpoint.port || (endpoint.protocol === "https:" ? "443" : "80")) === "443")) {
    throw new CloudNetworkError("cloud_proxy_loop");
  }
  return proxy;
}

/** Config proxy/env resolution is owned by server startup, exactly as for other transports. */
export async function startCloudNetwork(options: {
  env?: ProxyEnvMap;
  /** Injection only: public config/CLI cannot redirect privileged paths or port 443. */
  helperSocket?: string;
  listenPort?: number;
} = {}) {
  const proxy = cloudNetworkProxy(options.env);
  const helperSocket = options.helperSocket ?? CLOUD_HELPER_SOCKET;
  const helper = await cloudHelperRequest("status", helperSocket);
  if (!helper.ok) throw CloudNetworkError.fromReply(helper, "recovery_required");
  if (helper.state === "active") throw new CloudNetworkError("mapping_busy");
  let entry: Awaited<ReturnType<typeof startCloudEntry>>;
  try { entry = await startCloudEntry({ proxy, port: options.listenPort ?? 443 }); }
  catch { throw new CloudNetworkError("cloud_listener_or_upstream_failed"); }
  let mapping: Awaited<ReturnType<typeof acquireCloudMapping>>;
  try { mapping = await acquireCloudMapping(helperSocket); }
  catch (error) { await entry.stop(); throw error; }
  let stopping: Promise<void> | undefined;
  let released = false;
  const lost = mapping.closed.then(async () => {
    if (released) return false;
    await entry.stop();
    return true;
  });
  return {
    endpoints: entry.endpoints,
    lost,
    stop(): Promise<void> {
      return stopping ??= (async () => {
        released = true;
        // Mapping removal is acknowledged before closing listeners during normal shutdown.
        try { await mapping.release(); } finally { await entry.stop(); }
      })();
    },
  };
}

export async function recoverCloudNetwork(): Promise<void> {
  const result = await cloudHelperRequest("recover");
  if (!result.ok) throw CloudNetworkError.fromReply(result, "recovery_required");
}
