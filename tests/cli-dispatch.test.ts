import { describe, expect, test } from "bun:test";
import { CLI_COMMANDS } from "../src/cli/registry";
import { DISPATCH_ALIASES, DISPATCH_COMMANDS, dispatchCommand, resolveDispatchCommand } from "../src/cli/dispatch";
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

  test("resolveDispatchCommand maps each alias to its canonical runner key", () => {
    // The same resolver dispatchCommand uses for runner selection, exercised
    // at the resolution level so a regression in the lookup is caught.
    expect(resolveDispatchCommand("setup")).toBe("init");
    expect(resolveDispatchCommand("eject")).toBe("restore");
    expect(resolveDispatchCommand("remove")).toBe("uninstall");
    expect(resolveDispatchCommand("model")).toBe("models");
    // Canonical names resolve to themselves; unknown names resolve undefined.
    expect(resolveDispatchCommand("init")).toBe("init");
    expect(resolveDispatchCommand("definitely-not-a-command")).toBeUndefined();
    expect(resolveDispatchCommand(undefined)).toBeUndefined();
  });

  test("resolveDispatchCommand rejects inherited Object property names", () => {
    // commandRunners is a normal object; inherited names (__proto__,
    // constructor, toString) must not resolve as valid commands.
    expect(resolveDispatchCommand("__proto__")).toBeUndefined();
    expect(resolveDispatchCommand("constructor")).toBeUndefined();
    expect(resolveDispatchCommand("toString")).toBeUndefined();
  });
});

describe("dispatchCommand exit codes", () => {
  test("returns 0 for help forms", async () => {
    expect(await dispatchCommand({ kind: "help", command: "help", args: ["help"] }, fakeDeps)).toBe(0);
    expect(await dispatchCommand({ kind: "help", command: "--help", args: ["--help"] }, fakeDeps)).toBe(0);
    expect(await dispatchCommand({ kind: "help", command: "-h", args: ["-h"] }, fakeDeps)).toBe(0);
    expect(await dispatchCommand({ kind: "command", command: undefined, args: [] }, fakeDeps)).toBe(0);
  });

  test("returns 1 for an unknown command", async () => {
    const head = { kind: "command" as const, command: "definitely-not-a-command", args: ["definitely-not-a-command"] };
    expect(await dispatchCommand(head, fakeDeps)).toBe(1);
  });

  test("returns 1 for inherited Object property names", async () => {
    for (const name of ["__proto__", "constructor", "toString"]) {
      const head = { kind: "command" as const, command: name, args: [name] };
      expect(await dispatchCommand(head, fakeDeps), `${name} must be unknown`).toBe(1);
    }
  });

  test("forwards service arguments and preserves handler exit codes", async () => {
    const previousExitCode = process.exitCode;
    try {
      process.exitCode = 7;
      const successCalls: string[][] = [];
      const successDeps = {
        ...fakeDeps,
        args: ["service", "install", "--scheduler"],
        serviceCommand: async (...args: string[]) => {
          successCalls.push(args);
        },
      };

      expect(await dispatchCommand(
        { kind: "command", command: "service", args: successDeps.args },
        successDeps,
      )).toBe(0);
      expect(successCalls).toEqual([["install", "--scheduler"]]);

      for (const expected of [1, 2]) {
        const calls: string[][] = [];
        const deps = {
          ...fakeDeps,
          args: ["service", "install", "--scheduler"],
          serviceCommand: async (...args: string[]) => {
            calls.push(args);
            process.exitCode = expected;
          },
        };

        expect(await dispatchCommand(
          { kind: "command", command: "service", args: deps.args },
          deps,
        )).toBe(expected);
        expect(calls).toEqual([["install", "--scheduler"]]);
      }
    } finally {
      process.exitCode = previousExitCode ?? 0;
    }
  });
});
