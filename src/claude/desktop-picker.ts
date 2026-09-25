/**
 * Claude Desktop picker mode: the one server-side controller for every picker mutation.
 *
 * While a server runs, enable, disable and Desktop mode transitions run here, serialized by one
 * lock (devlog/_plan/260924_claude_desktop_picker_mode/030_wp4_picker_activation.md, D11).
 */
import type { OcxConfig } from "../types";
import { claudeDesktopIntegrationEnabled } from "../codex/desired-state";
import { getConfigDir } from "../config/paths";
import { readFileSync, existsSync } from "node:fs";
import { pickerCaCertPath, pickerCaFingerprints, ensurePickerCa, issuePickerLeaf, pickerLeafCertPath } from "./intercept/picker-ca";
import { inspectPickerTrust, trustPickerCa, untrustPickerCa } from "./intercept/picker-trust";
import type { PickerRuntime } from "./intercept/picker-runtime";
import type { PickerTrustState, SecurityRunner } from "./intercept/picker-trust";
import {
  applyDesktopPickerProfile,
  inspectDesktopPickerProfile,
  removeDesktopPickerProfile,
  pickerEgressUrl,
  type DesktopPickerProfileInspection,
  type DesktopPickerProfileOptions,
} from "./desktop-picker-profile";
import { resolveClaudeDesktopMode, observeClaudeDesktopMode } from "./desktop-first-party";

/** Desktop no longer selects the picker profile, so removing the CA's trust cannot strand it. */
function profileReleased(profile: DesktopPickerProfileInspection): boolean {
  return profile.kind === "absent" || profile.kind === "not_selected";
}

export type DesktopPickerReason = "active" | "restart_required" | "unsupported_platform" | "not_first_party"
  | "integration_off" | "disabled" | "proxy_unavailable" | "mode_not_committed" | "trust_pending"
  | "trust_declined" | "profile_failed";

export interface DesktopPickerStatus {
  desired: boolean;
  supported: boolean;
  trust: PickerTrustState;
  profile: DesktopPickerProfileInspection["kind"];
  listenerReady: boolean;
  effective: boolean;
  reason: DesktopPickerReason;
  models: number;
  snapshotAt: number | null;
  lastBootstrapAt: number | null;
  hint?: string;
  residual?: string[];
}

export interface DesktopPickerEnableOptions {
  persist: boolean;
  context: "cli-trusted" | "server";
  callerAddedTrust?: boolean;
}

export interface DesktopPickerOps {
  disableLocked(options: { persist: boolean }): Promise<DesktopPickerStatus>;
  enableLocked(options: DesktopPickerEnableOptions): Promise<DesktopPickerStatus>;
}

export interface DesktopPickerController {
  enable(options: DesktopPickerEnableOptions): Promise<DesktopPickerStatus>;
  disable(options: { persist: boolean }): Promise<DesktopPickerStatus>;
  transition<T>(fn: (ops: DesktopPickerOps) => Promise<T>): Promise<T>;
  status(): Promise<DesktopPickerStatus>;
  busy(): boolean;
}

export interface DesktopPickerControllerDeps {
  runtime: PickerRuntime;
  readConfig: () => OcxConfig;
  persistPreference: (value: boolean) => boolean;
  /** Bound picker CONNECT proxy port (Desktop's egress), or null when it is not running. */
  proxyPort: () => number | null;
  configDir: string;
  security?: SecurityRunner;
  platform?: NodeJS.Platform;
  applyProfile?: typeof applyDesktopPickerProfile;
  removeProfile?: typeof removeDesktopPickerProfile;
  inspectProfile?: typeof inspectDesktopPickerProfile;
}

function profileOptions(deps: DesktopPickerControllerDeps): DesktopPickerProfileOptions {
  return { configDir: deps.configDir, ...(deps.platform ? { platform: deps.platform } : {}) };
}

function statusReasonForConfig(config: OcxConfig, platform: NodeJS.Platform, proxyBound: boolean): DesktopPickerReason {
  if (platform !== "darwin") return "unsupported_platform";
  if (resolveClaudeDesktopMode(config, observeClaudeDesktopMode(config)) !== "first-party") return "not_first_party";
  if (!claudeDesktopIntegrationEnabled(config)) return "integration_off";
  if (config.claudeCode?.intercept?.picker === false) return "disabled";
  if (!proxyBound) return "proxy_unavailable";
  return "restart_required";
}

