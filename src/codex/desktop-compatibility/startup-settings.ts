import { createHash } from "node:crypto";
import { readConfigFileSnapshot } from "../../config/diagnostics";
import { mutatePersistedConfig } from "../../config/persisted-mutation";
import { desktopCompatibilityConfigError } from "../../config/schema/desktop-compatibility";
import { adoptPersistedDesktopCompatibility } from "../../config/live-reconcile";
import type { OcxConfig } from "../../types";

export interface DesktopStartupSettings { startOnProxyStart: boolean; revision: string }
interface SettingsIo { read?: typeof readConfigFileSnapshot; mutate?: typeof mutatePersistedConfig; liveConfig?: OcxConfig }
const failure = (code: string) => new Error(`desktop_compatibility_settings_${code}`);
/** A next-process preference: never changes live runtime, trust, app or login state. */
export function createDesktopStartupSettings(io: SettingsIo = {}) {
  const read = io.read ?? readConfigFileSnapshot, mutate = io.mutate ?? mutatePersistedConfig;
  function inspect() {
    const snapshot = read();
    if (snapshot.diagnostics.source !== "file" || snapshot.raw === undefined) throw failure("unavailable");
    let raw: Record<string, unknown>;
    try { raw = JSON.parse(snapshot.raw.replace(/^\uFEFF/, "")); } catch { throw failure("unavailable"); }
    if (desktopCompatibilityConfigError(raw)) throw failure("invalid");
    const setting = raw.desktopCompatibility as { startOnProxyStart: boolean } | undefined;
    return { setting, status: { startOnProxyStart: setting?.startOnProxyStart === true,
      revision: createHash("sha256").update(JSON.stringify(setting ?? null)).digest("hex") } };
  }
  const status = (): DesktopStartupSettings => inspect().status;
  function set(startOnProxyStart: boolean, expectedRevision: string): DesktopStartupSettings {
    if (typeof startOnProxyStart !== "boolean" || !/^[a-f0-9]{64}$/.test(expectedRevision)) throw failure("invalid_request");
    let outcome;
    try { outcome = mutate(config => {
      // Runs under the existing config lock, including each rebase retry. Unrelated fields
      // may change, but a changed preference must be shown again before this write.
      const current = status();
      if (current.revision !== expectedRevision) throw failure("changed");
      if (current.startOnProxyStart === startOnProxyStart) return { changed: false, value: startOnProxyStart };
      config.desktopCompatibility = { startOnProxyStart };
      return { changed: true, value: startOnProxyStart };
    }); } catch (error) {
      // Publication can succeed before bookkeeping fails. Reconcile a verified disk
      // field without claiming success or replaying the uncertain write.
      if (io.liveConfig) { try { adoptPersistedDesktopCompatibility(io.liveConfig, inspect().setting); } catch { /* unresolved state remains an error */ } }
      throw error;
    }
    if (outcome.status === "unavailable") throw failure("unavailable");
    const actual = inspect();
    if (io.liveConfig) adoptPersistedDesktopCompatibility(io.liveConfig, actual.setting);
    if (actual.status.startOnProxyStart !== startOnProxyStart) throw failure("changed");
    return actual.status;
  }
  return { status, set };
}
export type DesktopStartupSettingsService = ReturnType<typeof createDesktopStartupSettings>;
