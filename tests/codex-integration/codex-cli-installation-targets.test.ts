import { describe, expect, test } from "bun:test";
import { SHIM_MARKER } from "../../src/codex/shim-templates";
import {
  deriveCodexCliInstallationInput,
  type CodexCliInstallationSnapshot,
} from "../../src/codex/cli-installation-targets";

const PREFIX = "C:\\Users\\op\\AppData\\Roaming\\npm";
const NODE_DIR = "C:\\Program Files\\nodejs";

function fixtureFiles(): Set<string> {
  return new Set([
    PREFIX + "\\codex.cmd",
    PREFIX + "\\node_modules\\@openai\\codex\\package.json",
    PREFIX + "\\node_modules\\@openai\\codex\\bin\\codex.js",
    NODE_DIR + "\\node.exe",
    NODE_DIR + "\\node_modules\\npm\\bin\\npm-cli.js",
    NODE_DIR + "\\node_modules\\npm\\package.json",
  ].map(path => path.toLowerCase()));
}

function depsFor(files: Set<string>, marked: ReadonlySet<string> = new Set()) {
  return {
    platform: "win32" as const,
    exists: (path: string) => files.has(path.toLowerCase()),
    fileContains: (path: string, marker: string) =>
      marker === SHIM_MARKER && marked.has(path.toLowerCase()),
  };
}

function snapshot(extra: Partial<CodexCliInstallationSnapshot> = {}): CodexCliInstallationSnapshot {
  return {
    codexCliPath: null,
    path: PREFIX + ";" + NODE_DIR,
    pathExt: ".COM;.EXE;.BAT;.CMD",
    ...extra,
  };
}

