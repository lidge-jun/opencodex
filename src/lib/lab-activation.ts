/**
 * Compatibility Lab activation.
 *
 * The proxy core does not import Lab. This module is the seam that does, and the startup
 * composition root calls it only when the install actually uses Lab, so a user with no
 * routing profile and no automation executes no Lab code and starts no Lab timer.
 *
 * Activation is SYNCHRONOUS by design. Three audit rounds established that a deferred
 * activation window is unpatchable: `routeModelInternal` is sync, and so is the
 * subagent-fallback chain that calls `routeModel`, so those callers have nowhere to await.
 * During such a window a policy alias would be silently dropped from a fallback chain and
 * the subagent would run on a different model than the operator configured. Registration
 * therefore completes before `startServer` returns, inside the same synchronous turn as
 * `Bun.serve`, so no request can observe an unregistered slot.
 *
 * See devlog/_plan/260814_lab_core_decoupling/080_activation_is_synchronous.md
 *
 * Startup degrades, explicit operator action reports. This asymmetry is deliberate: an
 * invalid automation config disables automation with a warning here, but the management
 * API and CLI paths that start a scheduler leave `LabAutomationError` to surface (the
 * management route maps it to a 400). Someone who just toggled automation should see the
 * validation error; someone merely starting the proxy should not lose unrelated traffic.
 *
 * @internal host integration only
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { labAutomationPolicyPath } from "../lab/paths";
import type { OcxConfig } from "../types";
import { LabAutomationError } from "../lab/automation/types";
import { registerLabPassiveRouteLinker } from "./lab-passive-linker-registration";
import { setCompatibilityEvidenceProvider } from "../routing/compatibility/provider-slot";
import { labCompatibilityEvidenceProvider } from "../routing/compatibility/lab-evidence-provider";
import {
  setLabAutomationDispatchDeps,
  startLabAutomationScheduler,
} from "../lab/automation/orchestrator";
import { createProductionLabRouteExecutor } from "./lab-live-route-production";

/** Activation records keyed by configDir, so one process can own several configs. */
const activated = new Map<string, Array<() => void>>();

const activationKey = (configDir?: string): string => configDir ?? "";

function readJsonIfPresent(path: string): unknown {
  try {
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch {
    // A malformed or unreadable file means "not enabled": this detector must never throw
    // during startup, and must never import Lab persistence to answer the question.
    return null;
  }
}

/**
 * True when Lab automation is enabled on disk.
 *
 * Mirrors `loadLabAutomationConfig` precedence deliberately: the current authority is the
 * combined `automation-config.json`, with `automation-policy.json` as the legacy fallback.
 * Reading only the legacy file would miss every install that enabled automation through
 * the current dashboard.
 */
export function labAutomationEnabledOnDisk(configDir?: string): boolean {
  const legacyPath = labAutomationPolicyPath(configDir);
  const combined = readJsonIfPresent(join(dirname(legacyPath), "automation-config.json"));
  if (combined && typeof combined === "object") {
    const policy = (combined as { policy?: unknown }).policy;
    if (policy && typeof policy === "object") {
      return (policy as { enabled?: unknown }).enabled === true;
    }
  }
  const legacy = readJsonIfPresent(legacyPath);
  if (legacy && typeof legacy === "object") {
    return (legacy as { enabled?: unknown }).enabled === true;
  }
  return false;
}

/** True when this install actually uses Lab: any routing profile, or automation enabled. */
export function labActivationRequired(config: OcxConfig, configDir?: string): boolean {
  if (Object.keys(config.routingProfiles ?? {}).length > 0) return true;
  return labAutomationEnabledOnDisk(configDir);
}

/**
 * Register Lab into the core slots. Idempotent per configDir and safe to call again after
 * a routing profile is created at runtime.
 */
export function activateLab(config: OcxConfig, configDir?: string): void {
  const key = activationKey(configDir);
  // INVARIANT: activation is all-or-nothing and reason-independent. Every slot is
  // registered here regardless of WHY activation was required, which is what makes this
  // key safe as configDir alone -- an automation-only activation still installs the
  // compatibility provider a later profile needs. If any registration ever becomes
  // conditional on the activation reason, this key must include that reason, or the early
  // return will silently skip it forever.
  if (activated.has(key)) return;

  const detach: Array<() => void> = [];
  detach.push(registerLabPassiveRouteLinker(configDir));
  detach.push(setCompatibilityEvidenceProvider(labCompatibilityEvidenceProvider));

  const routeExecutor = createProductionLabRouteExecutor({ configDir, loadConfig: () => config });
  detach.push(setLabAutomationDispatchDeps({ configDir, loadConfig: () => config, routeExecutor }));

  // Record the activation BEFORE the scheduler start. startLabAutomationScheduler runs the
  // full automation normalizer, which throws on any field violation, and this call sits on
  // the startup path of every install that has a routing profile. Storing the record first
  // means a throw cannot orphan the detach receipts and leave slots registered with no
  // activation record -- which would let a later activateLab register them a second time.
  activated.set(key, detach);

  if (labAutomationEnabledOnDisk(configDir)) {
    try {
      startLabAutomationScheduler(configDir);
    } catch (err) {
      // Neither a malformed automation file nor a busy state lock may take the proxy down
      // at startup. Lab automation stays off for this run; routing, evidence, and every
      // other subsystem keep working.
      //
      // The two causes get different messages because they need different actions, and a
      // lock-contention failure reported as "invalid config" sends the operator to fix a
      // file that is fine. Contention can also stall startup by up to the 5s lock wait.
      const code = err instanceof LabAutomationError ? err.code : null;
      if (code === "state_lock_busy" || code === "state_lock_failed") {
        console.warn(
          "[lab] Lab automation did not start: another process holds the automation state lock."
          + " Automation stays off for this run and will be retried on the next start.",
        );
      } else {
        console.warn(
          "[lab] Lab automation is disabled for this run because its configuration could not be"
          + " loaded:",
          err instanceof Error ? err.message : err,
        );
      }
    }
  }
}

/** True when this configDir has been activated. */
export function isLabActivated(configDir?: string): boolean {
  return activated.has(activationKey(configDir));
}

/**
 * Test-only teardown. Deactivation is deliberately NOT a production path: tearing an
 * activation down mid-run would finalize in-flight automation as ineligible rather than
 * cancelled, and the orchestrator's shutdown signal is process-global. An install that
 * creates then deletes a profile keeps Lab resident until restart, which does not affect
 * users who never opted in.
 */
export function resetLabActivationForTests(): void {
  for (const [key, detach] of [...activated]) {
    activated.delete(key);
    for (const release of [...detach].reverse()) {
      try { release(); } catch { /* teardown is best-effort */ }
    }
  }
}
