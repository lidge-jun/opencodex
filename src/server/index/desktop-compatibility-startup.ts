import type { OcxConfig } from "../../types";
import { siblingOfLivePort } from "../../codex/sibling-start";
import { isTestHomeGuardArmed } from "../../lib/test-home-guard";
import type { DesktopCompatibilityRuntime } from "../../codex/desktop-compatibility/runtime";

type RuntimeModule = { getDesktopCompatibilityRuntime(): DesktopCompatibilityRuntime; shutdownDesktopCompatibility(): Promise<void> };
interface StartupIo {
  platform?: string;
  testGuard?: boolean;
  sibling?: boolean;
  load?: () => Promise<RuntimeModule>;
  warn?: (message: string) => void;
}
/** Core-safe gate: off installs do not load the optional runtime, read credentials or start timers. */
export function scheduleDesktopCompatibilityStartup(config: OcxConfig, io: StartupIo = {}): { shutdown(): Promise<void> } {
  let stopped = false, module: RuntimeModule | undefined;
  const enabled = config.desktopCompatibility?.startOnProxyStart === true && (io.platform ?? process.platform) === "win32"
    && !(io.testGuard ?? isTestHomeGuardArmed()) && !(io.sibling ?? siblingOfLivePort() !== null)
    && config.runtimeRole !== "client";
  const pending = enabled ? Promise.resolve().then(async () => {
    if (stopped) return;
    module = await (io.load?.() ?? import("../../codex/desktop-compatibility/service"));
    if (stopped) return;
    await module.getDesktopCompatibilityRuntime().start();
  }).catch(() => { (io.warn ?? console.warn)("Desktop compatibility observation did not start. Inspect Desktop compatibility status; no automatic trust or correction was applied."); }) : Promise.resolve();
  return { async shutdown() {
    stopped = true; await pending;
    if (module) await module.shutdownDesktopCompatibility();
  } };
}
