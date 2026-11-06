import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  CodexExecTrustError, validatedCodexExecInvocation, validatedCodexExecInvocationAsync,
  type CodexExecBoundaryDeps,
} from "../../src/codex/exec-boundary";
import { codexRuntimeStatePath, resolveCodexRuntime, resolveCodexRuntimeAsync } from "../../src/codex/runtime";
import { loadBundledCodexCatalog, loadBundledCodexCatalogAsync } from "../../src/codex/catalog/bundled";
import {
  OPENAI_TEAM_ID, untrustedChatgptBundleReason, untrustedChatgptBundleReasonAsync,
  type BundleTrustDeps,
} from "../../src/chatgpt/app-server-shim/bundle-trust";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await removeTreeWithRetry(root); });

const apps = [
  ["/Applications/Codex.app", "/Contents/Resources/codex-aarch64-apple-darwin"],
  ["/opt/relocated/Codex.app", "/Contents/Resources/codex-x86_64-apple-darwin"],
  ["/opt/relocated/ChatGPT.app", "/Contents/Resources/codex-cli/bin/codex"],
] as const;

function fixture(bundle: string, layout: string, alias: boolean, refused: boolean) {
  const binary = bundle + layout, command = alias ? "/tools/codex-link" : binary;
  const syncCalls: string[][] = [], asyncCalls: string[][] = [], spawned: string[] = [];
  const env: NodeJS.ProcessEnv = { HOME: "/Users/fixture", PATH: "" };
  const common = {
    platform: "darwin" as const, env,
    realpath: (path: string) => path === command ? binary : path,
    executable: (path: string) => path === command || path === binary,
    macBundleTrustReason: (root: string, target: string) => {
      syncCalls.push([root, target]); return refused ? "fixture refused" : null;
    },
    macBundleTrustReasonAsync: async (root: string, target: string) => {
      asyncCalls.push([root, target]); return refused ? "fixture refused" : null;
    },
  };
  const boundary = { ...common, exists: common.executable };
  const configDir = mkdtempSync(join(tmpdir(), "ocx-known-app-"));
  roots.push(configDir);
  const runtime = {
    ...common, configDir, existsSync: common.executable,
    readBundleIdentifier: () => "com.openai.codex",
    execFileSync: (file: string) => { spawned.push(file); return "codex-cli 0.160.0"; },
    execFile: async (file: string) => { spawned.push(file); return "codex-cli 0.160.0"; },
  };
  const assertChecks = (asyncMode: boolean) => {
    expect(asyncMode ? asyncCalls : syncCalls).toEqual([[bundle, binary]]);
    expect(asyncMode ? syncCalls : asyncCalls).toEqual([]);
  };
  return { binary, command, boundary, runtime, spawned, assertChecks };
}

// Injected Darwin, executable and realpath answers exercise every case on Windows too.
for (const [bundle, layout] of apps) for (const alias of [false, true]) {
  for (const asyncMode of [false, true]) for (const refused of [true, false]) {
    const label = `${bundle}, alias=${alias}, async=${asyncMode}, refused=${refused}`;
    test(`known app exec: ${label}`, async () => {
      const f = fixture(bundle, layout, alias, refused);
      const invoke = () => asyncMode
        ? validatedCodexExecInvocationAsync(f.command, ["app-server"], f.boundary)
        : validatedCodexExecInvocation(f.command, ["app-server"], f.boundary);
      if (refused) {
        if (asyncMode) await expect(invoke()).rejects.toThrow(CodexExecTrustError);
        else expect(invoke).toThrow(CodexExecTrustError);
      } else {
        expect(await invoke()).toEqual({ file: f.binary, args: ["app-server"], options: {} });
      }
      f.assertChecks(asyncMode);
    });

    for (const source of ["environment", "configured"] as const) {
      test(`known app runtime ${source}: ${label}`, async () => {
        const f = fixture(bundle, layout, alias, refused);
        if (source === "environment") f.runtime.env.CODEX_CLI_PATH = f.command;
        else writeFileSync(codexRuntimeStatePath(f.runtime.configDir), JSON.stringify({
          version: 1, command: f.command, source: "installed", origin: "pinned",
          selectedVersion: "0.160.0", updatedAt: "2026-10-26T00:00:00Z",
        }));
        const result = asyncMode ? await resolveCodexRuntimeAsync(f.runtime) : resolveCodexRuntime(f.runtime);
        f.assertChecks(asyncMode);
        if (refused) {
          expect(result.failures).toContainEqual(expect.objectContaining({
            command: f.command, source, reason: expect.stringContaining("untrusted Codex exec target"),
          }));
          expect(f.spawned).toEqual([]);
          expect(result.runtime.source).toBe("fallback");
        } else {
          expect(result.runtime).toEqual({ command: f.command, source, version: "0.160.0" });
          expect(f.spawned).toEqual([f.binary]);
        }
      });
    }

    test(`known app catalog consumer: ${label}`, async () => {
      const f = fixture(bundle, layout, alias, refused);
      const exec = (file: string) => {
        f.spawned.push(file);
        return JSON.stringify({ models: [{ slug: "gpt-test", base_instructions: "Fixture instructions." }] });
      };
      const deps = { ...f.runtime, commandCandidates: () => [f.command],
        execFileSync: exec, execFile: async (file: string) => exec(file) };
      const result = asyncMode ? await loadBundledCodexCatalogAsync(deps) : loadBundledCodexCatalog(deps);
      f.assertChecks(asyncMode);
      expect(f.spawned).toEqual(refused ? [] : [f.binary]);
      if (refused) expect(result).toBeNull();
      else expect(result?.models[0]?.slug).toBe("gpt-test");
    });
  }
}

