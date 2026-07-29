export interface NpmInvocationDeps {
  cwd?: string;
  exists?: (path: string) => boolean;
}

export interface NpmInvocation {
  file: string;
  args: string[];
  options: { windowsVerbatimArguments?: boolean };
}

export declare function resolveNpmCommand(
  platform?: NodeJS.Platform,
  env?: Record<string, string | undefined>,
  deps?: NpmInvocationDeps,
): string | null;

export declare function npmInvocation(
  args: readonly string[],
  platform?: NodeJS.Platform,
  env?: Record<string, string | undefined>,
  deps?: NpmInvocationDeps,
): NpmInvocation | null;
