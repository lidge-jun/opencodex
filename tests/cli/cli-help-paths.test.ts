import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CAPABILITIES, HEAD_CAPABILITIES } from "../../src/cli/capabilities";
import { runCapabilities } from "../../src/cli/capabilities-command";
import { resolveHelpPath } from "../../src/cli/help-catalog";
import { printSubcommandUsage } from "../../src/cli/help";
import { MODELS_CONTEXT_USAGE } from "../../src/cli/help-models-context";
import { MODELS_RUNTIME_USAGE } from "../../src/cli/models-runtime";
import { repoPath, repoRoot } from "../helpers/repo-root";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { SPAWN_BUDGET_MS } from "../helpers/test-budget";

setDefaultTimeout(SPAWN_BUDGET_MS);

function help(args: string[]) {
  const home = mkdtempSync(join(tmpdir(), "ocx-help-path-"));
  const codex = join(home, "codex-home");
  const ocx = join(home, "ocx-home");
  mkdirSync(codex);
  mkdirSync(ocx);
  const wrapper = join(home, "codex");
  const backup = join(home, "codex.opencodex-real");
  const state = join(ocx, "codex-shim.json");
  writeFileSync(wrapper, "replacement launcher\n");
  writeFileSync(backup, "original launcher\n");
  writeFileSync(state, JSON.stringify({ platform: process.platform, wrapperPath: wrapper, originalPath: wrapper, backupPath: backup }));
  const before = [wrapper, backup, state].map(file => readFileSync(file, "utf8"));
  try {
    const cli = repoPath("src", "cli", "index.ts");
    // The real entry point still owns argv and early exits; forbid live HTTP.
    const script = `globalThis.fetch = () => { throw new Error("help attempted HTTP"); };
      process.argv = [process.execPath, ${JSON.stringify(cli)}, ...${JSON.stringify(args)}];
      await import(${JSON.stringify(cli)});`;
    const result = spawnSync(process.execPath, ["-e", script], {
      cwd: repoRoot(), encoding: "utf8", timeout: SPAWN_BUDGET_MS - 5_000,
      env: { ...process.env, CODEX_HOME: codex, OPENCODEX_HOME: ocx },
    });
    expect(result.error).toBeUndefined();
    expect(result.signal).toBeNull();
    expect([wrapper, backup, state].map(file => readFileSync(file, "utf8"))).toEqual(before);
    expect(readdirSync(codex)).toEqual([]);
    expect(readdirSync(ocx)).toEqual(["codex-shim.json"]);
    return result;
  } finally {
    removeTreeWithRetry(home);
  }
}

