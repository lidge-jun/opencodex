import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { constants, copyFileSync, existsSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import {
  probePromptText, setPromptTextProbeRuntimeForTests, setPromptTextProbeCommandForTests,
  setPromptTextProbeExecBoundaryDepsForTests, promptTextProbeSpawnAttemptsForTests,
  resetPromptTextProbeForTests,
} from "../../src/codex/prompt-text-probe";
import { resolveCodexHomeDir } from "../../src/codex/home";
import type { CodexExecBoundaryAsyncDeps } from "../../src/codex/exec-boundary";
import { nativeMainCodexLoginValidatedInvocation, type NativeMainCodexLoginInvocationDeps } from "../../src/cli/account-main";
import { removeTreeWithRetry } from "../helpers/remove-tree";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void, reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function bounded<T>(promise: Promise<T>, description: string, milliseconds = 2_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(description)), milliseconds);
    })]);
  } finally { clearTimeout(timer); }
}

const nextTurn = () => new Promise<void>(resolve => setTimeout(resolve, 0));
const bundle = "/Applications/ChatGPT.app";
const appBinary = `${bundle}/Contents/Resources/codex-cli/bin/codex`;
const output = JSON.stringify([{ type: "message", role: "developer", content: [
  { type: "input_text", text: "<skills_instructions>execution boundary fixture</skills_instructions>" },
] }]);
let directory: string, previousHome: string | undefined;
const releaseOnCleanup: Array<() => void> = [];

beforeEach(async () => {
  await resetPromptTextProbeForTests();
  previousHome = process.env.CODEX_HOME;
  directory = mkdtempSync(join(tmpdir(), "ocx-exec-boundary-launch-"));
  process.env.CODEX_HOME = directory;
});