function emptyStatus(config: OcxConfig, platform: NodeJS.Platform, reason: DesktopPickerReason): DesktopPickerStatus {
  return {
    desired: platform === "darwin"
      && claudeDesktopIntegrationEnabled(config)
      && resolveClaudeDesktopMode(config, observeClaudeDesktopMode(config)) === "first-party"
      && config.claudeCode?.intercept?.picker !== false,
    supported: platform === "darwin",
    trust: "unknown",
    profile: "absent",
    listenerReady: false,
    effective: false,
    reason,
    models: 0,
    snapshotAt: null,
    lastBootstrapAt: null,
  };
}

export function createDesktopPickerController(deps: DesktopPickerControllerDeps): DesktopPickerController {
  const platform = deps.platform ?? process.platform;
  const applyProfile = deps.applyProfile ?? applyDesktopPickerProfile;
  const removeProfile = deps.removeProfile ?? removeDesktopPickerProfile;
  const inspectProfile = deps.inspectProfile ?? inspectDesktopPickerProfile;
  let pending = 0;
  // When this process last changed Desktop's egress profile. Desktop reads that profile only at
  // launch, so a restart is needed only until it has fetched a bootstrap since that change; a plain
  // opencodex restart changes nothing Desktop reads and never asks for one.
  let profileChangedAt: number | null = null;
  let tail = Promise.resolve();

  function inspect(): DesktopPickerProfileInspection {
    try { return inspectProfile(profileOptions(deps)); }
    catch { return { kind: "unsafe", reason: "inspection_failed" }; }
  }

  function runtimeStatus(trustOverride?: PickerTrustState): DesktopPickerStatus {
    const runtime = deps.runtime.status();
    const profile = inspect();
    const profileCurrent = profile.kind === "applied" && profile.proxyUrl === pickerEgressUrl(deps.proxyPort() ?? 0);
    const trust = trustOverride ?? runtime.trust;
    const effective = runtime.effective && profileCurrent && trust === "trusted";
    let reason: DesktopPickerReason;
    if (platform !== "darwin") reason = "unsupported_platform";
    else if (!runtime.desired) reason = statusReasonForConfig(deps.readConfig(), platform, deps.proxyPort() !== null);
    else if (deps.proxyPort() === null) reason = "proxy_unavailable";
    else if (trust !== "trusted") reason = "trust_pending";
    else if (!profileCurrent) reason = "profile_failed";
    else if (!runtime.listenerReady || !runtime.effective) reason = "restart_required";
    else reason = profileChangedAt !== null && (runtime.lastBootstrapAt === null || runtime.lastBootstrapAt < profileChangedAt)
      ? "restart_required"
      : "active";
    return {
      desired: runtime.desired,
      supported: runtime.supported,
      trust,
      profile: profile.kind,
      listenerReady: runtime.listenerReady,
      effective,
      reason,
      models: runtime.models,
      snapshotAt: runtime.snapshotAt,
      lastBootstrapAt: runtime.lastBootstrapAt,
    };
  }

  async function withLock<T>(fn: () => Promise<T>): Promise<T> {
    pending += 1;
    let release!: () => void;
    const previous = tail;
    tail = new Promise<void>(resolve => { release = resolve; });
    await previous;
    try { return await fn(); }
    finally { pending -= 1; release(); }
  }

  async function untrustCurrentCa(): Promise<boolean> {
    const caPath = pickerCaCertPath(deps.configDir);
    if (platform !== "darwin" || !existsSync(caPath)) return true;
    try {
      const sha1 = pickerCaFingerprints(readFileSync(caPath, "utf8")).sha1;
      return (await untrustPickerCa(caPath, sha1, deps.security, platform)).ok;
    } catch { return false; }
  }

  async function compensateTrust(shouldCompensate: boolean): Promise<boolean> {
    if (!shouldCompensate) return true;
    // An already selected owned profile proves that another successful enable still relies on
    // this CA. Keep its trust even when the current request is refused.
    if (inspect().kind === "applied") return true;
    try {
      const ca = ensurePickerCa(deps.configDir);
      const result = await untrustPickerCa(
        pickerCaCertPath(deps.configDir), pickerCaFingerprints(ca.certPem).sha1, deps.security, platform,
      );
      return result.ok;
    } catch { return false; }
  }

  function withTrustFailure(status: DesktopPickerStatus, trustFailed: boolean): DesktopPickerStatus {
    if (!trustFailed) return status;
    return { ...status, effective: false, hint: "ocx claude desktop picker off", residual: [...new Set([...(status.residual ?? []), "trust"])] };
  }

  async function enableLocked(options: DesktopPickerEnableOptions): Promise<DesktopPickerStatus> {
    let trustedByAttempt = false;
    let observedTrust: PickerTrustState | undefined;
    const refuse = async (reason: DesktopPickerReason): Promise<DesktopPickerStatus> => {
      const trustFailed = options.callerAddedTrust === true && !(await compensateTrust(true));
      return withTrustFailure({ ...runtimeStatus(observedTrust), reason }, trustFailed);
    };
    const check = (config: OcxConfig, includePreference: boolean): DesktopPickerReason | null => {
      if (platform !== "darwin") return "unsupported_platform";
      if (resolveClaudeDesktopMode(config, observeClaudeDesktopMode(config)) !== "first-party") return "mode_not_committed";
      if (!claudeDesktopIntegrationEnabled(config)) return "integration_off";
      if (includePreference && config.claudeCode?.intercept?.picker === false) return "disabled";
      if (deps.proxyPort() === null) return "proxy_unavailable";
      return null;
    };

    const first = check(deps.readConfig(), false);
    if (first) return refuse(first);
    if (options.persist) {
      try {
        if (!deps.persistPreference(true)) return refuse("mode_not_committed");
      } catch { return refuse("mode_not_committed"); }
    }
    const second = check(deps.readConfig(), true);
    if (second) return refuse(second);

    let caPath: string;
    let caSha1: string;
    try {
      const ca = ensurePickerCa(deps.configDir);
      issuePickerLeaf(ca, deps.configDir);
      caPath = pickerCaCertPath(deps.configDir);
      caSha1 = pickerCaFingerprints(ca.certPem).sha1;
      let trust = await inspectPickerTrust(pickerLeafCertPath(deps.configDir), caSha1, deps.security, platform);
      observedTrust = trust;
      if (trust !== "trusted" && options.context === "server") {
        const added = await trustPickerCa(caPath, deps.security, platform);
        trustedByAttempt = added.ok;
        trust = await inspectPickerTrust(pickerLeafCertPath(deps.configDir), caSha1, deps.security, platform);
        observedTrust = trust;
      }
      if (trust !== "trusted") {
        const compensationFailed = (trustedByAttempt || options.callerAddedTrust === true) && !(await compensateTrust(true));
        const result = withTrustFailure({ ...runtimeStatus(trust), reason: options.context === "cli-trusted" ? "trust_declined" : "trust_pending", hint: options.context === "cli-trusted" ? undefined : "ocx claude desktop picker trust" }, compensationFailed);
        return result;
      }
      const afterTrust = check(deps.readConfig(), true);
      if (afterTrust) {
        const compensationFailed = (trustedByAttempt || options.callerAddedTrust === true) && !(await compensateTrust(true));
        return withTrustFailure({ ...runtimeStatus(trust), reason: afterTrust }, compensationFailed);
      }
      const proxyPort = deps.proxyPort();
      if (proxyPort === null) {
        const compensationFailed = (trustedByAttempt || options.callerAddedTrust === true) && !(await compensateTrust(true));
        return withTrustFailure({ ...runtimeStatus(trust), reason: "proxy_unavailable" }, compensationFailed);
      }
      const applied = applyProfile({ ...profileOptions(deps), proxyPort });
      if (!applied.ok) {
        const compensationFailed = (trustedByAttempt || options.callerAddedTrust === true) && !(await compensateTrust(true));
        return withTrustFailure({ ...runtimeStatus(trust), reason: "profile_failed", residual: ["profile"] }, compensationFailed);
      }
      if (applied.changed) profileChangedAt = Date.now();
      await deps.runtime.rearm();
      const result = runtimeStatus();
      if (result.reason === "active") return result;
      return { ...result, reason: "restart_required" };
    } catch {
      const compensationFailed = (trustedByAttempt || options.callerAddedTrust === true) && !(await compensateTrust(true));
      return withTrustFailure({ ...runtimeStatus(observedTrust), reason: "profile_failed" }, compensationFailed);
    }
  }

  async function disableLocked(options: { persist: boolean }): Promise<DesktopPickerStatus> {
    const residual: string[] = [];
    try { deps.runtime.disarm(); } catch { residual.push("runtime"); }
    if (options.persist) {
      try { if (!deps.persistPreference(false)) residual.push("preference"); }
      catch { residual.push("preference"); }
    }
    try {
      const removed = removeProfile(profileOptions(deps));
      if (!removed.ok) residual.push("profile");
    } catch { residual.push("profile"); }
    // Trust goes only once Desktop no longer selects the picker profile: a selected profile without
    // trust pins Desktop to a proxy whose certificate it rejects. Disarmed, the proxy only tunnels.
    let trustRemoved = false;
    if (profileReleased(inspect())) {
      trustRemoved = await untrustCurrentCa();
      if (!trustRemoved) residual.push("trust");
    } else if (!residual.includes("profile")) {
      residual.push("profile");
    }
    let trustAfter = deps.runtime.status().trust;
    try { trustAfter = await deps.runtime.refreshTrust(); } catch { /* status below retains the runtime's cached trust */ }
    const result = runtimeStatus(trustRemoved ? trustAfter === "trusted" ? "trusted" : "untrusted" : trustAfter);
    const profile = inspect();
    const trust = result.trust;
    const effective = result.effective && profile.kind === "applied" && trust === "trusted";
    const reason = residual.length > 0
      ? (residual.includes("trust") ? "trust_pending" : "profile_failed")
      : configPickerDisabled(deps.readConfig()) ? "disabled" : profile.kind === "applied" ? "profile_failed" : "restart_required";
    return { ...result, effective, reason, ...(residual.length > 0 ? { residual } : {}) };
  }

  function configPickerDisabled(config: OcxConfig): boolean { return config.claudeCode?.intercept?.picker === false; }
  const ops: DesktopPickerOps = { disableLocked, enableLocked };
  return {
    enable: options => withLock(() => enableLocked(options)),
    disable: options => withLock(() => disableLocked(options)),
    transition: fn => withLock(() => fn(ops)),
    status: async () => runtimeStatus(),
    busy: () => pending > 0,
  };
}

