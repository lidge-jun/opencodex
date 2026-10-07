import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLI_COMMANDS } from "../../src/cli/registry";
import { helpRecoveryCandidates, resolveHelpPath } from "../../src/cli/help-catalog";
import { formatHelpRecovery, suggestHelpPaths } from "../../src/cli/help-recovery";
import { repoPath, repoRoot } from "../helpers/repo-root";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { SPAWN_BUDGET_MS } from "../helpers/test-budget";

setDefaultTimeout(SPAWN_BUDGET_MS);

function isolated(script: string, shim = false) {
  const home = mkdtempSync(join(tmpdir(), "ocx-help-recovery-"));
  const codex = join(home, "codex-home");
  const ocx = join(home, "ocx-home");
  mkdirSync(codex);
  mkdirSync(ocx);
  const wrapper = join(home, process.platform === "win32" ? "codex.cmd" : "codex");
  const backup = `${wrapper}.opencodex-real`;
  const state = join(ocx, "codex-shim.json");
  if (shim) {
    writeFileSync(wrapper, "replacement launcher\n");
    writeFileSync(backup, "known good launcher\n");
    if (process.platform !== "win32") chmodSync(wrapper, 0o755);
    writeFileSync(state, JSON.stringify({ platform: process.platform, wrapperPath: wrapper, originalPath: wrapper, backupPath: backup }));
  }
  const files = shim ? [wrapper, backup, state] : [];
  const before = files.map(file => readFileSync(file, "utf8"));
  try {
    const result = spawnSync(process.execPath, ["-e", script], {
      cwd: repoRoot(), encoding: "utf8", timeout: SPAWN_BUDGET_MS - 5_000,
      env: { ...process.env, CODEX_HOME: codex, OPENCODEX_HOME: ocx, NO_COLOR: "1" },
    });
    expect(result.error).toBeUndefined();
    expect(result.signal).toBeNull();
    expect(files.map(file => readFileSync(file, "utf8"))).toEqual(before);
    expect(readdirSync(codex)).toEqual([]);
    expect(readdirSync(ocx)).toEqual(shim ? ["codex-shim.json"] : []);
    return result;
  } finally { removeTreeWithRetry(home); }
}

function cli(args: string[], shim = false) {
  const entry = repoPath("src", "cli", "index.ts");
  return isolated(`process.argv = [process.execPath, ${JSON.stringify(entry)}, ...${JSON.stringify(args)}];
    await import(${JSON.stringify(entry)});`, shim);
}