describe("explicit CLI help paths", () => {
  test("full-reference forms agree and preserve detailed variants", () => {
    const full = help(["help", "--all"]);
    expect(full.status).toBe(0);
    for (const args of [["help", "--all"], ["--help", "--all"]]) {
      const result = help(args);
      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toBe(full.stdout);
      expect(result.stdout).toContain("--legacy-openai --yes");
      expect(result.stdout).toContain("--ocx-compaction <thread-id> --yes");
      expect(result.stdout).not.toContain("__tray-start");
    }
  });

  test("context topic resolves identically from command, flag and alias help", () => {
    const expected = "  ocx models context <status|value <tokens> [--set-all]|provider <name> on [--value <tokens>]|provider <name> off|all <on|off>> [--json]";
    expect(MODELS_CONTEXT_USAGE).toBe(expected);
    expect(MODELS_RUNTIME_USAGE.split("\n").filter(line => line.includes("ocx models context"))).toEqual([expected]);
    const outputs = [["help", "models", "context"], ["models", "context", "--help"], ["model", "context", "--help"]].map(args => {
      const result = help(args);
      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toContain(expected);
      expect(result.stdout).toContain("ocx models context status --json");
      return result.stdout;
    });
    expect(new Set(outputs).size).toBe(1);
  });

  test("declared leaves show verified usage and exact operands", () => {
    const result = help(["help", "account", "list"]);
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Usage: ocx account list [provider]");
    expect(result.stdout).toContain("--json");
    expect(result.stdout).toContain("--quota");
    expect(result.stdout).toContain("Parent help: ocx help account");
    expect(result.stdout).not.toContain("not the full operand grammar");
  });

  test("command-side help with operands falls back to known help without writes", () => {
    for (const [args, expected] of [
      [["service", "uninstall", "--help"], "Usage: ocx service"],
      [["codex-shim", "uninstall", "--help"], "Usage: ocx codex-shim"],
      [["models", "context", "provider", "example", "on", "-h"], "ocx models context provider <provider> <on|off>"],
    ] as const) {
      const result = help([...args]);
      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toContain(expected);
    }
  });

  test("declared prefixes show children with incomplete coverage explicit", () => {
    const result = help(["help", "account", "main"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Declared commands (incomplete)");
    expect(result.stdout).toContain("ocx account main reauth");
    expect(result.stdout).not.toContain("Usage:");
  });

  test("runnable capability parents retain their usage and expose deeper help", () => {
    const path = ["access", "key"];
    const result = resolveHelpPath(path);
    expect(result.kind).toBe("capability");
    if (result.kind !== "capability") throw new Error("expected capability help");
    expect(result.children.map(child => child.command.join(" "))).toContain("access key list");
    expect(result.children.map(child => child.command.join(" "))).toContain("access key rotate commit");
    expect(result.children.some(child => child.command.length <= path.length)).toBe(false);
    const output = help(["help", ...path]);
    expect(output.status).toBe(0);
    expect(output.stderr).toBe("");
    expect(output.stdout).toContain("Usage: ocx access key list [--json]");
    expect(output.stdout).toContain("Declared commands (incomplete)");
    expect(output.stdout).toContain("ocx help access key list");
    expect(output.stdout).toContain("ocx help access key rotate commit");
    expect(output.stdout).toContain("Parent help: ocx help access");
    const leaf = resolveHelpPath(["access", "key", "list"]);
    expect(leaf).toMatchObject({ kind: "capability", children: [] });
  });

  test("undeclared detail does not claim runtime grammar is invalid", () => {
    for (const [path, parent] of [
      [["service", "not-declared"], "service"],
      [["codex-shim", "not-declared"], "codex-shim"],
      [["models", "not-declared"], "models"],
      [["account", "main", "not-declared"], "account main"],
      [["models", "context", "not-declared"], "models context"],
    ] as const) {
      const result = help(["help", ...path]);
      expect(result.status).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("Detailed help unavailable");
      expect(result.stderr).toContain(`ocx help ${parent}`);
      expect(result.stderr).not.toMatch(/unknown command|unsupported|invalid/i);
    }
  });

  test("unknown roots use stderr recovery and leave stdout empty", () => {
    const result = help(["help", "nosuch"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Unknown command: nosuch");
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("ocx help --all");
    expect(result.stderr.trim().split("\n").length).toBeLessThan(10);
  });

  test("unavailable detail never echoes arbitrary operands or terminal controls", () => {
    const result = help(["help", "account", "main", "private-operand-123\u001b[2J"]);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("Detailed help unavailable for the requested topic.\nSee: ocx help account main\n");
  });

  test("exact alias entries and explicit hidden help remain available", () => {
    for (const name of ["setup", "eject", "remove", "model", "__tray-start"]) {
      expect(resolveHelpPath([name])).toMatchObject({ kind: "entry", entry: { name } });
    }
    expect(resolveHelpPath(["model", "context"]).kind).toBe("models-context");
    expect(resolveHelpPath(["account", "main"]).kind).toBe("prefix");
    expect(resolveHelpPath(["account", "list"]).kind).toBe("capability");
  });

  test("access aliases resolve nested help without changing exact root help", () => {
    const root = resolveHelpPath(["api-key"]);
    expect(root).toMatchObject({ kind: "entry", entry: { name: "api-key" }, canonicalName: "access key" });
    const rootOutput = help(["help", "api-key"]);
    expect(rootOutput.status).toBe(0);
    expect(rootOutput.stdout).toContain("Usage: ocx api-key ");
    expect(rootOutput.stdout).toContain("Canonical help: ocx help access key");
    expect(rootOutput.stdout).toContain("ocx help access key list");
    const canonical = help(["help", "access", "key", "remove"]);
    expect(canonical.status).toBe(0);
    for (const path of [["api-key", "delete"], ["api-key", "remove"], ["access", "keys", "delete"], ["access", "key", "delete"]]) {
      const before = [...path];
      expect(resolveHelpPath(path)).toMatchObject({ kind: "capability", path: ["access", "key", "remove"] });
      expect(path).toEqual(before);
      for (const args of [["help", ...path], [...path, "--help"]]) {
        const output = help(args);
        expect(output.status).toBe(0);
        expect(output.stderr).toBe("");
        expect(output.stdout).toBe(canonical.stdout);
      }
    }
    const rotate = help(["help", "api-key", "rotate", "commit"]);
    expect(rotate.status).toBe(0);
    expect(rotate.stdout).toContain("Parent help: ocx help access key rotate");
    const operand = ["access", "keys", "get", "delete"];
    expect(resolveHelpPath(operand)).toMatchObject({
      kind: "unavailable", path: ["access", "key", "get", "delete"], parent: ["access", "key", "get"],
    });
    expect(operand).toEqual(["access", "keys", "get", "delete"]);
    for (const path of [["access", "delete"], ["provider", "delete"], ["access", "key", "rotate", "delete"]]) {
      expect(resolveHelpPath(path)).toMatchObject({ kind: "unavailable", path });
    }
  });

  test("help lookup and rendering preserve machine capability JSON", async () => {
    const metadata = JSON.stringify({ CAPABILITIES, HEAD_CAPABILITIES });
    const lines: string[] = [];
    const original = console.log;
    console.log = (...values: unknown[]) => { lines.push(values.map(String).join(" ")); };
    try {
      expect(await runCapabilities(["--json"])).toBe(0);
      const before = lines.join("\n");
      for (const capability of CAPABILITIES) resolveHelpPath(capability.command);
      printSubcommandUsage("account", ["account", "list"]);
      printSubcommandUsage("account", ["account", "main"]);
      printSubcommandUsage("model", ["model", "context"]);
      lines.length = 0;
      expect(await runCapabilities(["--json"])).toBe(0);
      expect(lines.join("\n")).toBe(before);
      expect(JSON.stringify({ CAPABILITIES, HEAD_CAPABILITIES })).toBe(metadata);
    } finally {
      console.log = original;
    }
  });
});
