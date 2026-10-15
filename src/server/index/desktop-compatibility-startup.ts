import type { OcxConfig } from "../../types";
import { siblingOfLivePort } from "../../codex/sibling-start";
import { isTestHomeGuardArmed } from "../../lib/test-home-guard";
import type { DesktopCompatibilityRuntime } from "../../codex/desktop-compatibility/runtime";
import { bindNativeCompatibilityOwner } from "../../codex/desktop-compatibility/routing-binding";
import type { ReadinessGate } from "../readiness";

type RuntimeModule = { getDesktopCompatibilityRuntime(): DesktopCompatibilityRuntime; shutdownDesktopCompatibility(): Promise<void> };
interface StartupIo {
  platform?: string;
  testGuard?: boolean;
  sibling?: boolean;
  load?: () => Promise<RuntimeModule>;
  warn?: (message: string) => void;
  boundPort?: number;
  boundHostname?: string;
  loopbackPort?: number;
  readiness?: Pick<ReadinessGate, "getStatus">;
  readinessTimeoutMs?: number;
}
/** Core-safe gate: off installs do not load the optional runtime, read credentials or start timers. */
export function scheduleDesktopCompatibilityStartup(config: OcxConfig, io: StartupIo = {}): { shutdown(): Promise<void> } {
  let stopped = false, module: RuntimeModule | undefined;
  let cancelReadiness: (() => void) | undefined;
  const waitForReadiness = () => !io.readiness ? Promise.resolve(true) : new Promise<boolean>(resolve => {
    const deadline = Date.now() + (io.readinessTimeoutMs ?? 120000);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (ready: boolean) => { if (timer) clearTimeout(timer); cancelReadiness = undefined; resolve(ready); };
    cancelReadiness = () => finish(false);
    const check = () => {
      const status = io.readiness!.getStatus();
      if (stopped || status !== "pending" || Date.now() >= deadline) { finish(!stopped && status === "ready"); return; }
      timer = setTimeout(check, 100); timer.unref();
    };
    check();
  });
  const unbind = io.boundPort === undefined || io.boundHostname === undefined ? () => {} : bindNativeCompatibilityOwner({ config, hostname: io.boundHostname, port: io.boundPort, loopbackPort: io.loopbackPort });
  const enabled = config.desktopCompatibility?.startOnProxyStart === true && (io.platform ?? process.platform) === "win32"
    && !(io.testGuard ?? isTestHomeGuardArmed()) && !(io.sibling ?? siblingOfLivePort() !== null)
    && config.runtimeRole !== "client";
  const pending = enabled ? Promise.resolve().then(async () => {
    if (stopped) return;
    if (io.readiness) {
      const ready = await waitForReadiness();
      if (stopped) return;
      if (!ready) throw new Error("desktop_compatibility_startup_not_ready");
    }
    module = await (io.load?.() ?? import("../../codex/desktop-compatibility/service"));
    if (stopped) return;
    await module.getDesktopCompatibilityRuntime().start();
  }).catch(() => { (io.warn ?? console.warn)("Desktop compatibility observation did not start. Inspect Desktop compatibility status; no automatic trust or correction was applied."); }) : Promise.resolve();
  return { async shutdown() {
    stopped = true; cancelReadiness?.(); unbind(); await pending;
    if (module) await module.shutdownDesktopCompatibility();
  } };
}
