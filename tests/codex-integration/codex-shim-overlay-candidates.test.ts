import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { codexShimCommandCandidates } from "../../src/codex/catalog/bundled";
import { probeCodexSupportsModeHint } from "../../src/codex/features";
import { resetCodexRuntimeResolveCacheForTests, resolveCodexRuntime, setCodexRuntimeResolveCacheForTests } from "../../src/codex/runtime";
import { decodeOverlayState, readStateResult } from "../../src/codex/shim-state-file";

function fixture(run: (f: { root: string; home: string; native: string; wrapper: string; statePath: string; state: Record<string, unknown> }) => void): void {
  const root = mkdtempSync(join(tmpdir(), "ocx-overlay-candidates-"));
  const home = join(root, "home");
  const wrapper = join(home, "bin", "codex");
  const native = join(root, "manager", "codex");
  const statePath = join(home, "codex-shim.json");
  mkdirSync(dirname(wrapper), { recursive: true });
  mkdirSync(dirname(native));
  const previous = { ...process.env };
  const state = { schema: 2, mode: "path-overlay", platform: process.platform, wrapperPath: wrapper, launcherPath: native };
  try {
    process.env.HOME = root;
    process.env.OPENCODEX_HOME = home;
    process.env.CODEX_HOME = join(root, "codex-home");
    process.env.PATH = "";
    delete process.env.CODEX_CLI_PATH;
    resetCodexRuntimeResolveCacheForTests();
    writeFileSync(wrapper, `#!/bin/sh\n# opencodex codex autostart shim\nexec '${native}' "$@"\n`, { mode: 0o755 });
    writeFileSync(native, "#!/bin/sh\nprintf 'codex-cli 0.159.2\\n'\n", { mode: 0o755 });
    writeFileSync(statePath, JSON.stringify(state), { mode: 0o600 });
    run({ root, home, native, wrapper, statePath, state });
  } finally {
    resetCodexRuntimeResolveCacheForTests();
    process.env = previous;
    rmSync(root, { recursive: true, force: true });
  }
}

function selected(command: string): void {
  resetCodexRuntimeResolveCacheForTests();
  setCodexRuntimeResolveCacheForTests({ runtime: { command, version: "test", source: "fallback" }, failures: [] });
}
function native(supported: boolean): Buffer {
  return Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46]), Buffer.from(supported ? "multi_agent_mode_hint_text" : "older_codex_schema")]);
}