describe("CLI help recovery", () => {
  test("candidate projection deduplicates root aliases and exposes only immediate documented children", () => {
    const roots = helpRecoveryCandidates();
    expect(new Set(roots.map(candidate => candidate.path.join(" "))).size).toBe(roots.length);
    expect(roots.find(candidate => candidate.path[0] === "models")?.names).toEqual(["models", "model"]);
    expect(roots.some(candidate => candidate.names.includes("internal") || candidate.names.some(name => name.startsWith("__")))).toBe(false);
    const account = helpRecoveryCandidates(["account"]);
    expect(account.every(candidate => candidate.path.length === 2)).toBe(true);
    expect(account.some(candidate => candidate.path.join(" ") === "account main")).toBe(true);
    expect(helpRecoveryCandidates(["account", "main"]).map(candidate => candidate.path.at(-1))).toEqual(["reauth", "doctor", "list", "register", "add", "switch", "recover"]);
    expect(helpRecoveryCandidates(["model"]).some(candidate => candidate.path.join(" ") === "models context")).toBe(true);
    expect(helpRecoveryCandidates(["models", "context"]).map(candidate => candidate.path.at(-1))).toEqual(["status", "value", "provider", "all"]);
  });

  test("matching folds case, handles transposition, deduplicates aliases and respects distance limits", () => {
    expect(suggestHelpPaths(["modle"])).toEqual([["models"]]);
    expect(suggestHelpPaths(["MODLES"])).toEqual([["models"]]);
    expect(suggestHelpPaths(["setpu"])).toEqual([["init"]]);
    expect(suggestHelpPaths(["models", "prce"])).toEqual([["models", "price"]]);
    expect(suggestHelpPaths(["models", "prxe"])).toEqual([]);
    expect(suggestHelpPaths(["models", "contxx"])).toEqual([["models", "context"]]);
    expect(suggestHelpPaths(["models", "cntxt"])).toEqual([]);
    expect(suggestHelpPaths(["rester"])).toEqual([["restart"], ["restore"]]);
    expect(suggestHelpPaths(["internla"])).toEqual([]);
  });

  test("access alias recovery uses canonical depth and stays deterministic", () => {
    expect(helpRecoveryCandidates(["api-key"])).toEqual(helpRecoveryCandidates(["access", "key"]));
    expect(helpRecoveryCandidates(["access", "keys"])).toEqual(helpRecoveryCandidates(["access", "key"]));
    for (const prefix of [["api-key"], ["access", "keys"], ["access", "key"]]) {
      expect(suggestHelpPaths([...prefix, "lisst"])).toEqual([["access", "key", "list"]]);
      expect(suggestHelpPaths([...prefix, "delet"])).toEqual([["access", "key", "remove"]]);
      expect(suggestHelpPaths([...prefix, "rotate", "commti"])).toEqual([["access", "key", "rotate", "commit"]]);
      expect(formatHelpRecovery([...prefix, "lisst"])).toBe(
        "Detailed help unavailable for the requested topic.\nDid you mean:\n  ocx help access key list\nSee: ocx help access key");
    }
    expect(suggestHelpPaths(["api-ke"])).toEqual([["access", "key"]]);
    expect(suggestHelpPaths(["access", "kyes"])).toEqual([["access", "key"]]);
    expect(suggestHelpPaths(["api-key", "qzxv"])).toEqual([]);
    expect(suggestHelpPaths(["api-key", "lisst", "private\u001b[2J"])).toEqual([]);
    expect(suggestHelpPaths(["api-key", "lisst", ...Array(6).fill("operand")])).toEqual([]);
    const result = cli(["help", "api-key", "lisst"]);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe(formatHelpRecovery(["api-key", "lisst"]) + "\n");
    expect(result.stderr).not.toContain("TypeError");
  });

  test("matching rejects unsafe tokens and excessive depth without truncating to candidates", () => {
    for (const token of ["mo", "modles\u001b", "modles\n", "modles\u0085", "modles\u2028", "mödles", "modles" + "x".repeat(59)]) {
      expect(suggestHelpPaths([token])).toEqual([]);
    }
    const atLimit = ["models", "contetx", ...Array(6).fill("operand")];
    expect(suggestHelpPaths(atLimit)).toEqual([["models", "context"]]);
    expect(suggestHelpPaths([...atLimit, "operand"])).toEqual([]);
    expect(formatHelpRecovery(["m".repeat(64)])).toContain(`Unknown command: ${"m".repeat(64)}`);
    expect(formatHelpRecovery(["m".repeat(65)])).toBe("Unknown command.\nSee: ocx help --all");
    const longPath = ["models", "context", ...Array(10_000).fill("operand")];
    expect(resolveHelpPath(longPath)).toMatchObject({ kind: "unavailable", parent: ["models", "context"] });
    expect(formatHelpRecovery(longPath)).toBe("Detailed help unavailable for the requested topic.\nSee: ocx help models context");
  });

  test("ties sort by name and cap at three destinations in an isolated catalog fixture", () => {
    const result = isolated(`import { mock } from "bun:test";
      mock.module(${JSON.stringify(repoPath("src", "cli", "help-catalog.ts"))}, () => ({
        resolveHelpPath: path => ({ kind: "unavailable", path }),
        helpRecoveryCandidates: () => ["sturt", "stort", "stirt", "stert", "stqrt"].map(name => ({ names: [name], path: [name] })),
      }));
      const { suggestHelpPaths } = await import(${JSON.stringify(repoPath("src", "cli", "help-recovery.ts"))});
      console.log(JSON.stringify(suggestHelpPaths(["start"])));`);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual([["stert"], ["stirt"], ["stort"]]);
  });

  test("root typos have concise stderr-only suggestions without shim writes", () => {
    for (const args of [["modles"], ["help", "modles"]]) {
      const result = cli(args, true);
      expect(result.status).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("Unknown command: modles");
      expect(result.stderr).toContain("ocx help models");
      expect(result.stderr.trim().split("\n").length).toBeLessThan(10);
    }
  });

  test("nested recovery stays in its documented context", () => {
    const result = cli(["help", "account", "lisst"]);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Detailed help unavailable");
    expect(result.stderr).toContain("ocx help account list");
    expect(result.stderr).not.toContain("ocx help models");
    const context = cli(["help", "model", "contetx"]);
    expect(context.status).toBe(1);
    expect(context.stderr).toContain("ocx help models context");
  });

  test("distant roots get only the full-reference escape", () => {
    const result = cli(["help", "qzxv"]);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("Unknown command: qzxv\nSee: ocx help --all\n");
  });

  test("unsafe roots and trailing operands never enter diagnostic output", () => {
    const secret = "sk-" + "fixture-secret-not-real";
    for (const root of ["modles\u001b[2J", "modles\n", "m".repeat(65), secret]) {
      const result = cli([root, "private-operand", "--api-key", secret]);
      expect(result.status).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toBe("Unknown command.\nSee: ocx help --all\n");
    }
    const typo = cli(["modles", secret]);
    expect(typo.stderr).toContain("ocx help models");
    expect(typo.stderr).not.toContain(secret);
  });

  test("direct dispatch independently uses the same unknown-root formatter", () => {
    const command = "modles";
    const result = isolated(`const { dispatchCommand } = await import(${JSON.stringify(repoPath("src", "cli", "dispatch.ts"))});
      const args = [${JSON.stringify(command)}, "private-operand"];
      const deps = new Proxy({}, { get() { throw new Error("unknown dispatch touched execution dependencies"); } });
      process.exitCode = await dispatchCommand({ kind: "command", command: args[0], args }, deps);`);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe(cli([command]).stderr);
  });

  test("strict unavailable help ignores a successful-render sink and never echoes operands", () => {
    const result = isolated(`const { printSubcommandUsage } = await import(${JSON.stringify(repoPath("src", "cli", "help.ts"))});
      printSubcommandUsage("account", ["account", "lisst", "private-operand"], { write: console.log });`);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("ocx help account list");
    expect(result.stderr).not.toContain("private-operand");
  });

  test("unknown roots stop before preflight while registered and internal roots remain admitted", () => {
    const mockSetup = `import { mock } from "bun:test";
      const calls = [];
      let reportCalls = false;
      mock.module(${JSON.stringify(repoPath("src", "cli", "codex-shim-autorestore.ts"))}, () => ({
        maybeAutoRestoreCodexShim: command => { calls.push(command); if (reportCalls) console.log("preflight called"); },
      }));
      const { runCli } = await import(${JSON.stringify(repoPath("src", "cli", "root.ts"))});`;
    const rejected = isolated(`${mockSetup}
      reportCalls = true; await runCli(["modles"]);`);
    expect(rejected.status).toBe(1);
    expect(rejected.stdout).toBe("");
    const names = ["start", "setup", "eject", "remove", "model", "internal", ...CLI_COMMANDS.filter(entry => entry.hidden).map(entry => entry.name)];
    const admitted = isolated(`${mockSetup}
      const names = ${JSON.stringify(names)};
      const heads = [];
      for (const name of names) heads.push((await runCli([name])).command);
      console.log(JSON.stringify({ heads, calls }));`);
    expect(admitted.status).toBe(0);
    expect(admitted.stderr).toBe("");
    expect(JSON.parse(admitted.stdout)).toEqual({ heads: names, calls: names });
  });
});


test.each([0, 1])("update dispatch preserves updater exit %s without executing the updater", code => {
  const result = isolated(`import { mock } from "bun:test";
    const updatePath = ${JSON.stringify(repoPath("src", "update", "index.ts"))};
    const original = await import(updatePath);
    mock.module(updatePath, () => ({
      ...original, runUpdate: async () => { process.exitCode = ${code}; },
    }));
    const { dispatchCommand } = await import(${JSON.stringify(repoPath("src", "cli", "dispatch.ts"))});
    const args = ["update"];
    const status = await dispatchCommand({ kind: "command", command: "update", args }, { args });
    console.log(JSON.stringify({ status }));
    process.exit(status);`);
  expect(result.status).toBe(code);
  expect(JSON.parse(result.stdout)).toEqual({ status: code });
  expect(result.stderr).toBe("");
});