export async function removeDesktopPickerArtifacts(options: { configDir?: string; security?: SecurityRunner; platform?: NodeJS.Platform } = {}): Promise<{ ok: boolean; residual?: string[] }> {
  const configDir = options.configDir ?? getConfigDir();
  const platform = options.platform ?? process.platform;
  const residual: string[] = [];
  try {
    const removed = removeDesktopPickerProfile({ configDir, ...(platform ? { platform } : {}) });
    if (!removed.ok) residual.push("profile");
  } catch { residual.push("profile"); }
  let released = false;
  try { released = profileReleased(inspectDesktopPickerProfile({ configDir, ...(platform ? { platform } : {}) })); } catch { /* unknown: keep trust */ }
  if (!released) {
    // Still selected (or unknown): keep trust so Desktop is not pinned to a CA it rejects.
    if (!residual.includes("profile")) residual.push("profile");
    return { ok: false, residual };
  }
  const caPath = pickerCaCertPath(configDir);
  if (platform === "darwin" && existsSync(caPath)) {
    try {
      const sha1 = pickerCaFingerprints(readFileSync(caPath, "utf8")).sha1;
      if (!(await untrustPickerCa(caPath, sha1, options.security, platform)).ok) residual.push("trust");
    } catch { residual.push("trust"); }
  }
  return residual.length ? { ok: false, residual } : { ok: true };
}