describe("selected Codex CLI installation target derivation", () => {
  test("refuses non-Windows platforms before touching the filesystem", () => {
    let probed = 0;
    const result = deriveCodexCliInstallationInput(snapshot(), {
      platform: "linux",
      exists: () => { probed += 1; return true; },
    });
    expect(result).toEqual({ kind: "unavailable", reason: "unsupported_platform" });
    expect(probed).toBe(0);
  });

  test("reports candidate_unavailable when nothing identifies a candidate", () => {
    for (const snap of [
      {},
      { codexCliPath: null, path: null },
      { codexCliPath: "C:\\missing\\codex.cmd", path: PREFIX },
      { codexCliPath: null, path: "C:\\empty" },
    ]) {
      expect(deriveCodexCliInstallationInput(snap, depsFor(fixtureFiles())))
        .toEqual({ kind: "unavailable", reason: "candidate_unavailable" });
    }
  });

  test("derives the npm-global layout from the configured candidate", () => {
    const result = deriveCodexCliInstallationInput(
      snapshot({ codexCliPath: PREFIX + "\\codex.cmd" }),
      depsFor(fixtureFiles()),
    );
    expect(result).toEqual({
      kind: "derived",
      input: {
        candidate: PREFIX + "\\codex.cmd",
        npmPrefix: PREFIX,
        npmCli: NODE_DIR + "\\node_modules\\npm\\bin\\npm-cli.js",
        node: NODE_DIR + "\\node.exe",
        candidateSource: "selected",
      },
    });
  });

  test("resolves the first PATH codex.cmd and prefers a prefix-local node.exe", () => {
    const files = fixtureFiles();
    files.add((PREFIX + "\\node.exe").toLowerCase());
    files.add((PREFIX + "\\node_modules\\npm\\bin\\npm-cli.js").toLowerCase());
    const result = deriveCodexCliInstallationInput(
      snapshot({ path: "C:\\nowhere;" + PREFIX + ";C:\\later;" + NODE_DIR }),
      depsFor(files),
    );
    expect(result).toEqual({
      kind: "derived",
      input: {
        candidate: PREFIX + "\\codex.cmd",
        npmPrefix: PREFIX,
        npmCli: PREFIX + "\\node_modules\\npm\\bin\\npm-cli.js",
        node: PREFIX + "\\node.exe",
        candidateSource: "selected",
      },
    });
  });

  test("an earlier PATH codex.exe is the selected launcher and refuses the layout", () => {
    const files = fixtureFiles();
    files.delete((PREFIX + "\\codex.cmd").toLowerCase());
    files.add("c:\\bin\\codex.exe");
    const result = deriveCodexCliInstallationInput(
      snapshot({ path: "C:\\bin;" + PREFIX }),
      depsFor(files),
    );
    expect(result).toEqual({ kind: "unavailable", reason: "unsupported_layout" });
  });

  test("an OpenCodex wrapper attests the renamed npm artifact, not the wrapper", () => {
    const files = fixtureFiles();
    files.add((PREFIX + "\\codex.opencodex-real.cmd").toLowerCase());
    const marked = new Set([(PREFIX + "\\codex.cmd").toLowerCase()]);
    const result = deriveCodexCliInstallationInput(
      snapshot({ codexCliPath: PREFIX + "\\codex.cmd" }),
      depsFor(files, marked),
    );
    expect(result).toEqual({
      kind: "derived",
      input: {
        candidate: PREFIX + "\\codex.opencodex-real.cmd",
        npmPrefix: PREFIX,
        npmCli: NODE_DIR + "\\node_modules\\npm\\bin\\npm-cli.js",
        node: NODE_DIR + "\\node.exe",
        candidateSource: "selected",
      },
    });
  });

  test("a wrapper without its npm backing refuses instead of attesting our own launcher", () => {
    const marked = new Set([(PREFIX + "\\codex.cmd").toLowerCase()]);
    expect(deriveCodexCliInstallationInput(
      snapshot({ codexCliPath: PREFIX + "\\codex.cmd" }),
      depsFor(fixtureFiles(), marked),
    )).toEqual({ kind: "unavailable", reason: "unsupported_layout" });
  });

  test("a fresh npm shim replacing the wrapper attests it directly, ignoring a stale backing", () => {
    const files = fixtureFiles();
    files.add((PREFIX + "\\codex.opencodex-real.cmd").toLowerCase());
    // codex.cmd does NOT contain the marker: npm install -g overwrote the wrapper.
    const result = deriveCodexCliInstallationInput(
      snapshot({ codexCliPath: PREFIX + "\\codex.cmd" }),
      depsFor(files),
    );
    expect(result).toEqual({
      kind: "derived",
      input: expect.objectContaining({ candidate: PREFIX + "\\codex.cmd" }),
    });
  });

  test("a direct package bin/codex.js candidate derives its owning prefix", () => {
    const bin = PREFIX + "\\node_modules\\@openai\\codex\\bin\\codex.js";
    const result = deriveCodexCliInstallationInput(
      snapshot({ codexCliPath: bin }),
      depsFor(fixtureFiles()),
    );
    expect(result).toEqual({
      kind: "derived",
      input: {
        candidate: bin,
        npmPrefix: PREFIX,
        npmCli: NODE_DIR + "\\node_modules\\npm\\bin\\npm-cli.js",
        node: NODE_DIR + "\\node.exe",
        candidateSource: "selected",
      },
    });
  });

  test("a candidate outside the npm package layout is unsupported", () => {
    const files = fixtureFiles();
    files.add("c:\\tools\\codex.cmd");
    expect(deriveCodexCliInstallationInput(
      snapshot({ codexCliPath: "C:\\tools\\codex.cmd" }),
      depsFor(files),
    )).toEqual({ kind: "unavailable", reason: "unsupported_layout" });
  });

  test("a prefix without the codex package manifest is unsupported", () => {
    const files = fixtureFiles();
    files.delete((PREFIX + "\\node_modules\\@openai\\codex\\package.json").toLowerCase());
    expect(deriveCodexCliInstallationInput(
      snapshot({ codexCliPath: PREFIX + "\\codex.cmd" }),
      depsFor(files),
    )).toEqual({ kind: "unavailable", reason: "unsupported_layout" });
  });

  test("missing node.exe or npm-cli.js refuses the toolchain, not the candidate", () => {
    const noNode = fixtureFiles();
    noNode.delete((NODE_DIR + "\\node.exe").toLowerCase());
    expect(deriveCodexCliInstallationInput(
      snapshot({ codexCliPath: PREFIX + "\\codex.cmd" }),
      depsFor(noNode),
    )).toEqual({ kind: "unavailable", reason: "toolchain_unresolved" });

    const noNpm = fixtureFiles();
    noNpm.delete((NODE_DIR + "\\node_modules\\npm\\bin\\npm-cli.js").toLowerCase());
    expect(deriveCodexCliInstallationInput(
      snapshot({ codexCliPath: PREFIX + "\\codex.cmd" }),
      depsFor(noNpm),
    )).toEqual({ kind: "unavailable", reason: "toolchain_unresolved" });
  });

  test("a bare configured command name resolves through the captured PATH", () => {
    const result = deriveCodexCliInstallationInput(
      snapshot({ codexCliPath: "codex" }),
      depsFor(fixtureFiles()),
    );
    expect(result).toEqual({
      kind: "derived",
      input: expect.objectContaining({
        candidate: PREFIX + "\\codex.cmd",
        candidateSource: "selected",
      }),
    });
  });

  test("a relative path-shaped configured candidate refuses instead of substituting PATH codex", () => {
    for (const configured of ["tools\\codex.cmd", "tools/codex.cmd"]) {
      expect(deriveCodexCliInstallationInput(
        snapshot({ codexCliPath: configured }),
        depsFor(fixtureFiles()),
      )).toEqual({ kind: "unavailable", reason: "candidate_unavailable" });
    }
  });
});
