import { createSupervisionLatch, inspectDesktopSupervision } from "./desktop-supervision.mjs";

export { createSupervisionLatch };
export type DesktopSupervision = ReturnType<typeof inspectDesktopSupervision>;
export type SupervisionInspector = (deps?: Parameters<typeof inspectDesktopSupervision>[0]) => DesktopSupervision;
export type SupervisionLatch = ReturnType<typeof createSupervisionLatch>;

export function desktopServiceRefusal(evidence: DesktopSupervision, blocked: boolean): string | null {
  if (!blocked) return null;
  const runtime = evidence.kind === "desktop" ? ` (pid ${evidence.runtimePid}, ${evidence.app})` : "";
  return `OpenCodex Desktop supervises the running proxy${runtime}. `
    + "Quit OpenCodex, then rerun 'ocx service install' to move startup management to this CLI.";
}

export function assertNoDesktopSupervision(
  inspect: SupervisionInspector = inspectDesktopSupervision,
  latch: SupervisionLatch = createSupervisionLatch(),
): void {
  const evidence = inspect();
  const refusal = desktopServiceRefusal(evidence, latch.observe(evidence));
  if (refusal) throw new Error(refusal);
}

export function desktopServiceCommandRefusal(
  command: string,
  inspect: SupervisionInspector = inspectDesktopSupervision,
  latch: SupervisionLatch = createSupervisionLatch(),
): string | null {
  if (!["install", "repair", "start", "restart"].includes(command)) return null;
  const evidence = inspect();
  return desktopServiceRefusal(evidence, latch.observe(evidence));
}