/** Static status when no controller runs in this process (intercept disabled, client role, bind failure). */
export function offlinePickerStatus(config: OcxConfig, platform: NodeJS.Platform = process.platform): DesktopPickerStatus {
  const reason = statusReasonForConfig(config, platform, false);
  return emptyStatus(config, platform, reason);
}

/**
 * Run a Desktop mode transition under the controller lock, or, with no controller, with offline
 * ops: disableLocked removes leftover picker artifacts; enableLocked reports proxy_unavailable.
 */
export function runDesktopTransition<T>(
  controller: DesktopPickerController | null,
  fn: (ops: DesktopPickerOps) => Promise<T>,
  offline?: { configDir?: string; config: OcxConfig; security?: SecurityRunner; platform?: NodeJS.Platform },
): Promise<T> {
  if (controller) return controller.transition(fn);
  const fallback = offline ?? { config: {} as OcxConfig };
  const platform = fallback.platform ?? process.platform;
  const ops: DesktopPickerOps = {
    disableLocked: async () => {
      const cleanup = await removeDesktopPickerArtifacts({ configDir: fallback.configDir, security: fallback.security, platform });
      const status = offlinePickerStatus(fallback.config, platform);
      return cleanup.ok ? status : { ...status, effective: false, reason: "profile_failed", residual: cleanup.residual };
    },
    enableLocked: async () => ({ ...offlinePickerStatus(fallback.config, platform), reason: "proxy_unavailable" }),
  };
  return fn(ops);
}
