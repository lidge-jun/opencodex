import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { printSubcommandUsage, printUsage } from "../../src/cli/help";
import { CLI_COMMANDS, findCommand } from "../../src/cli/registry";
import { CAPABILITIES } from "../../src/cli/capabilities";
import { resolveHelpPath } from "../../src/cli/help-catalog";
import { repoPath, repoRoot } from "../helpers/repo-root";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { SPAWN_BUDGET_MS } from "../helpers/test-budget";

setDefaultTimeout(SPAWN_BUDGET_MS);

function capture(render: () => void): string {
  const lines: string[] = [];
  const original = console.log;
  console.log = value => { lines.push(String(value)); };
  try { render(); } finally { console.log = original; }
  return lines.join("\n");
}

function run(args: string[], columns = "80") {
  const home = mkdtempSync(join(tmpdir(), "ocx-help-navigation-"));
  const codex = join(home, "codex");
  const ocx = join(home, "ocx");
  mkdirSync(codex);
  mkdirSync(ocx);
  try {
    const result = spawnSync(process.execPath, [repoPath("src", "cli", "index.ts"), ...args], {
      cwd: repoRoot(), encoding: "utf8", timeout: SPAWN_BUDGET_MS - 5_000,
      env: { ...process.env, CODEX_HOME: codex, OPENCODEX_HOME: ocx, NO_COLOR: "1", COLUMNS: columns },
    });
    expect(result.error).toBeUndefined();
    expect(result.signal).toBeNull();
    // Bare provider retains preflight; these empty fixtures have nothing to restore.
    expect(readdirSync(codex)).toEqual([]);
    expect(readdirSync(ocx)).toEqual([]);
    return result;
  } finally { removeTreeWithRetry(home); }
}

describe("CLI help navigation", () => {
  test("compact root fits 28 lines and provides the three discovery escapes", () => {
    const output = capture(printUsage);
    expect(output.split("\n").length).toBeLessThanOrEqual(28);
    expect(output).toContain("Usage: ocx <command> [options]");
    expect(output).toContain("Read or follow request logs");
    expect(output).toContain("Report token usage and estimated cost");
    for (const heading of ["Start here:", "Common tasks:", "Explore:", "More help:"]) expect(output).toContain(heading);
    for (const invocation of ["ocx help --all", "ocx help <command>", "ocx capabilities --json"]) expect(output).toContain(invocation);
  });

  test("all root forms agree in narrow and normal redirected terminals", () => {
    const expected = `${capture(printUsage)}\n`;
    for (const [args, columns] of [[[], "80"], [["help"], "80"], [["--help"], "40"], [["-h"], "40"]] as const) {
      const result = run([...args], columns);
      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toBe(expected);
      expect(result.stdout).not.toMatch(/[\x00-\x09\x0b-\x1f\x7f]/);
    }
  });

  test("root groups reference public registry entries and preserve their summaries", () => {
    const output = capture(printUsage);
    const actions = [...output.matchAll(/^  ocx (setup|start|status|doctor|logs|usage)\s/gm)].map(match => match[1]);
    expect(actions).toEqual(["setup", "start", "status", "doctor", "logs", "usage"]);
    for (const name of actions) {
      const entry = findCommand(name);
      expect(entry?.hidden).not.toBe(true);
      expect(output.replace(/\s+/g, " ")).toContain(entry!.summary);
    }
    const families = output.split("Explore:\n")[1].split("\n\nMore help:")[0].trim().split(/\s+/);
    for (const name of families) {
      expect(findCommand(name)?.name).toBe(name);
      expect(findCommand(name)?.hidden).not.toBe(true);
    }
    for (const name of ["provider", "account", "models", "agent", "config", "system"]) expect(families).toContain(name);
    for (const entry of CLI_COMMANDS.filter(entry => entry.hidden)) expect(output).not.toContain(entry.name);
    expect(output.split("\n").every(line => line.length <= 80)).toBe(true);
  });

  test("family descendants come from capabilities while context remains a separate topic", () => {
    for (const name of ["provider", "account", "models"]) {
      const result = resolveHelpPath([name]);
      expect(result.kind).toBe("entry");
      if (result.kind !== "entry") throw new Error("expected family help");
      expect(result.canonicalName).toBe(name);
      expect(result.children).toEqual(CAPABILITIES.filter(cap => cap.command[0] === name && cap.command.length > 1));
      const output = capture(() => printSubcommandUsage(name));
      for (const child of result.children) expect(output).toContain(`ocx help ${child.command.join(" ")}`);
    }
    expect(CAPABILITIES.some(cap => cap.command.join(" ") === "models context")).toBe(false);
    expect(capture(() => printSubcommandUsage("models"))).toContain("Context cap help: ocx help models context");
  });

  test("provider examples use real command names and no credential-shaped samples", () => {
    const output = capture(() => printSubcommandUsage("provider"));
    const examples = output.split("Examples:\n")[1].split("\n\n")[0].split("\n");
    expect(examples.length).toBeGreaterThan(0);
    for (const example of examples) {
      const tokens = example.trim().split(/\s+/);
      expect(tokens.slice(0, 2)).toEqual(["ocx", "provider"]);
      expect(["list", "presets", "add", "show", "set-default", "edit", "remove"]).toContain(tokens[2]);
      expect(example).not.toMatch(/sk-[a-z]|Bearer [A-Za-z0-9]/);
    }
    expect(output).toContain("--api-key <key>");
    expect(output).toContain("ocx help provider list");
    expect(output).not.toContain("ocx help provider\n");
  });

  test("family help preserves alias usage and adds canonical declared topics", () => {
    const output = capture(() => printSubcommandUsage("model"));
    expect(output.startsWith("Usage: ocx model <subcommand>\n\nAlias of ocx models.")).toBe(true);
    expect(output).toContain("Canonical help: ocx help models");
    expect(output).toContain("ocx help models context");
    const account = capture(() => printSubcommandUsage("account"));
    expect(account).toContain("Declared commands (incomplete)");
    expect(account).toContain("ocx help account list");
    expect(account).not.toContain("/api/");
  });

  test("provider no-args and explicit help have identical rich stdout", () => {
    const outputs = [["provider"], ["help", "provider"], ["provider", "--help"]].map(args => {
      const result = run(args);
      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toContain("ocx provider list --jsonl");
      expect(result.stdout).toContain("ocx provider presets --json");
      expect(result.stdout).not.toContain("ocx provider --help");
      return result.stdout;
    });
    expect(new Set(outputs).size).toBe(1);
  });

  test("unknown provider action keeps help on stderr and exit one", () => {
    const result = run(["provider", "not-a-provider-action"]);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe(`Unknown provider subcommand: not-a-provider-action\n${capture(() => printSubcommandUsage("provider"))}\n`);
  });

  test("the help write sink survives parent fallback", () => {
    const lines: string[] = [];
    const stdout = capture(() => printSubcommandUsage("models", ["models", "context", "provider", "example"], {
      fallbackToParent: true, write: value => { lines.push(value); },
    }));
    expect(stdout).toBe("");
    expect(lines.join("\n")).toContain("ocx models context provider <provider> <on|off>");
  });
});
