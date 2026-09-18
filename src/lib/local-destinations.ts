/**
 * Where a process running ON THE HUB ITSELF dials the hub (#4236).
 *
 * There are TWO destinations here, not one base URL substituted everywhere, and conflating
 * them is what broke every local integration on a tailnet-bound hub:
 *
 * 1. `localManagementOrigin` — authenticated management discovery/state (`/api/*`). It is
 *    served by the public listener and, on a hub, additionally by the loopback-only
 *    `hub.managementIngress`. Callers must still send a management credential: management
 *    authentication has no loopback bypass (structure/gui-and-management-api.md), and the unauthenticated loopback
 *    listener deliberately does not serve `/api/*` at all.
 * 2. `localInferenceDestination` — the data plane a client wire actually speaks.
 *
 * Both resolvers have the SAME three-branch shape, because the bind address is the thing that
 * decides. The first review of this module got that wrong for inference: it returned
 * `http://127.0.0.1:<public port>` unconditionally whenever the loopback listener was off, so a
 * hub with `hostname: <tailnet IP>` and no listener handed all eight call sites a socket that
 * does not exist. The bind address has to be the fallback, exactly as it already was for
 * management:
 *
 *   loopback listener enabled   → `127.0.0.1:<effective listener port>`, no credential
 *   loopback/absent `hostname`  → `127.0.0.1:<public port>`, no credential
 *   wildcard `hostname`         → `127.0.0.1:<public port>`, ADMISSION CREDENTIAL REQUIRED
 *   anything else               → `<probeHostname(hostname)>:<public port>`, credential REQUIRED
 *
 * A wildcard bind does answer on 127.0.0.1, which is why its origin stays loopback, but the
 * public listener demands data-plane admission regardless of which address received the
 * request — so it lands in the same credential bucket as a tailnet bind. That is why the
 * resolver returns a STRUCT rather than a string: a caller that cannot see
 * `requiresAdmissionToken` cannot tell a free socket from one that will 401, and the only
 * honest answers are "attach the data-plane credential" or "say so in a log line".
 *
 * The credential in question is the DATA-PLANE one — `OPENCODEX_API_AUTH_TOKEN`, the hardened
 * service token file, or a configured `apiKeys` entry, the same ladder
 * `standaloneCodexRoutingTarget` / the Codex provider table already uses. Never the admin
 * token: no exported client configuration may carry management authority (reviewer constraint
 * on #4236).
 */
import { effectiveLoopbackListenerPort, isLoopbackHostname, isWildcardHostname, shouldInjectApiAuthHeader } from "../codex/loopback-target";
import { probeHostname } from "../server/proxy-liveness";
import { loadServiceTokenFromFile, serviceApiTokenFilePath } from "./service-secrets";
import type { OcxConfig } from "../types";

export type LocalInferenceConfig = Pick<OcxConfig, "hostname" | "unauthenticatedLoopbackListener">;
export type LocalManagementConfig = Pick<OcxConfig, "hostname" | "runtimeRole" | "hub">;

export interface LocalInferenceDestination {
  /** Origin a local client wire dials, e.g. `http://127.0.0.1:10104`. */
  origin: string;
  /** Port component of `origin`. */
  port: number;
  /**
   * Does the listener at `origin` demand `x-opencodex-api-key`?
   *
   * False only for the unauthenticated loopback listener and a genuinely loopback public bind.
   * A caller that cannot attach a credential must log that it is degrading rather than write a
   * destination that answers 401.
   */
  requiresAdmissionToken: boolean;
}

/**
 * The one answer for "where does a local client send inference, and does it need a key?".
 *
 * Kept in one place so the day the resolution changes a forgotten site cannot point a client
 * config at a closed socket — which is precisely the defect this module exists to close.
 */
