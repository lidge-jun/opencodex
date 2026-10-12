/**
 * Hidden `ocx internal ...` commands.
 *
 * Deliberately NOT in `src/cli/registry.ts` and NOT in `src/cli/capabilities.ts`, so it
 * is absent from help, from the generated skill surface, and from the registry-parity
 * gate. These are implementation entrypoints for the detached restart helper and
 * experimental ChatGPT stdout filter; compiled builds re-enter the same CLI binary.
 *
 * It is routed before the dispatch table for the same reason `help` is - adding it as a
 * runner key would make it a command the registry-parity test expects to find
 * documented.
 *
 * The restart handoff is intentionally unauthenticated, and that is not an oversight. Any process running
 * as this user can invoke it with a hand-written plan file, and it gains nothing by
 * doing so: the helper only does what the public `--restart-codex` flag already does for
 * that same user, and a same-uid process could call `kill` directly. A token here would
 * protect nothing and would imply a boundary that does not exist.
 */
const USAGE = "Usage: ocx internal desktop-restart-handoff --plan <path> | chatgpt-app-server-filter [--self-test]";

function optionValue(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

export async function handleInternalCommand(args: readonly string[]): Promise<number> {
  const sub = args[0];
  if (sub === "chatgpt-app-server-filter") {
    if (args.length > 2 || (args[1] !== undefined && args[1] !== "--self-test")) {
      console.error(USAGE);
      return 2;
    }
    const { runChatgptAppServerFilter } = await import("../chatgpt/app-server-shim/filter");
    return await runChatgptAppServerFilter({ selfTest: args[1] === "--self-test" });
  }
  if (sub !== "desktop-restart-handoff") {
    console.error(`Unknown internal command: ${sub ?? "(none)"}. ${USAGE}`);
    return 2;
  }
  const plan = optionValue(args, "--plan");
  if (!plan) {
    console.error(USAGE);
    return 2;
  }
  const { runDesktopRestartHandoff } = await import("../codex/desktop-app/handoff");
  const outcome = await runDesktopRestartHandoff(plan);
  // The operator is not watching this process - its terminal died with the app. The
  // exit code exists for a supervisor, and the readable record is the handoff log.
  return outcome === "restarted" ? 0 : 1;
}

