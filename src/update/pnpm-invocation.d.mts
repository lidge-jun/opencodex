export interface PnpmInvocationDeps {
  cwd?: string;
  exists?: (path: string) => boolean;
}

export interface PnpmInvocation {
  file: string;
  args: string[];
  options: { windowsVerbatimArguments?: boolean };
}

export declare function resolvePnpmCommands(
  platform?: NodeJS.Platform,
  env?: Record<string, string | undefined>,
  deps?: PnpmInvocationDeps,
): string[];

export declare function pnpmInvocationForPath(
  pnpm: string,
  args: readonly string[],
  platform?: NodeJS.Platform,
  env?: Record<string, string | undefined>,
): PnpmInvocation | null;

export declare function resolvePnpmCommand(
  platform?: NodeJS.Platform,
  env?: Record<string, string | undefined>,
  deps?: PnpmInvocationDeps,
): string | null;

export declare function pnpmInvocation(
  args: readonly string[],
  platform?: NodeJS.Platform,
  env?: Record<string, string | undefined>,
  deps?: PnpmInvocationDeps,
): PnpmInvocation | null;

export declare function pnpmInvocations(
  args: readonly string[],
  platform?: NodeJS.Platform,
  env?: Record<string, string | undefined>,
  deps?: PnpmInvocationDeps,
): PnpmInvocation[];
