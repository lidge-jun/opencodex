import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { CLI_COMMANDS, findCommand } from "../src/cli/registry";
import { DISPATCH_ALIASES, DISPATCH_COMMANDS } from "../src/cli/dispatch";

describe("CLI command registry parity", () => {
  /** Runner keys in src/cli/dispatch.ts (the dispatch table that replaced the
   * top-level switch in src/cli/index.ts). */
  const cases = [...DISPATCH_COMMANDS];
  const caseSet = new Set(cases);
  const registryNames = new Set(CLI_COMMANDS.flatMap(entry => [entry.name, ...(entry.aliases ?? [])]));

  test("every top-level switch case resolves in the registry", () => {
    // `help`/`--help`/`-h` are head-handled pseudo-cases, not commands. They
    // still exist as dispatch runners so a bare `ocx help` reaches printUsage,
    // but they are not registry entries; exclude them only while dispatch does
    // not list them as commands.
    const headHandled = new Set(["help", "--help", "-h"]);
    const unresolvable = cases.filter(name => !(headHandled.has(name) && !registryNames.has(name)) && !registryNames.has(name));
    expect(unresolvable).toEqual([]);
  });

  test("every registry entry has a top-level switch case", () => {
    // Every canonical entry.name must be a direct runner key in the dispatch
    // table (a missing canonical case must never pass via an alias). Alias
    // entries (setup/eject/remove/model) are not standalone runner keys; they
    // resolve through DISPATCH_ALIASES and are asserted separately below.
    const aliasNames = new Set([...DISPATCH_ALIASES.keys()]);
    const missing = CLI_COMMANDS
      .filter(entry => !aliasNames.has(entry.name) && !caseSet.has(entry.name))
      .map(entry => entry.name);
    expect(missing).toEqual([]);
  });

  test("alias entries keep their own help entry (exact name wins over alias)", () => {
    // `setup`, `eject`, `remove`, `model` each have their own help text; an
    // alias lookup must not shadow them with the canonical entry.
    expect(findCommand("setup")?.name).toBe("setup");
    expect(findCommand("eject")?.name).toBe("eject");
    expect(findCommand("remove")?.name).toBe("remove");
    expect(findCommand("model")?.name).toBe("model");
    expect(findCommand("init")?.name).toBe("init");
    expect(findCommand("uninstall")?.name).toBe("uninstall");
    expect(findCommand("models")?.name).toBe("models");
  });

  test("canonical entries declare the alias pairs", () => {
    const aliasesOf = (name: string): string[] => CLI_COMMANDS.find(entry => entry.name === name)?.aliases ?? [];
    expect(aliasesOf("init")).toContain("setup");
    expect(aliasesOf("restore")).toContain("eject");
    expect(aliasesOf("uninstall")).toContain("remove");
    expect(aliasesOf("models")).toContain("model");
  });

  test("every declared alias resolves through DISPATCH_ALIASES to a runner key", () => {
    for (const entry of CLI_COMMANDS) {
      for (const alias of entry.aliases ?? []) {
        expect(DISPATCH_ALIASES.get(alias), `alias ${alias} must resolve`).toBe(entry.name);
        expect(caseSet.has(entry.name), `canonical ${entry.name} must be a runner key`).toBe(true);
      }
    }
  });

  test("hidden entries are flagged and do not appear in help lookups by accident", () => {
    const hidden = CLI_COMMANDS.filter(entry => entry.hidden);
    expect(hidden.map(entry => entry.name).sort()).toEqual([
      "__gui-update-worker",
      "__refresh-version",
      "__startup-health",
      "__tray-host",
      "__tray-restart",
      "__tray-start",
    ]);
    for (const entry of hidden) {
      expect(caseSet.has(entry.name)).toBe(true);
      expect(findCommand(entry.name)?.name).toBe(entry.name);
    }
  });

  test("internal tray commands are dispatched as explicit runners", () => {
    const internalRunners = [
      "__tray-start",
      "__tray-restart",
      "__startup-health",
      "__tray-host",
      "__gui-update-worker",
      "__refresh-version",
    ];
    for (const name of internalRunners) {
      expect(DISPATCH_COMMANDS).toContain(name);
      const entry = CLI_COMMANDS.find(command => command.name === name);
      expect(entry?.hidden).toBe(true);
    }
  });

  test("entry names are unique", () => {
    const names = CLI_COMMANDS.map(entry => entry.name);
    expect(new Set(names).size).toBe(names.length);
  });
});

describe("help banner command coverage", () => {
  // The banner is curated (aliases shown inline, subcommands elided), so it is
  // not required to match the registry exactly. It must never drop a visible
  // command entirely: every visible canonical command has to appear.
  test("every visible canonical command appears in the printUsage banner", () => {
    const helpSrc = readFileSync(fileURLToPath(new URL("../src/cli/help.ts", import.meta.url)), "utf8");

    // Commands whose `name` is only ever used as another entry's alias
    // (setup/eject/remove/model) are shown inline as "(alias: ...)" rather
    // than as their own banner line, so they are not required here.
    const aliasNames = new Set<string>();
    for (const entry of CLI_COMMANDS) {
      for (const alias of entry.aliases ?? []) aliasNames.add(alias);
    }

    const missing = CLI_COMMANDS.filter(entry => {
      if (entry.hidden) return false;
      if (aliasNames.has(entry.name)) return false;
      // A command counts as covered when the banner carries its full usage
      // line or its canonical name at the start of an `ocx <name>` banner line.
      const escaped = entry.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const commandLine = new RegExp(`^\\s*ocx\\s+${escaped}(?:\\s|$)`, "m");
      return !helpSrc.includes(entry.usage) && !commandLine.test(helpSrc);
    }).map(entry => entry.name);

    expect(missing).toEqual([]);
  });
});
