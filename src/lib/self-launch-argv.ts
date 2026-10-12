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

/** Argv for a detached `start`, optionally hard-pinning the listen port. */
export function startArgv(port?: number): string[] {
  const args = ["start"];
  if (typeof port === "number" && Number.isFinite(port) && port > 0 && port <= 65535) {
    args.push("--port", String(Math.trunc(port)));
  }
  return selfLaunchArgv(args);
}
