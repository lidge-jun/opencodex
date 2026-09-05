import type { OcxConfig } from "../types";
import type { DataPlaneAdmission } from "../server/auth-cors";
import { NATIVE_RESERVE_MODEL } from "./catalog/native-models";

export const CODEX_RESERVE_HELPER_UNSUPPORTED_MESSAGE =
  "Luna Reserve compatibility is only available as a conversation model, not a vision helper. Choose another vision model.";

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
