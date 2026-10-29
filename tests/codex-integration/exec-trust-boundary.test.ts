import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CodexExecTrustError,
  assertCodexExecTargetTrustedAsync,
  validatedCodexExecInvocation,
  validatedCodexExecInvocationAsync,
  type CodexExecBoundaryAsyncDeps,
  type CodexExecBoundaryDeps,
} from "../../src/codex/exec-boundary";
import { codexRuntimeStatePath, resolveCodexRuntime, resolveCodexRuntimeAsync, type ResolveCodexRuntimeDeps } from "../../src/codex/runtime";
import { loadBundledCodexCatalog, loadBundledCodexCatalogAsync } from "../../src/codex/catalog/bundled";
import { codexFeaturesInvocation } from "../../src/cli/v2";
import {
  probePromptText,
  promptTextProbeSpawnAttemptsForTests,
  resetPromptTextProbeForTests,
  setPromptTextProbeExecBoundaryDepsForTests,
  setPromptTextProbeRuntimeForTests,
} from "../../src/codex/prompt-text-probe";
import { CodexRemoteWorkspaceRuntimeFactory } from "../../src/remote-control/workspace-codex-runtime";
import type { RemoteWorkspaceCoordinator } from "../../src/remote-control/workspace-coordinator";
import { removeTreeWithRetry } from "../helpers/remove-tree";

// Every check is dependency-injected: platform "darwin" with fake PATH/executable/
// realpath/trust answers, so the boundary contract is exercised on any host OS.
const HOME = "/home/tester";
const BUNDLE = HOME + "/Applications/ChatGPT.app";
const APP_BIN = BUNDLE + "/Contents/Resources/codex-cli/bin/codex";
const THIRD_PARTY_APP_BIN = "/opt/Other.app/Contents/Resources/codex";

const roots: string[] = [];
afterEach(async () => {
  await resetPromptTextProbeForTests();
  for (const path of roots.splice(0)) await removeTreeWithRetry(path);
});

function harness() {
  const files = new Set<string>();
  const runnable = new Set<string>();
  const links = new Map<string, string>();
  const unresolvable = new Set<string>();
  const spawned: string[] = [];
  const syncCalls: string[][] = [];
  const asyncCalls: string[][] = [];
  const env: NodeJS.ProcessEnv = { HOME, PATH: "" };
  const state = { trustReason: null as string | null };
  const configDir = mkdtempSync(join(tmpdir(), "ocx-exec-boundary-"));
  roots.push(configDir);
  const realpath = (path: string) => unresolvable.has(path) ? null : (links.get(path) ?? path);
  const trustSync = (bundle: string, binary: string) => { syncCalls.push([bundle, binary]); return state.trustReason; };
  const trustAsync = async (bundle: string, binary: string) => { asyncCalls.push([bundle, binary]); return state.trustReason; };
  const boundary: CodexExecBoundaryAsyncDeps = {
    env, platform: "darwin",
    exists: path => files.has(path),
    executable: path => runnable.has(path),
    realpath,
    macBundleTrustReason: trustSync,
    macBundleTrustReasonAsync: trustAsync,
  };
  const resolve: ResolveCodexRuntimeDeps = {
    env, platform: "darwin", configDir,
    existsSync: path => files.has(path),
    executable: path => runnable.has(path),
    realpath,
    readBundleIdentifier: () => "com.openai.codex",
    macBundleTrustReason: trustSync,
    macBundleTrustReasonAsync: trustAsync,
    execFileSync: file => { spawned.push(file); return "codex-cli 0.160.0"; },
    execFile: async file => { spawned.push(file); return "codex-cli 0.160.0"; },
  };
  const addApp = () => { files.add(APP_BIN); runnable.add(APP_BIN); };
  return { files, runnable, links, unresolvable, spawned, syncCalls, asyncCalls, env, state, boundary, resolve, addApp };
}

