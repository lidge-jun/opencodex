export declare function runPosixInstallerSync(options: {
  file: string;
  args: string[];
  markerPath: string;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  authorizeMutation?: (kind: "package") => boolean;
}): { status: number | null; signal?: NodeJS.Signals | null; groupExited: boolean; groupKilled?: boolean; processTreeExited?: boolean };
export declare function runPosixInstallerSupervisorMain(): Promise<void>;
