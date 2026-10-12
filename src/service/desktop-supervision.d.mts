export type SupervisionEvidence =
  | { kind: "desktop"; runtimePid: number; supervisorPid: number; app: string; proxy: string }
  | { kind: "none" }
  | { kind: "unknown"; reason: string; desktopSeen: boolean }
  | { kind: "unsupported" };

export interface ProcReader {
  exe(pid: number): string;
  parent(pid: number): number;
}

export interface DesktopSupervisionDeps {
  targetPid?: number;
  platform?: NodeJS.Platform;
  run?: (command: string, args: string[]) => string;
  proc?: ProcReader;
  readPid?: () => number | null;
  readRuntimePortPid?: () => number | null;
}

export function desktopSupervisionPaths(): { pid: string; runtimePort: string };
export const procfs: ProcReader;
export function processIdentity(pid: number, execute?: DesktopSupervisionDeps["run"], onExecutable?: (path: string) => void):
  { parent: number; executable: string } | null;
export function inspectDesktopSupervision(deps?: DesktopSupervisionDeps): SupervisionEvidence;
export function createSupervisionLatch(): { observe(evidence: SupervisionEvidence): boolean };
