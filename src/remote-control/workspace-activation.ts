import type { OcxConfig } from "../types";

/** Side-effect-free opt-in; never creates a store, probes a runtime, or opens a listener. */
export function remoteWorkspaceEnabled(
  config: Pick<OcxConfig, "runtimeRole">,
  enabled = process.env.OCX_REMOTE_WORKSPACE_ENABLED,
): boolean {
  return config.runtimeRole === "hub" && enabled === "1";
}
