export interface DesktopCliIo {
  stat?: (path: string) => { isFile(): boolean };
  access?: (path: string, mode: number) => void;
}
export interface PathBunIo extends DesktopCliIo {
  now?: () => number;
  realpath?: (path: string) => string;
  stat?: (path: string) => { isFile(): boolean; mode: number };
  isRealBunBinary?: (path: string) => boolean;
  spawnSync?: (path: string, args: string[], options: {
    env: NodeJS.ProcessEnv;
    encoding: "utf8";
    timeout: number;
    maxBuffer: number;
    killSignal: "SIGKILL";
    shell: false;
    windowsHide: true;
    stdio: ["ignore", "pipe", "pipe"];
  }) => { status: number | null; stdout?: string; signal?: string | null; error?: unknown };
}
export declare function findPathBun(options: {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  pinnedVersion: string;
  deadlineMs?: number;
  io?: PathBunIo;
}): { path: string; version: string } | null;
export declare function findDesktopCli(options?: {
  platform?: NodeJS.Platform;
  home?: string;
  io?: DesktopCliIo;
}): string | null;
