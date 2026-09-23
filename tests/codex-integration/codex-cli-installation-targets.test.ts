import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SHIM_MARKER } from "../../src/codex/shim-templates";
import {
  deriveCodexCliInstallationInput,
  type CodexCliInstallationSnapshot,
} from "../../src/codex/cli-installation-targets";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const nativeTest = process.platform === "win32" && process.arch === "x64" ? test : test.skip;
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
  test("refuses non-Windows platforms before touching the filesystem", async () => {
    let probed = 0;
    const result = await deriveCodexCliInstallationInput(snapshot(), {
      platform: "linux",
      exists: () => { probed += 1; return true; },
    });
    expect(result).toEqual({ kind: "unavailable", reason: "unsupported_platform" });
    expect(probed).toBe(0);
  });

  test("reports candidate_unavailable when nothing identifies a candidate", async () => {
    for (const snap of [
      {},
      { codexCliPath: null, path: null },
      { codexCliPath: "C:\\missing\\codex.cmd", path: PREFIX },
      { codexCliPath: null, path: "C:\\empty" },
    ]) {
      expect(await deriveCodexCliInstallationInput(snap, depsFor(fixtureFiles())))
        .toEqual({ kind: "unavailable", reason: "candidate_unavailable" });
    }
  });

  test("a refused PATH probe stops the scan instead of attesting a later candidate", async () => {
    const files = fixtureFiles();
    files.add((NODE_DIR + "\\codex.cmd").toLowerCase());
    const refused = PREFIX + "\\codex.cmd";
    const deps = depsFor(files);
    const result = await deriveCodexCliInstallationInput(
      snapshot({ codexCliPath: "codex" }),
      {
        ...deps,
        exists: (path: string) =>
          path.toLowerCase() === refused.toLowerCase() ? "refused" : deps.exists(path),
      },
    );
    expect(result).toEqual({ kind: "unavailable", reason: "candidate_unavailable" });
  });

  test("an unavailable PATH volume does not hide a later launcher", async () => {
    const files = fixtureFiles();
    const deps = depsFor(files);
    const result = await deriveCodexCliInstallationInput(
      snapshot({ path: "Z:\\stale;" + PREFIX + ";" + NODE_DIR }),
      {
        ...deps,
        exists: path => path.startsWith("Z:\\") ? "volume-unavailable" : deps.exists(path),
      },
    );
    expect(result.kind).toBe("derived");
  });

  test("derives the npm-global layout from the configured candidate", async () => {
    const result = await deriveCodexCliInstallationInput(
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

  test("resolves the first PATH codex.cmd and prefers a prefix-local node.exe", async () => {
    const files = fixtureFiles();
    files.add((PREFIX + "\\node.exe").toLowerCase());
    files.add((PREFIX + "\\node_modules\\npm\\bin\\npm-cli.js").toLowerCase());
    const result = await deriveCodexCliInstallationInput(
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

  test("an earlier PATH codex.exe is the selected launcher and refuses the layout", async () => {
    const files = fixtureFiles();
    files.delete((PREFIX + "\\codex.cmd").toLowerCase());
    files.add("c:\\bin\\codex.exe");
    const result = await deriveCodexCliInstallationInput(
      snapshot({ path: "C:\\bin;" + PREFIX }),
      depsFor(files),
    );
    expect(result).toEqual({ kind: "unavailable", reason: "unsupported_layout" });
  });

  test("an OpenCodex wrapper attests the renamed npm artifact, not the wrapper", async () => {
    const files = fixtureFiles();
    files.add((PREFIX + "\\codex.opencodex-real.cmd").toLowerCase());
    const marked = new Set([(PREFIX + "\\codex.cmd").toLowerCase()]);
    const result = await deriveCodexCliInstallationInput(
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

  test("a wrapper without its npm backing refuses instead of attesting our own launcher", async () => {
    const marked = new Set([(PREFIX + "\\codex.cmd").toLowerCase()]);
    expect(await deriveCodexCliInstallationInput(
      snapshot({ codexCliPath: PREFIX + "\\codex.cmd" }),
      depsFor(fixtureFiles(), marked),
    )).toEqual({ kind: "unavailable", reason: "unsupported_layout" });
  });

  test("an unreadable wrapper probe is unavailable, not marker absence", async () => {
    const files = fixtureFiles();
    files.add((PREFIX + "\\codex.opencodex-real.cmd").toLowerCase());
    const result = await deriveCodexCliInstallationInput(
      snapshot({ codexCliPath: PREFIX + "\\codex.cmd" }),
      { ...depsFor(files), fileContains: () => "unavailable" as const },
    );
    expect(result).toEqual({ kind: "unavailable", reason: "candidate_unavailable" });
  });

  test("a fresh npm shim replacing the wrapper attests it directly, ignoring a stale backing", async () => {
    const files = fixtureFiles();
    files.add((PREFIX + "\\codex.opencodex-real.cmd").toLowerCase());
    // codex.cmd does NOT contain the marker: npm install -g overwrote the wrapper.
    const result = await deriveCodexCliInstallationInput(
      snapshot({ codexCliPath: PREFIX + "\\codex.cmd" }),
      depsFor(files),
    );
    expect(result).toEqual({
      kind: "derived",
      input: expect.objectContaining({ candidate: PREFIX + "\\codex.cmd" }),
    });
  });

  test("a direct package bin/codex.js candidate derives its owning prefix", async () => {
    const bin = PREFIX + "\\node_modules\\@openai\\codex\\bin\\codex.js";
    const result = await deriveCodexCliInstallationInput(
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

  test("a candidate outside the npm package layout is unsupported", async () => {
    const files = fixtureFiles();
    files.add("c:\\tools\\codex.cmd");
    expect(await deriveCodexCliInstallationInput(
      snapshot({ codexCliPath: "C:\\tools\\codex.cmd" }),
      depsFor(files),
    )).toEqual({ kind: "unavailable", reason: "unsupported_layout" });
  });

  test("a prefix without the codex package manifest is unsupported", async () => {
    const files = fixtureFiles();
    files.delete((PREFIX + "\\node_modules\\@openai\\codex\\package.json").toLowerCase());
    expect(await deriveCodexCliInstallationInput(
      snapshot({ codexCliPath: PREFIX + "\\codex.cmd" }),
      depsFor(files),
    )).toEqual({ kind: "unavailable", reason: "unsupported_layout" });
  });

  test("missing node.exe or npm-cli.js refuses the toolchain, not the candidate", async () => {
    const noNode = fixtureFiles();
    noNode.delete((NODE_DIR + "\\node.exe").toLowerCase());
    expect(await deriveCodexCliInstallationInput(
      snapshot({ codexCliPath: PREFIX + "\\codex.cmd" }),
      depsFor(noNode),
    )).toEqual({ kind: "unavailable", reason: "toolchain_unresolved" });

    const noNpm = fixtureFiles();
    noNpm.delete((NODE_DIR + "\\node_modules\\npm\\bin\\npm-cli.js").toLowerCase());
    expect(await deriveCodexCliInstallationInput(
      snapshot({ codexCliPath: PREFIX + "\\codex.cmd" }),
      depsFor(noNpm),
    )).toEqual({ kind: "unavailable", reason: "toolchain_unresolved" });
  });

  test("a bare configured command name resolves through the captured PATH", async () => {
    const result = await deriveCodexCliInstallationInput(
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

  nativeTest("default probe passes absent PATHEXT entries and prefix-local node.exe", async () => {
    const root = mkdtempSync(join(tmpdir(), "ocx-install-targets-"));
    try {
      const prefix = join(root, "npm");
      const nodeDir = join(root, "node-bin");
      mkdirSync(join(prefix, "node_modules", "@openai", "codex"), { recursive: true });
      mkdirSync(join(nodeDir, "node_modules", "npm", "bin"), { recursive: true });
      writeFileSync(join(prefix, "codex.cmd"), "@echo off\r\n");
      writeFileSync(join(prefix, "node_modules", "@openai", "codex", "package.json"), "{}");
      writeFileSync(join(nodeDir, "node.exe"), "");
      writeFileSync(join(nodeDir, "node_modules", "npm", "bin", "npm-cli.js"), "");

      const result = await deriveCodexCliInstallationInput({
        codexCliPath: null,
        path: `${prefix};${nodeDir}`,
        pathExt: ".COM;.EXE;.BAT;.CMD",
      });
      expect(result).toEqual({
        kind: "derived",
        input: {
          candidate: join(prefix, "codex.cmd"),
          npmPrefix: prefix,
          npmCli: join(nodeDir, "node_modules", "npm", "bin", "npm-cli.js"),
          node: join(nodeDir, "node.exe"),
          candidateSource: "selected",
        },
      });
    } finally {
      removeTreeWithRetry(root);
    }
  });

  test("a relative path-shaped configured candidate refuses instead of substituting PATH codex", async () => {
    for (const configured of ["tools\\codex.cmd", "tools/codex.cmd"]) {
      expect(await deriveCodexCliInstallationInput(
        snapshot({ codexCliPath: configured }),
        depsFor(fixtureFiles()),
      )).toEqual({ kind: "unavailable", reason: "candidate_unavailable" });
    }
  });
});
