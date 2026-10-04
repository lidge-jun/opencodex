import type { OcxConfig } from "../../types";

/**
 * Port and enablement policy for the Claude intercept pair.
 *
 * These are pure functions of config, with no listener, CA, or picker dependency. They live
 * apart from `./runtime` because the first-party Desktop path reads them too: importing them
 * from `./runtime` made `desktop-first-party` reach the picker runtime, which reaches
 * `desktop-first-party` back. Keeping the policy in a leaf keeps that pair acyclic.
 */

export const CLAUDE_INTERCEPT_PORT_OFFSET = 100;

export function claudeInterceptEnabled(config: Pick<OcxConfig, "claudeCode" | "runtimeRole">): boolean {
  if (config.runtimeRole === "client") return false;
  if (config.claudeCode?.enabled === false) return false;
  return config.claudeCode?.intercept?.enabled !== false;
}

export function claudeInterceptProxyPort(config: Pick<OcxConfig, "claudeCode">, publicPort: number): number {
  const configured = config.claudeCode?.intercept?.port;
  if (typeof configured === "number" && Number.isInteger(configured) && configured >= 1 && configured <= 65535) return configured;
  return publicPort + CLAUDE_INTERCEPT_PORT_OFFSET;
}

/** Desktop's egress proxy for picker mode: the port after the intercept proxy (before it at 65535). */
export function claudePickerProxyPort(config: Pick<OcxConfig, "claudeCode">, publicPort: number): number {
  const interceptPort = claudeInterceptProxyPort(config, publicPort);
  return interceptPort < 65535 ? interceptPort + 1 : interceptPort - 1;
}
