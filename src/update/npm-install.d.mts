import type { NpmInvocation } from "./npm-invocation.mjs";

export declare function runWindowsInstallerSync(invocation: NpmInvocation, options?: {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  timeoutMs?: number;
  authorizeMutation?: (kind: "package") => boolean;
  markerPath?: string;
}): { status: number | null; processTreeExited: boolean };
export declare function runNpmInstall(invocation: NpmInvocation | null, options?: {
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  authorizeMutation?: (kind: "package") => boolean;
  markerPath?: string;
}): Promise<{ status: number | null; processTreeExited: boolean; error?: { code?: string; message: string } }>;
export declare function setWindowsInstallerSupervisorForTests(seams: {
  platform?: NodeJS.Platform;
  launch?: (file: string, args: string[], options: { env: NodeJS.ProcessEnv; windowsHide: boolean; stdio: ["pipe", "pipe", "pipe"] }) => import("node:child_process").ChildProcess;
} | null): void;
