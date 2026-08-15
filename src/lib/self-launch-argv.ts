interface SelfLaunchArgvOptions {
  isStandaloneExecutable?: boolean;
  sourceEntrypoint?: string;
}

/** Build argv for re-entering the current CLI in compiled or source mode. */
export function selfLaunchArgv(
  args: readonly string[],
  options: SelfLaunchArgvOptions = {},
): string[] {
  const bunStandalone = (Bun as unknown as { isStandaloneExecutable?: boolean }).isStandaloneExecutable;
  const isStandaloneExecutable = options.isStandaloneExecutable ?? Boolean(bunStandalone);
  if (isStandaloneExecutable) return [...args];
  return [options.sourceEntrypoint ?? process.argv[1], ...args];
}