for (const asyncMode of [false, true]) {
  for (const name of ["Codex", "ChatGPT"]) test(`filesystem-root app: ${name}, async=${asyncMode}`, async () => {
    const f = fixture(`/${name}.app`, "/Contents/Resources/codex", false, true);
    if (asyncMode) await expect(validatedCodexExecInvocationAsync(f.command, [], f.boundary)).rejects.toThrow(CodexExecTrustError);
    else expect(() => validatedCodexExecInvocation(f.command, [], f.boundary)).toThrow(CodexExecTrustError);
    f.assertChecks(asyncMode);
  });
  for (const [bundle, layout] of apps) for (const missing of ["binary", "bundle", "escape", "outside Contents"] as const) {
    test(`known app fails closed: ${bundle}, ${missing}, async=${asyncMode}`, async () => {
      const binary = missing === "outside Contents" ? bundle + "/codex" : bundle + layout;
      let checks = 0;
      const deps = {
        platform: "darwin" as const, executable: () => true,
        realpath: (path: string) => {
          if (missing === "binary" && path === binary || missing === "bundle" && path === bundle) return null;
          return missing === "escape" && path === binary ? "/outside/codex" : path;
        },
        macBundleTrustReason: () => { checks++; return null; },
        macBundleTrustReasonAsync: async () => { checks++; return null; },
      };
      if (asyncMode) await expect(validatedCodexExecInvocationAsync(binary, [], deps)).rejects.toThrow(CodexExecTrustError);
      else expect(() => validatedCodexExecInvocation(binary, [], deps)).toThrow(CodexExecTrustError);
      expect(checks).toBe(0);
    });
  }

  test(`arbitrary CLI and third-party apps preserve passthrough, async=${asyncMode}`, async () => {
    let checks = 0;
    const deps = { platform: "darwin" as const, executable: () => true, realpath: (path: string) => path,
      macBundleTrustReason: () => { checks++; return "refused"; },
      macBundleTrustReasonAsync: async () => { checks++; return "refused"; } };
    for (const binary of ["/opt/bin/codex", "/opt/Other.app/Contents/codex", "/opt/Codex.app-copy/Contents/codex"]) {
      const invocation = asyncMode ? await validatedCodexExecInvocationAsync(binary, [], deps)
        : validatedCodexExecInvocation(binary, [], deps);
      expect(invocation.file).toBe(binary);
    }
    expect(checks).toBe(0);
  });

  test(`non-Darwin known-app spelling preserves passthrough, async=${asyncMode}`, async () => {
    const binary = apps[0][0] + apps[0][1];
    const deps: CodexExecBoundaryDeps = { platform: "linux", macBundleTrustReason: () => { throw new Error("unexpected verifier"); } };
    const invocation = asyncMode ? await validatedCodexExecInvocationAsync(binary, [], deps)
      : validatedCodexExecInvocation(binary, [], deps);
    expect(invocation.file).toBe(binary);
  });
}

// Exercise the actual shared verifier for both layouts, without native codesign processes.
for (const [name, layout] of [["Codex", "Resources/codex-aarch64-apple-darwin"], ["ChatGPT", "Resources/codex-cli/bin/codex"]]) {
  for (const defect of ["none", "signature", "team", "owner", "mode", "ancestor", "symlink", "outside Contents"]) {
    test(`shared sync/async verifier: ${name}, ${defect}`, async () => {
      const root = resolve(`/opt/relocated/${name}.app`);
      const binary = join(root, defect === "outside Contents" ? "codex" : `Contents/${layout}`);
      const syncCalls: string[][] = [], asyncCalls: string[][] = [];
      const reply: BundleTrustDeps["codesign"] = () => ({ status: defect === "signature" ? 1 : 0,
        output: `TeamIdentifier=${defect === "team" ? "OTHERTEAM" : OPENAI_TEAM_ID}\n` });
      const deps: BundleTrustDeps = {
        uid: 501,
        stat: path => ({ uid: defect === "owner" && path === binary ? 502 : 0,
          mode: defect === "mode" && path === binary || defect === "ancestor" && path === dirname(root) ? 0o777 : 0o755,
          isFile: path === binary, isDirectory: path !== binary,
          isSymbolicLink: defect === "symlink" && path === binary }),
        codesign: args => { syncCalls.push([...args]); return reply(args); },
      };
      const syncReason = untrustedChatgptBundleReason(root, binary, deps);
      const asyncReason = await untrustedChatgptBundleReasonAsync(root, binary, { ...deps, codesign: async args => {
        asyncCalls.push([...args]); return reply(args);
      } });
      expect(asyncReason).toBe(syncReason);
      expect(asyncCalls).toEqual(syncCalls);
      if (defect === "none") {
        expect(syncReason).toBeNull();
        expect(syncCalls).toEqual([["--verify", "--strict", root], ["-dv", "--verbose=2", root],
          ["--verify", "--strict", binary], ["-dv", "--verbose=2", binary]]);
      } else expect(syncReason).not.toBeNull();
    });
  }
}
