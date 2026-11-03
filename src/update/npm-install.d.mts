import type { NpmInvocation } from "./npm-invocation.mjs";

export declare function runWindowsInstallerSync(invocation: NpmInvocation, options?: {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  timeoutMs?: number;
  authorizeMutation?: (kind: "package") => boolean;
}): { status: number | null; processTreeExited: boolean };
