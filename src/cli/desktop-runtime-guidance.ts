import { createSupervisionLatch, inspectDesktopSupervision } from "../service/desktop-supervision.mjs";
import type { DesktopSupervision, SupervisionInspector } from "../service/desktop-command-guard";
import { UpdateRestartRequired } from "./update-restart-candidate";
import { runProxyRestart, type ProxyRestartIo } from "./tray-proxy";

function evidenceForTarget(evidence: DesktopSupervision, pid: number | null | undefined): DesktopSupervision {
  // Injected inspectors must obey the same target binding as the production inspector.
  return evidence.kind === "desktop" && pid != null && evidence.runtimePid !== pid
    ? { kind: "unknown", reason: "unrelated-target", desktopSeen: false } : evidence;
}

export function duplicateRuntimeMessage(
  pid: number | null | undefined,
  port: number,
  inspect: SupervisionInspector = inspectDesktopSupervision,
): string {
  const latch = createSupervisionLatch();
  const evidence = evidenceForTarget(inspect({ targetPid: pid ?? undefined }), pid);
  if (pid != null && latch.observe(evidence)) {
    const supervisor = evidence.kind === "desktop" ? `, ${evidence.app}` : "";
    return `OpenCodex Desktop supervises the running proxy (pid ${pid}${supervisor}, port ${port}). `
      + "Use the running proxy, or quit OpenCodex before starting it from this CLI.";
  }
  return `⚠️  Proxy already running (PID ${pid ?? "unknown"}, port ${port}). Use 'ocx stop' first.`;
}

export function desktopStopNotice(evidence: DesktopSupervision): string | null {
  const latch = createSupervisionLatch();
  return latch.observe(evidence)
    ? "OpenCodex Desktop may start this proxy again after a short backoff. Use Stop Proxy or Quit in the OpenCodex menu to keep it stopped."
    : null;
}

export function runDesktopAwareProxyRestart(
  io: ProxyRestartIo,
  inspect: SupervisionInspector = inspectDesktopSupervision,
  info: (line: string) => void = console.log,
) {
  const latch = createSupervisionLatch();
  let targetPid: number | undefined;
  let supervisedRequest = false;
  return runProxyRestart({
    ...io,
    requestInPlaceRestart: async previous => {
      targetPid = previous.pid ?? undefined;
      const evidence = evidenceForTarget(inspect({ targetPid }), targetPid);
      supervisedRequest = latch.observe(evidence);
      const result = await io.requestInPlaceRestart(previous);
      if (evidence.kind === "desktop" && result.accepted) {
        info("Restart requested; OpenCodex Desktop starts the replacement.");
      }
      if (supervisedRequest && !result.accepted && !result.uncertain && result.error instanceof UpdateRestartRequired) {
        info("OpenCodex Desktop supervises this proxy. Use the app's updater (tray → Check for Updates), or quit OpenCodex before updating and restarting from this CLI.");
        return { accepted: false as const, uncertain: false, error: new Error("restart_desktop_update_required") };
      }
      return result;
    },
    startWhenStopped: async recovering => {
      const blocked = latch.observe(evidenceForTarget(inspect({ targetPid }), targetPid));
      // An accepted supervised handoff keeps its replacement intent through temporary absence.
      if (supervisedRequest || blocked) return { status: "skipped" as const };
      return io.startWhenStopped(recovering);
    },
  });
}
