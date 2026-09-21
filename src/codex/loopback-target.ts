import type { OcxConfig } from "../types";
import type { DataPlaneAdmission } from "../server/auth-cors";
import { NATIVE_RESERVE_MODEL } from "./catalog/native-models";

export const CODEX_RESERVE_HELPER_UNSUPPORTED_MESSAGE =
  "Luna Reserve compatibility is only available as a conversation model, not a vision helper. Choose another vision model.";

export const CODEX_RESERVE_OPT_IN_REQUIRED_MESSAGE =
  "Luna Reserve (gpt-reserve) is not forwarded without the local Desktop authless opt-in."
  + " OpenCodex holds no Reserve entitlement to send for this request, so the upstream would answer with a"
  + " usage-limit error that names neither the cause nor the fix."
  + " Enable the opt-in with 'ocx system settings --desktop-authless on' (or set codexDesktopAuthless to true"
  + " in config.json), then retry. Choose another model to keep working without it.";

/**
 * Strict complement of {@link isCodexReserveRequestEligible} for the FLAG reason ONLY (#4940).
 *
 * Read the two together. This answers a narrower question: Reserve was asked for, every ingress
 * condition eligibility requires already holds, and the single missing piece is the operator
 * opt-in. Flipping `codexDesktopAuthless` to true therefore always turns a true here into a true
 * from {@link isCodexReserveRequestEligible}, which is what makes it honest for the refusal to
 * name that one setting. The other two ineligibility reasons are deliberately not covered: a
 * client role and a non-loopback admission source are different situations, and the correct
 * answer for both is still to forward exactly as before.
 *
 * Callers classify the concrete destination as canonical forward before using this predicate, the
 * same obligation {@link isCodexReserveHelperUnsupported} carries. An operator who has aliased or
 * routed `gpt-reserve` onto some other provider owns a path that works, and it must keep working.
 */
export function isCodexReserveOptInMissing(
  config: Pick<OcxConfig, "codexDesktopAuthless" | "runtimeRole">,
  modelId: string,
  admission: Pick<DataPlaneAdmission, "source"> | undefined,
): boolean {
  return modelId === NATIVE_RESERVE_MODEL && config.codexDesktopAuthless !== true
    && config.runtimeRole !== "client" && admission?.source === "loopback";
}

/** Callers classify the concrete destination as canonical forward before using this predicate. */
export function isCodexReserveHelperUnsupported(
  config: Pick<OcxConfig, "codexDesktopAuthless" | "runtimeRole">,
  modelId: string,
  admission: Pick<DataPlaneAdmission, "source"> | undefined,
  terminalHelper: boolean,
): boolean {
  return terminalHelper && modelId === NATIVE_RESERVE_MODEL && isCodexReserveRequestEligible(config, admission);
}

/** Runtime authority comes from the receiving listener, not the catalog's injection target. */
export function isCodexReserveRequestEligible(
  config: Pick<OcxConfig, "codexDesktopAuthless" | "runtimeRole">,
  admission: Pick<DataPlaneAdmission, "source"> | undefined,
): boolean {
  return config.codexDesktopAuthless === true && config.runtimeRole !== "client"
    && admission?.source === "loopback";
}

/** Bind scope, not the dial address: wildcard listeners are never loopback-only. */
export function isLoopbackHostname(hostname: string | undefined): boolean {
  const normalized = (hostname ?? "127.0.0.1").trim().toLowerCase().replace(/\.$/, "");
  return (
    normalized === "" ||
    normalized === "localhost" ||
    normalized === "127.0.0.1" ||
    normalized === "::1" ||
    normalized === "[::1]"
  );
}

/**
 * Bind scope again, from the other side: a wildcard listener already answers on 127.0.0.1.
 *
 * This matters only for the port-less "companion" loopback listener. On `0.0.0.0`/`::` the
 * public socket owns loopback on that port, so a companion bound to the same port would
 * collide; on a specific non-loopback address (a tailnet or LAN IP) 127.0.0.1 is free.
 */
export function isWildcardHostname(hostname: string | undefined): boolean {
  const normalized = (hostname ?? "").trim().toLowerCase().replace(/\.$/, "").replace(/^\[(.*)\]$/, "$1");
  if (normalized === "*" || normalized === "0") return true;
  // Every spelling of the IPv4 unspecified address ("0.0.0.0", "00.0.0.000", …).
  if (/^(0+\.){3}0+$/.test(normalized)) return true;
  // Every spelling of the IPv6 unspecified address ("::", "::0", "0::", "0:0:0:0:0:0:0:0", …):
  // nothing but zero groups and colons. A dual-stack `::` bind answers on 127.0.0.1 as well.
  return normalized.includes(":") && /^[0:]+$/.test(normalized);
}

/**
 * Is `{ enabled: true }` with no port legal for this bind address?
 *
 * The companion form binds `127.0.0.1:<proxy port>`, which is exactly the one-port hub shape:
 * remote clients dial `hostname:port`, local processes dial `127.0.0.1:port`, and every
 * hardcoded `http://127.0.0.1:<proxy port>` integration works with no rewriting. It is legal
 * only when the public listener is NOT already holding that loopback address.
 */
export function loopbackCompanionAllowed(hostname: string | undefined): boolean {
  return !isLoopbackHostname(hostname) && !isWildcardHostname(hostname);
}

/**
 * The port local callers reach the unauthenticated listener on, or null when it is off.
 *
 * One resolver for every reader (#4236): an enabled listener with no `port` is the companion
 * form and answers on the public port. Callers must not repeat `?? port` — the day the default
 * changes, a forgotten site points a client config at a closed socket.
 */
export function effectiveLoopbackListenerPort(
  config: Pick<OcxConfig, "unauthenticatedLoopbackListener"> | undefined,
  publicPort: number,
): number | null {
  const listener = config?.unauthenticatedLoopbackListener;
  if (!listener?.enabled) return null;
  return listener.port ?? publicPort;
}

export function shouldInjectApiAuthHeader(
  config: Pick<OcxConfig, "hostname" | "unauthenticatedLoopbackListener"> | undefined,
): boolean {
  // The dedicated listener binds loopback and does not require an admission credential.
  if (config?.unauthenticatedLoopbackListener?.enabled) return false;
  return !isLoopbackHostname(config?.hostname);
}

/** Match standalone injection, never a remote client's independently supplied routing target. */
export function isEffectiveCodexDesktopAuthless(
  config: Pick<OcxConfig, "runtimeRole" | "hostname" | "unauthenticatedLoopbackListener" | "codexDesktopAuthless"> | undefined,
): boolean {
  return config?.codexDesktopAuthless === true
    && config.runtimeRole !== "client"
    && !shouldInjectApiAuthHeader(config);
}

/** Keep reporting aligned with the admission-token gate used by standalone injection. */
export function isEffectiveCodexClientCompaction(
  config: Pick<OcxConfig, "runtimeRole" | "hostname" | "unauthenticatedLoopbackListener" | "codexClientCompaction"> | undefined,
): boolean {
  return config?.codexClientCompaction === true
    && config.runtimeRole !== "client"
    && !shouldInjectApiAuthHeader(config);
}