describe("macOS Codex exec boundary", () => {
  test("an untrusted app-bundle candidate is refused at exec and never probed", () => {
    const h = harness(); h.addApp(); h.state.trustReason = "untrusted";
    const result = resolveCodexRuntime(h.resolve);
    expect(result.runtime.source).toBe("fallback");
    expect(h.syncCalls).toEqual([[BUNDLE, APP_BIN]]);
    expect(h.asyncCalls).toEqual([]);
    expect(h.spawned).not.toContain(APP_BIN);
    expect(result.failures.some(failure => failure.reason.includes("untrusted Codex exec target"))).toBe(true);
  });

  test("a trusted app-bundle candidate executes its canonical binary", () => {
    const h = harness(); h.addApp();
    const result = resolveCodexRuntime(h.resolve);
    expect(result.runtime).toEqual({ command: APP_BIN, source: "installed", version: "0.160.0" });
    expect(h.syncCalls).toEqual([[BUNDLE, APP_BIN]]);
    expect(h.spawned).toEqual([APP_BIN]);
  });

  test("async resolution uses only the async trust check and forwards the caller signal", async () => {
    const h = harness(); h.addApp(); h.state.trustReason = "untrusted";
    const controller = new AbortController();
    let seen: AbortSignal | undefined;
    h.resolve.macBundleTrustReasonAsync = async (bundle, binary, signal) => { seen = signal; return "untrusted"; };
    const result = await resolveCodexRuntimeAsync({ ...h.resolve, signal: controller.signal });
    expect(result.runtime.source).toBe("fallback");
    expect(h.syncCalls).toEqual([]);
    expect(seen).toBe(controller.signal);
    expect(h.spawned).not.toContain(APP_BIN);
  });

  test("a deferred selection stays exec-free and performs no trust subprocess", () => {
    const h = harness(); h.addApp();
    const result = resolveCodexRuntime({ ...h.resolve, probeVersion: false, discoverAlternatives: false });
    expect(result.runtime).toEqual({ command: APP_BIN, source: "installed", version: null });
    expect(h.syncCalls).toEqual([]);
    expect(h.spawned).toEqual([]);
  });

  test("a selected command is re-verified at the next exec, not trusted by the earlier probe", () => {
    const h = harness(); h.addApp();
    expect(resolveCodexRuntime(h.resolve).runtime.command).toBe(APP_BIN);
    h.state.trustReason = "signature invalid after replacement";
    expect(() => validatedCodexExecInvocation(APP_BIN, ["--version"], h.boundary)).toThrow(CodexExecTrustError);
    expect(h.syncCalls.length).toBeGreaterThan(1);
  });

  test("a PATH alias inside a known bundle is bound to the canonical target it executes", () => {
    const h = harness(); h.addApp();
    h.files.add("/fake/bin/codex"); h.runnable.add("/fake/bin/codex"); h.links.set("/fake/bin/codex", APP_BIN);
    const invocation = validatedCodexExecInvocation("/fake/bin/codex", ["--version"], h.boundary);
    expect(invocation.file).toBe(APP_BIN);
    expect(h.syncCalls).toEqual([[BUNDLE, APP_BIN]]);
  });

  for (const asyncMode of [false, true]) for (const bundled of [false, true]) {
    test(`bare fallback keeps its executed bundle classification (async=${asyncMode}, bundled=${bundled})`, async () => {
      const h = harness(), persisted = "/fixture/persisted/codex", fallback = "/usr/bin/codex";
      // No PATH enumeration: the bare fallback resolves through Darwin's default execvp path.
      delete h.env.PATH;
      for (const file of [persisted, fallback]) { h.files.add(file); h.runnable.add(file); }
      if (bundled) { h.addApp(); h.links.set(fallback, APP_BIN); }
      writeFileSync(codexRuntimeStatePath(h.resolve.configDir!), JSON.stringify({
        version: 1, command: persisted, source: "installed", origin: "discovered",
        selectedVersion: "0.150.0", updatedAt: "2026-10-13T00:00:00Z",
      }));
      const exec = (file: string) => {
        h.spawned.push(file);
        if (file === persisted) return "codex-cli 0.150.0";
        expect(file).toBe(bundled ? APP_BIN : fallback);
        // Selection must use this execution's evidence, not resolve the changed PATH again.
        h.env.PATH = "/after/probe";
        return "codex-cli 0.162.0";
      };
      const deps = { ...h.resolve, execFileSync: exec, execFile: async (file: string) => exec(file) };
      const result = asyncMode ? await resolveCodexRuntimeAsync(deps) : resolveCodexRuntime(deps);
      expect(result.runtime).toEqual(bundled
        ? { command: persisted, source: "configured", version: "0.150.0" }
        : { command: "codex", source: "fallback", version: "0.162.0" });
      expect(result.replacedConfigured).toBeUndefined();
      if (bundled) expect(result.supersededDiscovered).toBeUndefined();
      else expect(result.supersededDiscovered?.to).toEqual(result.runtime);
      expect(h.spawned).toContain(persisted);
      expect(h.spawned).toContain(bundled ? APP_BIN : fallback);
      expect(asyncMode ? h.syncCalls : h.asyncCalls).toEqual([]);
      if (bundled) expect(asyncMode ? h.asyncCalls : h.syncCalls).toContainEqual([BUNDLE, APP_BIN]);
    });
  }

  test("a bundle member that cannot be canonicalized refuses instead of escaping the check", () => {
    const h = harness(); h.addApp(); h.unresolvable.add(APP_BIN);
    expect(() => validatedCodexExecInvocation(APP_BIN, [], h.boundary)).toThrow(CodexExecTrustError);
    expect(h.syncCalls).toEqual([]);
  });

  test("a binary inside a third-party app bundle is outside the known-bundle policy", () => {
    const h = harness();
    h.files.add(THIRD_PARTY_APP_BIN); h.runnable.add(THIRD_PARTY_APP_BIN);
    expect(validatedCodexExecInvocation(THIRD_PARTY_APP_BIN, [], h.boundary).file).toBe(THIRD_PARTY_APP_BIN);
    expect(h.syncCalls).toEqual([]);
  });

  test("an ordinary non-app PATH binary needs no trust check", () => {
    const h = harness();
    h.files.add("/usr/local/bin/codex"); h.runnable.add("/usr/local/bin/codex"); h.env.PATH = "/usr/local/bin";
    expect(validatedCodexExecInvocation("codex", ["--version"], h.boundary).file).toBe("/usr/local/bin/codex");
    expect(h.syncCalls).toEqual([]);
  });

  test("an empty PATH segment resolves against the spawn working directory", () => {
    const h = harness();
    h.files.add("/work/dir/codex"); h.runnable.add("/work/dir/codex");
    h.env.PATH = "";
    const invocation = validatedCodexExecInvocation("codex", [], { ...h.boundary, cwd: "/work/dir" });
    expect(invocation.file).toBe("/work/dir/codex");
  });

  test("a relative PATH segment resolves against the spawn working directory", () => {
    const h = harness();
    h.files.add("/work/dir/tools/codex"); h.runnable.add("/work/dir/tools/codex");
    h.env.PATH = "tools:/none";
    const invocation = validatedCodexExecInvocation("codex", [], { ...h.boundary, cwd: "/work/dir" });
    expect(invocation.file).toBe("/work/dir/tools/codex");
  });

  test("a slash-bearing command resolves relative to cwd and skips PATH entirely", () => {
    const h = harness();
    h.files.add("/work/dir/tool"); h.runnable.add("/work/dir/tool");
    h.env.PATH = "/elsewhere";
    const invocation = validatedCodexExecInvocation("./tool", [], { ...h.boundary, cwd: "/work/dir" });
    expect(invocation.file).toBe("/work/dir/tool");
  });

  test("a non-executable first PATH entry cannot shadow an executable sibling", () => {
    const h = harness();
    h.files.add("/first/codex"); h.files.add("/second/codex"); h.runnable.add("/second/codex");
    h.env.PATH = "/first:/second";
    expect(validatedCodexExecInvocation("codex", [], h.boundary).file).toBe("/second/codex");
  });

  test("a PATH-free env falls back to the execvp default directories", () => {
    const h = harness();
    delete h.env.PATH;
    h.files.add("/usr/bin/codex"); h.runnable.add("/usr/bin/codex");
    expect(validatedCodexExecInvocation("codex", [], h.boundary).file).toBe("/usr/bin/codex");
  });

  test("an unresolvable bare command refuses ENOENT and a non-executable one EACCES", () => {
    const h = harness();
    h.env.PATH = "/empty";
    expect(() => validatedCodexExecInvocation("codex", [], h.boundary)).toThrowError(/ENOENT/);
    h.files.add("/deny/codex"); h.env.PATH = "/deny";
    expect(() => validatedCodexExecInvocation("codex", [], h.boundary)).toThrowError(/EACCES/);
  });

  test("the async invocation honours a pre-aborted signal and surfaces injected refusals", async () => {
    const h = harness(); h.addApp(); h.state.trustReason = "untrusted";
    const controller = new AbortController(); controller.abort();
    await expect(assertCodexExecTargetTrustedAsync(APP_BIN, { ...h.boundary, signal: controller.signal })).rejects.toThrow();
    await expect(assertCodexExecTargetTrustedAsync(APP_BIN, h.boundary)).rejects.toThrow(CodexExecTrustError);
    expect(h.asyncCalls).toEqual([[BUNDLE, APP_BIN]]);
  });

  for (const asyncMode of [false, true]) {
    test(`an untrusted probe failure reason is redacted and bounded (async=${asyncMode})`, async () => {
      const h = harness(); h.addApp();
      h.state.trustReason = "signature mismatch under /home/tester/Applications/ChatGPT.app "
        + "with password=hunter2 and sk-livetoken1234567 " + "x".repeat(300);
      const result = asyncMode ? await resolveCodexRuntimeAsync(h.resolve) : resolveCodexRuntime(h.resolve);
      const reason = result.failures.find(failure => failure.reason.includes("untrusted Codex exec target"))?.reason;
      expect(reason).toContain("untrusted Codex exec target");
      expect(reason).not.toContain("/home/tester");
      expect(reason).not.toContain("hunter2");
      expect(reason).not.toContain("sk-livetoken1234567");
      expect(reason?.length).toBeLessThanOrEqual(160);
    });
  }
});

