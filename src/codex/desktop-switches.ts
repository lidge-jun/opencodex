import type { OcxConfig } from "../types";
import { shouldSyncCodexOnStart } from "./desired-state";
import { tomlString } from "./paths";
import {
  isEffectiveCodexClientCompaction,
  isEffectiveCodexDesktopAuthless,
} from "./loopback-target";

export type CodexDesktopSwitchInertReason =
  | "client_role"
  | "non_loopback_bind_requires_admission_token";

export interface CodexDesktopSwitchState {
  stored: boolean;
  effective: boolean | null;
  inertReason?: CodexDesktopSwitchInertReason;
}

export type CodexDesktopSwitchApplyReason =
  | "not_requested"
  | "proxy_not_running"
  | "integration_disabled"
  | "external_provider"
  | "ownership_undetermined"
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
  authSource: { presentsCodexAccount: boolean | null; summary: string };
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
  effective: boolean | null,
  config: Pick<OcxConfig, "runtimeRole">,
): CodexDesktopSwitchState {
  if (effective === null) return { stored, effective };
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
  const externallyOwned = !apply.applied && apply.reason === "external_provider";
  const ownershipUndetermined = !apply.applied && apply.reason === "ownership_undetermined";
  // An unreadable config.toml leaves ownership undetermined, so the local effective values are
  // withheld exactly like the externally owned case: reporting them would present OpenCodex's
  // stored-versus-computed state as live while the file may belong to another provider.
  const effectiveWithheld = externallyOwned || ownershipUndetermined;
  const authlessEffective = effectiveWithheld ? null : isEffectiveCodexDesktopAuthless(config);
  const compactionStored = config.codexClientCompaction === true;
  const compactionEffective = effectiveWithheld ? null : isEffectiveCodexClientCompaction(config);

  return {
    codexDesktopAuthless: describeSwitch(authlessStored, authlessEffective, config),
    codexClientCompaction: describeSwitch(compactionStored, compactionEffective, config),
    apply,
    authSource: externallyOwned
      ? {
          presentsCodexAccount: null,
          summary: "An external model provider owns Codex sign-in behavior; its account requirement was not changed.",
        }
      : ownershipUndetermined
      ? {
          presentsCodexAccount: null,
          summary: "Whether the Codex app requires its own account sign-in is undetermined; config.toml ownership could not be read.",
        }
      : authlessEffective
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
 * The apply record for a report that attempted no rewrite. `not_requested` alone would have
 * the report claiming OpenCodex's stored-versus-effective state as live, so the read path
 * consults the same ownership predicate the injector does and reports external ownership
 * instead — a settings GET and a switch-free PUT then agree with an attempted apply.
 */
export async function observedCodexDesktopSwitchApply(): Promise<CodexDesktopSwitchApply> {
  // Same lazy boundary as applyCodexConfigInjection: the ownership predicate lives in the
  // injection graph, which the settings read path must not pull in at module scope.
  const { currentExternalCodexModelProvider } = await import("./inject/config-toml");
  let provider: string | null;
  try {
    provider = currentExternalCodexModelProvider();
  } catch (error) {
    // A present-but-unreadable config.toml (permissions, deletion racing existsSync)
    // must not take down the whole settings report. The undetermined reason keeps the
    // reporting contract honest: effective values and the sign-in answer stay null instead
    // of presenting local state a foreign provider may still control.
    return {
      applied: false,
      reason: "ownership_undetermined",
      retryable: true,
      detail: `config.toml ownership could not be determined: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (!provider) return { applied: false, reason: "not_requested", retryable: false };
  return {
    applied: false,
    reason: "external_provider",
    retryable: false,
    detail: `config.toml selects the external model_provider ${tomlString(provider)}.`,
  };
}

// The apply gates skip the injector entirely, so they run the same ownership read the
// observed path does — a disabled integration or an absent runtime must not make a
// switch PUT report local state the external provider still controls. An undetermined
// read is kept for the same reason: replacing it with the gate's reason would drop the
// "ownership could not be determined" explanation the locked save still owes.
async function observedOwnershipApply(): Promise<CodexDesktopSwitchApply | null> {
  const ownership = await observedCodexDesktopSwitchApply();
  return !ownership.applied
    && (ownership.reason === "external_provider" || ownership.reason === "ownership_undetermined")
    ? ownership
    : null;
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
    return (await observedOwnershipApply())
      ?? { applied: false, reason: "integration_disabled", retryable: false };
  }

  const { readRuntimePort } = await import("../config/process-state");
  const runtime = readRuntimePort(process.pid);
  if (!runtime) {
    return (await observedOwnershipApply())
      ?? { applied: false, reason: "proxy_not_running", retryable: true };
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
    if (result.success && result.configApplied === false) {
      return {
        applied: false,
        reason: "external_provider",
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
    // The injector may fail its ownership read after the initial apply gates passed.
    const ownership = await observedOwnershipApply();
    if (ownership) return ownership;
    return {
      applied: false,
      reason: "injection_refused",
      retryable: false,
      detail: error instanceof Error ? error.message : "Codex config injection failed.",
    };
  }
}
