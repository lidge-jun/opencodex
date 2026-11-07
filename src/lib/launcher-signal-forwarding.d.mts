export function launcherForwardedSignals(platform?: NodeJS.Platform): NodeJS.Signals[];
export interface LauncherSignalForwarding {
  attach(child: { kill(signal: NodeJS.Signals): unknown }): void;
  clear(): void;
}
export function forwardLauncherSignals(deps?: {
  parent?: Pick<NodeJS.Process, "on" | "removeListener">; platform?: NodeJS.Platform;
}): LauncherSignalForwarding;
