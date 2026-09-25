import type { OcxConfig } from "../types";
import { shouldSyncCodexOnStart } from "./desired-state";
import {
  isEffectiveCodexClientCompaction,
  isEffectiveCodexDesktopAuthless,
} from "./loopback-target";

export type CodexDesktopSwitchInertReason =
  | "client_role"
  | "non_loopback_bind_requires_admission_token";

export interface CodexDesktopSwitchState {
  stored: boolean;
  effective: boolean;
  inertReason?: CodexDesktopSwitchInertReason;
}

export type CodexDesktopSwitchApplyReason =
  | "not_requested"
  | "proxy_not_running"
  | "integration_disabled"
  | "write_lock_busy"
  | "injection_refused";

export type CodexDesktopSwitchApply =
  | { applied: true }
  | {
      applied: false;
      reason: CodexDesktopSwitchApplyReason;
      retryable: boolean;
      detail?: string;
    };

export interface CodexDesktopSwitchReport {
  codexDesktopAuthless: CodexDesktopSwitchState;
  codexClientCompaction: CodexDesktopSwitchState;
  apply: CodexDesktopSwitchApply;
  authSource: { presentsCodexAccount: boolean; summary: string };
}

type DesktopSwitchConfig = Pick<
  OcxConfig,
  | "clientIntegrations"
  | "runtimeRole"
  | "hostname"
  | "unauthenticatedLoopbackListener"
  | "codexDesktopAuthless"
  | "codexClientCompaction"
>;

function describeSwitch(
  stored: boolean,
  effective: boolean,
  config: Pick<OcxConfig, "runtimeRole">,
): CodexDesktopSwitchState {
  if (!stored || effective) return { stored, effective };
  return {
    stored,
    effective,
    inertReason: config.runtimeRole === "client"
      ? "client_role"
      : "non_loopback_bind_requires_admission_token",
  };
}

export function describeCodexDesktopSwitches(
  config: DesktopSwitchConfig,
  apply: CodexDesktopSwitchApply,
): CodexDesktopSwitchReport {
  const authlessStored = config.codexDesktopAuthless === true;
  const authlessEffective = isEffectiveCodexDesktopAuthless(config);
  const compactionStored = config.codexClientCompaction === true;
  const compactionEffective = isEffectiveCodexClientCompaction(config);

  return {
    codexDesktopAuthless: describeSwitch(authlessStored, authlessEffective, config),
    codexClientCompaction: describeSwitch(compactionStored, compactionEffective, config),
    apply,
    authSource: authlessEffective
      ? {
          presentsCodexAccount: false,
          summary: "The Codex app will not require its own account sign-in.",
        }
      : {
          presentsCodexAccount: true,
          summary: "The Codex app will require its own account sign-in.",
        },
  };
}

/**
 * Re-run the Codex config injection so a setting that lives in `~/.codex/config.toml` follows the
 * stored config NOW rather than at the next `ocx sync`.
 *
 * Shared by the Desktop switches (`codexDesktopAuthless`, `codexClientCompaction`) and the
 * web-search sidecar's Codex-side key. Both write through the same artifact transaction, so the
 * failure vocabulary — and the "run 'ocx sync' to retry" advice that reads it — has to be one thing.
 */
export async function applyCodexConfigInjection(
  config: OcxConfig,
): Promise<CodexDesktopSwitchApply> {
  if (!shouldSyncCodexOnStart(config)) {
    return { applied: false, reason: "integration_disabled", retryable: false };
  }

  const { readRuntimePort } = await import("../config/process-state");
  const runtime = readRuntimePort(process.pid);
  if (!runtime) {
    return { applied: false, reason: "proxy_not_running", retryable: true };
  }

  try {
    // Imported at call time, not module load. The settings route reaches this module on
    // every GET, and pulling the whole injection graph in just to report stored-versus-
    // effective state would put it on a read path that never writes anything.
    const { injectCodexConfig } = await import("./inject");
    const result = await injectCodexConfig(runtime.port, config);
    if (result.status === "skipped") {
      return {
        applied: false,
        reason: "integration_disabled",
        retryable: false,
        detail: result.message,
      };
    }
    if (result.success) {
      // history_paginated_requires_native_writer stands down only the legacy relabel;
      // apply still writes the routing and catalog half for paginated Codex homes.
      return { applied: true };
    }
    if (result.retryable === true) {
      return {
        applied: false,
        reason: "write_lock_busy",
        retryable: true,
        detail: result.message,
      };
    }
    return {
      applied: false,
      reason: "injection_refused",
      retryable: false,
      detail: result.message,
    };
  } catch (error) {
    return {
      applied: false,
      reason: "injection_refused",
      retryable: false,
      detail: error instanceof Error ? error.message : "Codex config injection failed.",
    };
  }
}
