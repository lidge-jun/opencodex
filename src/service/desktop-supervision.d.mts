export type SupervisionEvidence =
  | { kind: "desktop"; runtimePid: number; supervisorPid: number; app: string; proxy: string }
  | { kind: "none" }
  | { kind: "unknown"; reason: string; desktopSeen: boolean }
  | { kind: "unsupported" };

export interface ProcReader {
  exe(pid: number): string;
  parent(pid: number): number;
}

/** One Win32_Process row; `created` is UTC ticks as a decimal string (exceeds 2^53). */
export interface WindowsProcessRow {
  pid: number;
  parent: number;
  exe: string | null;
  session: number;
  created: string;
}

export interface WindowsProcessPair {
  child: WindowsProcessRow | null;
  parent: WindowsProcessRow | null;
}

export interface WindowsProcessReadOptions {
  /** Called with the parent image before row validation, so partial Desktop evidence keeps its veto. */
  onExecutable?: (path: string) => void;
  timeoutMs?: number;
  resolveSystemDirectory?: () => string;
}

export interface DesktopSupervisionDeps {
  targetPid?: number;
  platform?: NodeJS.Platform;
  run?: (command: string, args: string[], timeoutMs?: number, env?: NodeJS.ProcessEnv) => string;
  proc?: ProcReader;
  readPid?: () => number | null;
  readRuntimePortPid?: () => number | null;
  windowsProcesses?: (pid: number, options: Pick<WindowsProcessReadOptions, "onExecutable" | "timeoutMs">) => WindowsProcessPair | null;
  resolveWindowsSystemDirectory?: () => string;
  now?: () => number;
}

export function desktopSupervisionPaths(): { pid: string; runtimePort: string };
export const procfs: ProcReader;
export function processIdentity(pid: number, execute?: DesktopSupervisionDeps["run"], onExecutable?: (path: string) => void):
  { parent: number; executable: string } | null;
export function windowsPowerShellPath(resolveSystemDirectory?: () => string): string;
/** Pure consistency check over loaded-module paths; throws unless exactly one well-formed
 *  namesake per KnownDLL shares one parent directory. Exported for tests. */
export function windowsSystemDirectoryFromSharedObjects(loaded: unknown): string;
export function windowsProcessPair(pid: number, execute?: DesktopSupervisionDeps["run"], options?: WindowsProcessReadOptions): WindowsProcessPair;
export function inspectDesktopSupervision(deps?: DesktopSupervisionDeps): SupervisionEvidence;
export function createSupervisionLatch(): { observe(evidence: SupervisionEvidence): boolean };