describe("exec boundary consumers", () => {
  const native = { slug: "gpt-test", base_instructions: "Fixture instructions." };

  test("the bundled catalog skips an untrusted app candidate and uses the next command", async () => {
    const h = harness(); h.addApp(); h.state.trustReason = "untrusted";
    h.files.add("/fake/bin/codex"); h.runnable.add("/fake/bin/codex");
    const deps = {
      env: h.env,
      platform: "darwin" as const,
      commandCandidates: () => [APP_BIN, "/fake/bin/codex"],
      existsSync: (path: string) => h.files.has(path),
      executable: (path: string) => h.runnable.has(path),
      realpath: (path: string) => path,
      macBundleTrustReason: (bundle: string, binary: string) => { h.syncCalls.push([bundle, binary]); return h.state.trustReason; },
      macBundleTrustReasonAsync: async (bundle: string, binary: string) => { h.asyncCalls.push([bundle, binary]); return h.state.trustReason; },
      execFileSync: (file: string) => { h.spawned.push(file); return JSON.stringify({ models: [native] }); },
      execFile: async (file: string) => { h.spawned.push(file); return JSON.stringify({ models: [native] }); },
      configDir: join(mkdtempSync(join(tmpdir(), "ocx-exec-catalog-"))),
    };
    roots.push(deps.configDir);
    const sync = loadBundledCodexCatalog(deps);
    expect(sync?.models[0]?.slug).toBe("gpt-test");
    const asyncResult = await loadBundledCodexCatalogAsync(deps);
    expect(asyncResult?.models[0]?.slug).toBe("gpt-test");
    expect(h.spawned).toEqual(["/fake/bin/codex", "/fake/bin/codex"]);
    expect(h.syncCalls).toEqual([[BUNDLE, APP_BIN]]);
    expect(h.asyncCalls).toEqual([[BUNDLE, APP_BIN]]);
  });

  test("codex features invocation throws at the boundary even after the probe trusted the selection", () => {
    const h = harness(); h.addApp(); h.env.CODEX_CLI_PATH = APP_BIN;
    let calls = 0;
    const deps = {
      env: h.env,
      configDir: h.resolve.configDir,
      existsSync: (path: string) => h.files.has(path),
      execFileSync: (file: string) => { h.spawned.push(file); return "codex-cli 0.160.0"; },
      readBundleIdentifier: () => "com.openai.codex",
      executable: (path: string) => h.runnable.has(path),
      realpath: (path: string) => path,
      macBundleTrustReason: (bundle: string, binary: string) => { calls++; h.syncCalls.push([bundle, binary]); return calls > 1 ? "replaced" : null; },
    };
    expect(() => codexFeaturesInvocation("enable", "multi_agent_v2", "darwin", deps)).toThrow(CodexExecTrustError);
  });

  test("the prompt probe rejects an untrusted target without ever spawning", async () => {
    const h = harness(); h.addApp(); h.state.trustReason = "untrusted";
    setPromptTextProbeRuntimeForTests({ command: APP_BIN, source: "installed" });
    setPromptTextProbeExecBoundaryDepsForTests(h.boundary);
    const result = await probePromptText(5_000);
    expect(result.ok).toBe(false);
    expect(result.failure?.kind).toBe("execution-failed");
    expect(promptTextProbeSpawnAttemptsForTests()).toBe(0);
  });

  test("an aborted prompt-probe validation cannot spawn either", async () => {
    const h = harness(); h.addApp();
    setPromptTextProbeRuntimeForTests({ command: APP_BIN, source: "installed" });
    setPromptTextProbeExecBoundaryDepsForTests({
      ...h.boundary,
      // Signal-honoring stub: stays pending until the forwarded signal aborts,
      // then settles - the boundary awaits it rather than abandoning it.
      macBundleTrustReasonAsync: (_bundle, _binary, signal) => new Promise((_, reject) => {
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      }),
    });
    const controller = new AbortController();
    const pending = probePromptText(5_000, controller.signal);
    controller.abort();
    const result = await pending;
    expect(result.ok).toBe(false);
    expect(promptTextProbeSpawnAttemptsForTests()).toBe(0);
  });

  test("a remote workspace refuses an untrusted Codex executable before any child starts", async () => {
    const h = harness(); h.addApp(); h.state.trustReason = "untrusted";
    const factory = new CodexRemoteWorkspaceRuntimeFactory({
      // Workspace prepares its native helper/isolation before taking the launch
      // gate. Use a real native binary there, then map its trust check to the app.
      command: [process.execPath],
      execDeps: {
        ...h.boundary,
        cwd: "/fixture", // Keep injected macOS PATH semantics independent of the host cwd.
        executable: () => true,
        realpath: path => path === BUNDLE ? BUNDLE : APP_BIN,
      },
    });
    const spawn = spyOn(Bun, "spawn").mockImplementation(() => { throw new Error("unexpected untrusted spawn"); });
    try {
      await expect(factory.start({
        sessionId: "s", deviceId: "d", deviceName: "d", rootId: "r", rootLabel: "r",
        capabilities: ["workspace.read"], tools: ["read_file"], coordinator: {} as RemoteWorkspaceCoordinator, emit: () => {},
      })).rejects.toThrow(CodexExecTrustError);
      expect(h.asyncCalls).toEqual([[BUNDLE, APP_BIN]]);
      expect(spawn).toHaveBeenCalledTimes(0);
    } finally { spawn.mockRestore(); }
  });
});
