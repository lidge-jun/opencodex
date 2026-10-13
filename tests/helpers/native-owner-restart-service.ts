/** The native-owner fixture must not enumerate or restart the operator's desktop. */
import type {
  CodexAppServerStateResponse,
  CodexRestartResponse,
} from "../../src/lib/codex-restart-contract";

export const NATIVE_OWNER_RESTART_REFUSAL = "Codex desktop restart is disabled in the native-owner fixture";

/** Complete service injection: neither state reads nor restart requests reach production I/O. */
export const nativeOwnerRestartService = Object.freeze({
  async readState(): Promise<CodexAppServerStateResponse> {
    return { state: "unknown", runningCount: 0 };
  },
  async performRestart(): Promise<CodexRestartResponse> {
    throw new Error(NATIVE_OWNER_RESTART_REFUSAL);
  },
});