export function localInferenceDestination(
  config: LocalInferenceConfig | undefined,
  publicPort: number,
): LocalInferenceDestination {
  const listenerPort = effectiveLoopbackListenerPort(config, publicPort);
  if (listenerPort !== null) {
    // Always bound to 127.0.0.1 and admits local callers with no credential, which is what
    // lets an exported client configuration stay credential-free.
    return { origin: `http://127.0.0.1:${listenerPort}`, port: listenerPort, requiresAdmissionToken: false };
  }
  const hostname = config?.hostname;
  // A loopback bind keeps the byte-identical string every call site wrote before this module
  // existed, including the `localhost`/`::1` spellings that `probeHostname` would preserve.
  if (isLoopbackHostname(hostname)) {
    return { origin: `http://127.0.0.1:${publicPort}`, port: publicPort, requiresAdmissionToken: false };
  }
  // `probeHostname` turns every all-zero spelling into 127.0.0.1 and brackets a bare IPv6
  // literal; `shouldInjectApiAuthHeader` is the existing encoding of "this bind demands a
  // data-plane credential", so the two stay in agreement by construction.
  return {
    origin: `http://${probeHostname(hostname)}:${publicPort}`,
    port: publicPort,
    requiresAdmissionToken: shouldInjectApiAuthHeader(config),
  };
}

/**
 * Every port this proxy's data plane answers on at 127.0.0.1 — the set an inherited
 * `http://127.0.0.1:<port>` base URL must hit to count as one of OURS.
 *
 * On a tailnet bind with no loopback listener the set is EMPTY, and that is the point: a
 * leftover `http://127.0.0.1:10100` from a previous loopback-bound install is a dead socket
 * there, so `ocx claude` must replace it rather than preserve it as its own destination.
 */
export function localLoopbackInferencePorts(
  config: LocalInferenceConfig | undefined,
  publicPort: number,
): number[] {
  const ports: number[] = [];
  // A wildcard bind owns loopback on the public port too, so a URL naming it is still ours.
  if (isLoopbackHostname(config?.hostname) || isWildcardHostname(config?.hostname)) ports.push(publicPort);
  const listenerPort = effectiveLoopbackListenerPort(config, publicPort);
  if (listenerPort !== null && !ports.includes(listenerPort)) ports.push(listenerPort);
  return ports;
}

/**
 * The DATA-PLANE admission credential this host can present to its own public listener.
 *
 * Same ladder the Codex provider table and `ocx opencode` already use — environment token,
 * hardened service token file, first configured `apiKeys` entry — and deliberately NOT the
 * admin token, which must never leave the management surface. `undefined` means the caller has
 * nothing to attach and has to degrade loudly.
 */
export function localAdmissionToken(
  config: Pick<OcxConfig, "apiKeys"> | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const envToken = env.OPENCODEX_API_AUTH_TOKEN?.trim();
  if (envToken) return envToken;
  const lookup = env.OCX_API_TOKEN_FILE?.trim()
    ? env
    : { ...env, OCX_API_TOKEN_FILE: serviceApiTokenFilePath() };
  const fileToken = loadServiceTokenFromFile(lookup as Record<string, string | undefined>)?.trim();
  // Shape-check the FILE candidate only. The env var and `apiKeys` are values an operator set
  // deliberately and pass through verbatim; a path, by contrast, can be pointed at or replaced
  // by something that is not a credential at all, and sending that as one leaks file contents
  // into a request header. Configured keys are never checked, so no existing key can be broken.
  if (fileToken && ADMISSION_TOKEN_SHAPE.test(fileToken)) return fileToken;
  const configured = config?.apiKeys?.find(entry => entry.key.trim().length > 0)?.key.trim();
  return configured || undefined;
}

/** An admission credential is an opaque printable token — never JSON, a path, or multi-line. */
const ADMISSION_TOKEN_SHAPE = /^[A-Za-z0-9._~+/=-]{8,4096}$/;

/**
 * The origin a local CLI dials for `/api/*`.
 *
 * A hub's management ingress is loopback-only and exists precisely so the operator's own
 * machine has a management address when the proxy listener is bound elsewhere. Everything else
 * keeps dialing the public listener on the bind address it can actually reach — `probeHostname`
 * turns a wildcard bind into 127.0.0.1 and brackets a bare IPv6 literal.
 *
 * The caller still supplies the management credential. Never write that credential into an
 * exported client configuration.
 */
export function localManagementOrigin(
  config: LocalManagementConfig | undefined,
  publicPort: number,
): string {
  const ingress = config?.runtimeRole === "hub" ? config.hub?.managementIngress : undefined;
  if (ingress?.enabled) return `http://127.0.0.1:${ingress.port}`;
  return `http://${probeHostname(config?.hostname)}:${publicPort}`;
}
