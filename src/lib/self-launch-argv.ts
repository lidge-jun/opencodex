interface SelfLaunchArgvOptions {
  isStandaloneExecutable?: boolean;
  sourceEntrypoint?: string;
}

function bunStandaloneExecutable(): boolean | undefined {
  const runtime: unknown = Bun;
  if (runtime === null || typeof runtime !== "object" || !("isStandaloneExecutable" in runtime)) {
    return undefined;
  }
  return typeof runtime.isStandaloneExecutable === "boolean"
    ? runtime.isStandaloneExecutable
    : undefined;
}

/** Build argv for re-entering the current CLI in compiled or source mode. */
export function selfLaunchArgv(
  args: readonly string[],
  options: SelfLaunchArgvOptions = {},
): string[] {
  const bunStandalone = bunStandaloneExecutable();
  const isStandaloneExecutable = options.isStandaloneExecutable ?? Boolean(bunStandalone);
  if (isStandaloneExecutable) return [...args];
  return [options.sourceEntrypoint ?? process.argv[1], ...args];
}