afterEach(async () => {
  for (const release of releaseOnCleanup.splice(0)) release();
  try { await resetPromptTextProbeForTests(); }
  finally {
    if (previousHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousHome;
    await removeTreeWithRetry(directory);
  }
});

function controlledTrust() {
  const entered = deferred<void>(), verification = deferred<string | null>();
  let calls = 0, signal: AbortSignal | undefined;
  releaseOnCleanup.push(() => verification.resolve(null));
  const check: NonNullable<CodexExecBoundaryAsyncDeps["macBundleTrustReasonAsync"]> = async (root, binary, nextSignal) => {
    calls++;
    expect(root).toBe(canonicalFixtureBundle());
    expect(binary).toBe(canonicalFixtureBinary());
    signal = nextSignal;
    entered.resolve();
    return verification.promise;
  };
  return { entered, verification, check, get calls() { return calls; }, get signal() { return signal; } };
}

function canonicalFixtureBundle() { return join(directory, "Codex.app").replaceAll("\\", "/"); }
function canonicalFixtureBinary() { return canonicalFixtureBundle() + "/Contents/MacOS/bun" + (process.platform === "win32" ? ".exe" : ""); }

function installProbe(check: NonNullable<CodexExecBoundaryAsyncDeps["macBundleTrustReasonAsync"]>) {
  // A real executable inside the canonical bundle keeps admission/lifecycle probes
  // valid without letting an accepting injected verifier authorize an escaped target.
  const binary = canonicalFixtureBinary();
  if (!existsSync(binary)) {
    mkdirSync(join(canonicalFixtureBundle(), "Contents", "MacOS"), { recursive: true });
    copyFileSync(process.execPath, binary, constants.COPYFILE_FICLONE);
  }
  setPromptTextProbeRuntimeForTests({ command: appBinary, source: "installed" });
  setPromptTextProbeCommandForTests({ binary: appBinary, args: ["-e", `process.stdout.write(${JSON.stringify(output)})`] });
  const deps: CodexExecBoundaryAsyncDeps = {
    platform: "darwin", env: { HOME: "/Users/boundary-fixture", PATH: "" },
    executable: candidate => candidate === appBinary,
    realpath: candidate => candidate === appBinary ? binary : candidate === bundle ? canonicalFixtureBundle() : candidate,
    macBundleTrustReasonAsync: check,
  };
  expect(Object.hasOwn(deps, "cwd")).toBe(false);
  setPromptTextProbeExecBoundaryDepsForTests(deps);
}

describe("prompt execution boundary admission", () => {
  test("two independently admitted cold callers share trust, spawn, and result", async () => {
    const trust = controlledTrust(); installProbe(trust.check);
    const first = probePromptText(5_000);
    await bounded(trust.entered.promise, "first caller never entered trust");
    // Admit the second only after the first is suspended inside its own trust promise.
    const second = probePromptText(5_000);
    expect(second).not.toBe(first);
    await nextTurn();
    expect(trust.calls).toBe(1);
    expect(promptTextProbeSpawnAttemptsForTests()).toBe(0);
    trust.verification.resolve(null);
    const [a, b] = await bounded(Promise.all([first, second]), "shared probe did not finish", 10_000);
    expect(a.ok).toBe(true);
    expect(b).toEqual(a);
    expect(promptTextProbeSpawnAttemptsForTests()).toBe(1);
    expect(trust.calls).toBe(1);
  }, 15_000);

  test("overall timeout bounds the result while trust reaping retains the sole slot", async () => {
    const entered = deferred<void>(), lateVerification = deferred<void>(), reap = deferred<void>(), closed = deferred<void>();
    releaseOnCleanup.push(() => { lateVerification.resolve(); reap.resolve(); });
    let calls = 0, signal: AbortSignal | undefined;
    installProbe(async (_root, _binary, currentSignal) => {
      calls++; signal = currentSignal; entered.resolve();
      const aborted = deferred<void>();
      const onAbort = () => aborted.resolve();
      currentSignal?.addEventListener("abort", onAbort, { once: true });
      if (currentSignal?.aborted) onAbort();
      try {
        await Promise.race([lateVerification.promise, aborted.promise]);
        if (currentSignal?.aborted) { await reap.promise; throw currentSignal.reason; }
        return null;
      } finally { currentSignal?.removeEventListener("abort", onAbort); closed.resolve(); }
    });
    const first = probePromptText(60);
    await bounded(entered.promise, "timeout probe never entered trust");
    const result = await bounded(first, "trust escaped the overall prompt deadline");
    expect(result.ok).toBe(false);
    expect(signal?.aborted).toBe(true);
    expect(promptTextProbeSpawnAttemptsForTests()).toBe(0);
    const blocked = await bounded(probePromptText(60), "terminating trust flight did not fail soft");
    expect(blocked.ok).toBe(false);
    expect(blocked.detail).toContain("still finishing");
    expect(calls).toBe(1);
    lateVerification.resolve(); await nextTurn();
    expect(promptTextProbeSpawnAttemptsForTests()).toBe(0);
    expect((await bounded(probePromptText(60), "slot released before trust reap")).detail).toContain("still finishing");
    expect(calls).toBe(1);
    reap.resolve(); await bounded(closed.promise, "trust did not finish reaping"); await nextTurn();
    installProbe(async () => null);
    expect((await bounded(probePromptText(5_000), "reaped flight did not release admission", 10_000)).ok).toBe(true);
    expect(promptTextProbeSpawnAttemptsForTests()).toBe(1);
  }, 15_000);

  test("cancelling one waiter leaves another waiter and shared trust alive", async () => {
    const trust = controlledTrust(); installProbe(trust.check);
    const caller = new AbortController();
    const first = probePromptText(5_000, caller.signal);
    await bounded(trust.entered.promise, "first waiter never entered trust");
    const second = probePromptText(5_000); await nextTurn();
    caller.abort();
    expect((await bounded(first, "cancelled waiter remained blocked")).detail).toContain("cancelled");
    expect(trust.signal).toBeDefined();
    expect(trust.signal?.aborted).toBe(false);
    expect(trust.calls).toBe(1);
    trust.verification.resolve(null);
    expect((await bounded(second, "remaining waiter was cancelled", 10_000)).ok).toBe(true);
    expect(promptTextProbeSpawnAttemptsForTests()).toBe(1);
  }, 15_000);

  test("the final waiter cancellation aborts shared trust and starts no child", async () => {
    const entered = deferred<void>(), aborted = deferred<void>();
    let sharedSignal: AbortSignal | undefined, calls = 0;
    installProbe(async (_root, _binary, signal) => {
      calls++; sharedSignal = signal; entered.resolve();
      return new Promise<null>((_resolve, reject) => {
        const stop = () => { aborted.resolve(); reject(signal?.reason ?? new Error("aborted")); };
        signal?.addEventListener("abort", stop, { once: true });
        if (signal?.aborted) stop();
      });
    });
    const a = new AbortController(), b = new AbortController();
    const first = probePromptText(5_000, a.signal);
    await bounded(entered.promise, "shared trust did not start");
    const second = probePromptText(5_000, b.signal); await nextTurn();
    a.abort(); await bounded(first, "first cancelled caller did not finish");
    expect(sharedSignal?.aborted).toBe(false);
    b.abort();
    expect((await bounded(second, "final cancelled caller did not finish")).ok).toBe(false);
    await bounded(aborted.promise, "final waiter did not abort shared controller");
    expect(sharedSignal?.aborted).toBe(true);
    expect(calls).toBe(1);
    expect(promptTextProbeSpawnAttemptsForTests()).toBe(0);
  });
});

describe("prompt execution boundary cwd", () => {
  for (const command of ["./relative-codex", "codex"]) test(`${command} resolves from the actual spawn cwd with empty PATH`, async () => {
    const observed: string[] = [];
    setPromptTextProbeRuntimeForTests({ command, source: "installed" });
    const deps: CodexExecBoundaryAsyncDeps = {
      platform: "darwin", env: { HOME: "/Users/cwd-fixture", PATH: "" },
      executable: target => { observed.push(target); return false; }, exists: () => false,
    };
    expect(Object.hasOwn(deps, "cwd")).toBe(false);
    setPromptTextProbeExecBoundaryDepsForTests(deps);
    const home = resolveCodexHomeDir();
    const result = await bounded(probePromptText(2_000), "cwd probe did not return ENOENT");
    expect(result.ok).toBe(false);
    expect(result.failure?.kind).toBe("program-not-found");
    const expected = command.includes("/") ? posix.resolve(home, command) : `${home}/${command}`;
    expect(observed).toEqual([expected]);
    expect(home).not.toBe(process.cwd());
    expect(promptTextProbeSpawnAttemptsForTests()).toBe(0);
  });
});

describe("validated native login invocation", () => {
  test("Windows .cmd login retains ComSpec dispatch and verbatim argument options", async () => {
    const command = "C:/fake/codex.cmd", comspec = "C:/Windows/System32/cmd.exe";
    const configDir = join(directory, "config"); mkdirSync(configDir);
    const probed: string[] = [];
    const exists = (path: string) => path.replaceAll("\\", "/").toLowerCase() === command.toLowerCase();
    const deps: NativeMainCodexLoginInvocationDeps & CodexExecBoundaryAsyncDeps = {
      platform: "win32", env: { CODEX_CLI_PATH: command, ComSpec: comspec, PATH: "", PATHEXT: ".CMD;.EXE" },
      configDir, existsSync: exists, exists,
      readFileSync: () => { throw Object.assign(new Error("missing fixture state"), { code: "ENOENT" }); },
      execFileSync: file => { probed.push(file); return "codex-cli 0.162.0"; },
    };
    const invocation = await nativeMainCodexLoginValidatedInvocation("win32", deps);
    expect(invocation.file).toBe(comspec);
    expect(invocation.args.slice(0, 3)).toEqual(["/d", "/s", "/c"]);
    expect(invocation.args[3]).toContain(command);
    expect(invocation.args[3]).toContain("login");
    expect(invocation.options.windowsVerbatimArguments).toBe(true);
    expect(probed.length).toBeGreaterThan(0);
  });
});
