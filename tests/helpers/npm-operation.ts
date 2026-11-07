/**
 * The npm operation a spawnSync call invokes: argv[0] of a direct invocation, or the
 * first `^"arg"`-wrapped token of a `cmd /d /s /c` verbatim line. npmInvocation wraps
 * every argument but never the executable, so a spaced install path — even one
 * containing a bare `view` word — cannot forge an operation token, and an install's
 * later `view`-named argument stays out of position 0.
 */
export function spawnedNpmOperation(
  args: readonly string[],
  options: { windowsVerbatimArguments?: boolean } = {},
): string | undefined {
  if (options.windowsVerbatimArguments && args.slice(0, 3).join(" ") === "/d /s /c") {
    return /\^"(.*?)\^"/.exec(args[3] ?? "")?.[1];
  }
  return args[0];
}
