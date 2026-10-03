import { join } from "node:path";
import { getConfigDir } from "../../config/paths";
import { windowsDefaultExec, windowsDesktopAppAdapter } from "../desktop-app/windows";
import { ensureDesktopCompatibilityAuthority, inspectDesktopCompatibilityAuthority, loadDesktopCompatibilityAuthority, renewDesktopCompatibilityAuthority, type DesktopAuthorityInspection, type StoredDesktopAuthority } from "./certificate-store";
import { createWindowsCertificateTrust, inspectWindowsCertificateTrust, type DesktopCertificateTrust } from "./windows-certificate-trust";
import { acquireDesktopCertificateMutation, desktopCompatibilityRuntimeActive } from "./runtime-ownership";

export interface DesktopCertificateStatus {
  supported: boolean;
  state: "missing" | "invalid" | "expired" | "renewal-required" | "prepared" | "trusted" | "unknown";
  fingerprint?: string;
  expiresAt?: number;
  renewalDue?: boolean;
  trust?: DesktopCertificateTrust;
  busy: "prepare" | "trust" | "remove-trust" | "renew" | null;
}

export interface DesktopCertificateServiceIo {
  platform?: string;
  inspect?: () => DesktopAuthorityInspection;
  prepare?: () => Promise<StoredDesktopAuthority>;
  load?: (allowExpiredForRemoval: boolean) => Promise<StoredDesktopAuthority>;
  renew?: (fingerprint: string) => Promise<StoredDesktopAuthority>;
  readTrust?: (authority: Extract<DesktopAuthorityInspection, { fingerprint: string }>) => Promise<DesktopCertificateTrust>;
  changeTrust?: (authority: StoredDesktopAuthority, action: "trust" | "remove") => Promise<DesktopCertificateTrust>;
  appRunning?: () => Promise<boolean | null>;
}

export class DesktopCertificateServiceError extends Error {
  constructor(readonly code: "unsupported" | "busy" | "not_prepared" | "fingerprint_changed" | "app_running" | "runtime_running" | "app_state_unknown" | "trust_unknown" | "trust_not_applied") {
    super(`desktop_compatibility_${code}`); this.name = "DesktopCertificateServiceError";
  }
}

/** This service owns setup only: no proxy listeners, app restart, account or quota writes. */
export function createDesktopCertificateService(directory = join(getConfigDir(), "codex-desktop-compatibility"), io: DesktopCertificateServiceIo = {}) {
  const platform = io.platform ?? process.platform;
  const inspect = io.inspect ?? (() => inspectDesktopCompatibilityAuthority(directory));
  const prepare = io.prepare ?? (() => ensureDesktopCompatibilityAuthority({ directory }));
  const load = io.load ?? (allowExpired => loadDesktopCompatibilityAuthority({ directory }, allowExpired));
  const renew = io.renew ?? (fingerprint => renewDesktopCompatibilityAuthority({ directory }, fingerprint));
  const readTrust = io.readTrust ?? (value => inspectWindowsCertificateTrust(value.certPem, value.fingerprint));
  const changeTrust = io.changeTrust ?? ((authority, action) => createWindowsCertificateTrust(authority, authority.fingerprint)[action]());
  const appRunning = io.appRunning ?? (async () => {
    const install = windowsDesktopAppAdapter.discover(windowsDefaultExec);
    if (!install) return null; // Unknown installation is not proof that no app uses the authority.
    const processes = windowsDesktopAppAdapter.listProcesses(windowsDefaultExec, install);
    return processes === null ? null : processes.length > 0;
  });
  let busy: DesktopCertificateStatus["busy"] = null;
  async function status(): Promise<DesktopCertificateStatus> {
    if (platform !== "win32") return { supported: false, state: "missing", busy };
    const stored = inspect();
    if (!("fingerprint" in stored)) return { supported: true, state: stored.status, busy };
    const trusted = await readTrust(stored).catch(() => "unknown" as const);
    return { supported: true, state: stored.status === "expired" ? "expired"
      : stored.status === "renewal-required" ? "renewal-required"
      : trusted === "trusted" ? "trusted" : trusted === "not-trusted" ? "prepared" : "unknown",
      fingerprint: stored.fingerprint, expiresAt: stored.expiresAt, renewalDue: stored.renewalDue, trust: trusted, busy };
  }
  async function action(kind: NonNullable<DesktopCertificateStatus["busy"]>, expectedFingerprint?: string): Promise<DesktopCertificateStatus> {
    if (platform !== "win32") throw new DesktopCertificateServiceError("unsupported");
    if (busy !== null) throw new DesktopCertificateServiceError("busy");
    if (desktopCompatibilityRuntimeActive()) throw new DesktopCertificateServiceError("runtime_running");
    let release: () => void;
    try { release = acquireDesktopCertificateMutation(); } catch { throw new DesktopCertificateServiceError("busy"); }
    busy = kind;
    try {
      if (kind !== "prepare") {
        const before = inspect();
        if (!("fingerprint" in before)) throw new DesktopCertificateServiceError("not_prepared");
        if (before.fingerprint !== expectedFingerprint) throw new DesktopCertificateServiceError("fingerprint_changed");
        if (kind === "remove-trust" || kind === "renew") {
          const running = await appRunning();
          if (running === null) throw new DesktopCertificateServiceError("app_state_unknown");
          if (running) throw new DesktopCertificateServiceError("app_running");
        }
      }
      const authority = kind === "prepare" ? await prepare() : await load(kind !== "trust");
      if (kind !== "prepare") {
        if (authority.fingerprint !== expectedFingerprint) throw new DesktopCertificateServiceError("fingerprint_changed");
        const current = inspect();
        if (!("fingerprint" in current) || current.fingerprint !== authority.fingerprint) throw new DesktopCertificateServiceError("fingerprint_changed");
        const result = await changeTrust(authority, kind === "trust" ? "trust" : "remove");
        if (result === "unknown") throw new DesktopCertificateServiceError("trust_unknown");
        if (result !== (kind === "trust" ? "trusted" : "not-trusted")) throw new DesktopCertificateServiceError("trust_not_applied");
        // Never discard the only removable old identity until OS trust removal is proven.
        // Publication failure leaves its protected envelope intact for an explicit retry.
        if (kind === "renew") await renew(authority.fingerprint);
      }
      busy = null;
      return status();
    } finally { busy = null; release(); }
  }
  return { status, prepare: () => action("prepare"), trust: (fingerprint: string) => action("trust", fingerprint),
    removeTrust: (fingerprint: string) => action("remove-trust", fingerprint), renew: (fingerprint: string) => action("renew", fingerprint) };
}

export type DesktopCertificateService = ReturnType<typeof createDesktopCertificateService>;
