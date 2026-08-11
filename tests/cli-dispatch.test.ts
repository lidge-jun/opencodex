import { describe, expect, test } from "bun:test";
import { CLI_COMMANDS } from "../src/cli/registry";
import { DISPATCH_ALIASES, DISPATCH_COMMANDS, dispatchCommand } from "../src/cli/dispatch";
import type { CliDispatchDeps } from "../src/cli/dispatch";

/** Minimal fake deps. dispatchCommand only touches deps for real command
 * runners, which these tests never invoke, so an empty object is enough. */
const fakeDeps = {} as unknown as CliDispatchDeps;

describe("CLI dispatch command coverage", () => {
  test("every non-hidden registry command is dispatchable", () => {
    const aliasResolved = new Set([...DISPATCH_COMMANDS, ...DISPATCH_ALIASES.keys()]);
    const missing = CLI_COMMANDS.filter(entry => {
      if (entry.hidden) return false;
      // A visible command counts as dispatchable when it is a direct runner
      // key or an alias that resolves to one (setup/eject/remove/model).
      return !aliasResolved.has(entry.name);
    }).map(entry => entry.name);
    expect(missing).toEqual([]);
  });

  test("every dispatch alias resolves to a dispatchable command", () => {
    for (const [alias, target] of DISPATCH_ALIASES) {
      expect(DISPATCH_COMMANDS).toContain(target);
      expect(alias).not.toBe(target);
    }
  });
});

describe("CLI dispatch aliases", () => {
  test("canonical alias pairs resolve to their command", () => {
    expect(DISPATCH_ALIASES.get("setup")).toBe("init");
    expect(DISPATCH_ALIASES.get("eject")).toBe("restore");
    expect(DISPATCH_ALIASES.get("remove")).toBe("uninstall");
    expect(DISPATCH_ALIASES.get("model")).toBe("models");
  });
});

describe("dispatchCommand exit codes", () => {
  test("returns 0 for help forms", async () => {
    expect(await dispatchCommand({ kind: "help", command: "help", args: ["help"] }, fakeDeps)).toBe(0);
    expect(await dispatchCommand({ kind: "help", command: "--help", args: ["--help"] }, fakeDeps)).toBe(0);
    expect(await dispatchCommand({ kind: "command", command: undefined, args: [] }, fakeDeps)).toBe(0);
  });

  test("returns 1 for an unknown command", async () => {
    const head = { kind: "command" as const, command: "definitely-not-a-command", args: ["definitely-not-a-command"] };
    expect(await dispatchCommand(head, fakeDeps)).toBe(1);
  });
});