describe.skipIf(process.platform === "win32")("overlay native launcher candidates", () => {
  test("bundled catalog and runtime prefer the validated v2 durable launcher", () => fixture(f => {
    const raw = readFileSync(f.statePath, "utf8");
    expect(codexShimCommandCandidates()[0]).toBe(f.native);
    const attempts: string[] = [];
    const runtime = resolveCodexRuntime({
      configDir: f.home, env: { PATH: "", HOME: f.root, CODEX_HOME: join(f.root, "codex-home") }, discoverAlternatives: false,
      existsSync: path => String(path) === f.native || String(path) === f.wrapper,
      execFileSync: command => { attempts.push(command); return "codex-cli 0.159.2"; },
    });
    expect(runtime.runtime).toMatchObject({ command: f.native, version: "0.159.2", source: "shim" });
    expect(attempts).toEqual([f.native]);
    expect(readFileSync(f.statePath, "utf8")).toBe(raw);
  }));

  test.each(["schema", "mode", "relative", "foreign-wrapper", "self-launcher", "legacy-conflict", "tuple-conflict", "windows", "control-path", "identity"])("rejects invalid or mismatched %s overlay state without using its launcher", kind => fixture(f => {
    const state = { ...f.state };
    if (kind === "schema") state.schema = 1;
    else if (kind === "mode") state.mode = "in-place";
    else if (kind === "relative") state.launcherPath = "manager/codex";
    else if (kind === "foreign-wrapper") state.wrapperPath = join(f.root, "foreign", "codex");
    else if (kind === "self-launcher") state.launcherPath = f.wrapper;
    else if (kind === "legacy-conflict") state.backupPath = join(f.root, "conflicting", "codex");
    else if (kind === "tuple-conflict") state.wrappers = [{ wrapperPath: f.wrapper, originalPath: f.native, backupPath: join(f.root, "other", "codex") }];
    else if (kind === "windows") state.platform = "win32";
    else if (kind === "control-path") state.launcherPath = `${f.native}\nother`;
    else state.wrapperIdentity = { dev: 1, ino: "invalid" };
    const raw = JSON.stringify(state);
    writeFileSync(f.statePath, raw);
    expect(decodeOverlayState(state, f.home)).toBeNull();
    expect(readStateResult(f.statePath)).toMatchObject({ present: true, state: null });
    expect(codexShimCommandCandidates()).toEqual([]);
    const attempts: string[] = [];
    resolveCodexRuntime({ configDir: f.home, env: { PATH: "", HOME: f.root, CODEX_HOME: join(f.root, "codex-home") }, discoverAlternatives: false,
      existsSync: path => String(path) === f.native,
      execFileSync: command => { attempts.push(command); return "codex-cli 0.159.2"; },
    });
    expect(attempts).not.toContain(f.native);
    expect(readFileSync(f.statePath, "utf8")).toBe(raw);
  }));

  test("legacy catalog and runtime still prefer recorded backup before original and wrapper", () => fixture(f => {
    const backup = `${f.native}.opencodex-real`;
    writeFileSync(backup, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    writeFileSync(f.statePath, JSON.stringify({ platform: process.platform, wrapperPath: f.native, originalPath: f.native, backupPath: backup }));
    expect(codexShimCommandCandidates().slice(0, 2)).toEqual([backup, f.native]);
    const result = resolveCodexRuntime({ configDir: f.home, env: { PATH: "", HOME: f.root, CODEX_HOME: join(f.root, "codex-home") }, discoverAlternatives: false,
      existsSync: path => String(path) === backup || String(path) === f.native,
      execFileSync: () => "codex-cli 0.159.2",
    });
    expect(result.runtime).toMatchObject({ command: backup, source: "shim" });
  }));

  test("feature probing follows v2 launcher only for the selected recorded wrapper", () => fixture(f => {
    writeFileSync(f.native, native(true));
    const decoy = join(f.root, "decoy-codex");
    writeFileSync(decoy, native(false));
    selected(f.wrapper);
    expect(probeCodexSupportsModeHint()).toBe(true);
    selected(decoy);
    expect(probeCodexSupportsModeHint()).toBe(false);
    const otherWrapper = join(f.root, "untracked-codex");
    writeFileSync(otherWrapper, "#!/bin/sh\n# opencodex codex autostart shim\nexit 0\n");
    selected(otherWrapper);
    expect(probeCodexSupportsModeHint()).toBeNull();
  }));

  test("feature probing refuses a mismatched overlay binding and a foreign recorded wrapper", () => fixture(f => {
    writeFileSync(f.native, native(true));
    writeFileSync(f.statePath, JSON.stringify({ ...f.state, backupPath: join(f.root, "other", "codex") }));
    selected(f.wrapper);
    expect(probeCodexSupportsModeHint()).toBeNull();
    const foreign = join(f.root, "foreign-codex");
    writeFileSync(foreign, "#!/bin/sh\nexit 0\n");
    writeFileSync(f.statePath, JSON.stringify({ ...f.state, wrapperPath: foreign }));
    selected(foreign);
    expect(probeCodexSupportsModeHint()).toBeNull();
  }));

  test("selected wrapper's npm launcher resolves only its own platform package", () => fixture(f => {
    const launcher = join(f.root, "node_modules", "@openai", "codex", "bin", "codex.js");
    const pkg = join(f.root, "node_modules", "@openai", "codex-darwin-arm64");
    const binary = join(pkg, "vendor", "aarch64-apple-darwin", "bin", "codex");
    mkdirSync(dirname(launcher), { recursive: true });
    mkdirSync(dirname(binary), { recursive: true });
    writeFileSync(launcher, "#!/usr/bin/env node\n");
    writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "@openai/codex-darwin-arm64", version: "test" }));
    writeFileSync(binary, native(true));
    writeFileSync(f.statePath, JSON.stringify({ ...f.state, launcherPath: launcher }));
    selected(f.wrapper);
    expect(probeCodexSupportsModeHint()).toBe(true);
    selected(f.native);
    expect(probeCodexSupportsModeHint()).toBeNull();
  }));
});
