import { describe, expect, test } from "bun:test";
import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import {
  OPENAI_TEAM_ID, untrustedChatgptBundleReason, untrustedChatgptBundleReasonAsync,
  defaultAsyncBundleTrustDeps,
  type AsyncBundleTrustDeps, type BundleTrustDeps, type TrustCommandSpawn,
} from "../../src/chatgpt/app-server-shim/bundle-trust";

const root = resolve("/Applications/ChatGPT.app");
const binary = join(root, "Contents", "Resources", "codex-cli", "CodexCLI.app", "Contents", "MacOS", "codex");
const shell = join(root, "Contents", "MacOS", "ChatGPT");
type Stat = NonNullable<ReturnType<BundleTrustDeps["stat"]>>;
type Reply = ReturnType<BundleTrustDeps["codesign"]>;
const trustedReply = (args: readonly string[]): Reply => ({ status: 0,
  output: args[0] === "--verify" ? "" : `Identifier=codex\nTeamIdentifier=${OPENAI_TEAM_ID}\n` });

function fixture(overrides = new Map<string, Partial<Stat> | null>(), adminGroupId: number | null = 80,
  reply: (args: readonly string[]) => Reply = trustedReply) {
  const syncCalls: string[][] = [], asyncCalls: string[][] = [], observed: string[] = [];
  const common = {
    uid: 501, adminGroupId: adminGroupId ?? undefined,
    stat(path: string): Stat | null {
      observed.push(path);
      const change = overrides.get(path);
      if (change === null) return null;
      const isFile = path === binary || path === shell;
      return { uid: isFile || path === root ? 501 : 0, gid: 80, mode: 0o755,
        isFile, isDirectory: !isFile, isSymbolicLink: false, ...change };
    },
  };
  const sync: BundleTrustDeps = { ...common, codesign: args => { syncCalls.push([...args]); return reply(args); } };
  const async: AsyncBundleTrustDeps = { ...common, codesign: async args => { asyncCalls.push([...args]); return reply(args); } };
  return { sync, async, syncCalls, asyncCalls, observed };
}

describe("async bundle trust policy", () => {
  for (const selected of [binary, undefined]) test(`verifies the bundle and ${selected ? "selected binary" : "restore shell"}`, async () => {
    const f = fixture(), target = selected ?? shell;
    expect(untrustedChatgptBundleReason(root, selected, f.sync)).toBeNull();
    expect(await untrustedChatgptBundleReasonAsync(root, selected, f.async)).toBeNull();
    const expected = [
      ["--verify", "--strict", root], ["-dv", "--verbose=2", root],
      ["--verify", "--strict", target], ["-dv", "--verbose=2", target],
    ];
    expect(f.syncCalls).toEqual(expected);
    expect(f.asyncCalls).toEqual(expected);
    expect(f.observed).toContain(dirname(dirname(root)));
  });

  test("root ownership retains the same trusted result as current-user ownership", async () => {
    const f = fixture(new Map([[root, { uid: 0 }], [binary, { uid: 0 }]]));
    expect(untrustedChatgptBundleReason(root, binary, f.sync)).toBeNull();
    expect(await untrustedChatgptBundleReasonAsync(root, binary, f.async)).toBeNull();
    expect(f.asyncCalls).toEqual(f.syncCalls);
  });

  const rejectedPaths: Array<[string, string, Partial<Stat> | null, string]> = [
    ["missing executable", binary, null, "missing"],
    ["foreign executable", binary, { uid: 502 }, "another user"],
    ["group-writable executable", binary, { mode: 0o775 }, "writable"],
    ["world-writable bundle", root, { mode: 0o757 }, "writable"],
    ["symlink executable", binary, { isSymbolicLink: true }, "symbolic link"],
    ["symlink bundle", root, { isSymbolicLink: true }, "symbolic link"],
    ["symlink ancestor", dirname(root), { isSymbolicLink: true }, "ancestor"],
    ["foreign ancestor", dirname(root), { uid: 502 }, "another user"],
    ["writable interior", dirname(binary), { mode: 0o777 }, "writable"],
    ["directory executable", binary, { isFile: false, isDirectory: true }, "not a file"],
  ];
  for (const [name, path, change, reason] of rejectedPaths) test(`${name} rejects before any signature call`, async () => {
    const f = fixture(new Map([[path, change]]));
    const syncReason = untrustedChatgptBundleReason(root, binary, f.sync);
    expect(syncReason).toContain(reason);
    expect(await untrustedChatgptBundleReasonAsync(root, binary, f.async)).toBe(syncReason);
    expect(f.syncCalls).toEqual([]);
    expect(f.asyncCalls).toEqual([]);
  });

  test("an outside executable is not trusted or inspected", async () => {
    const f = fixture(), outside = join(dirname(root), "codex");
    const syncReason = untrustedChatgptBundleReason(root, outside, f.sync);
    expect(syncReason).toContain("outside the bundle");
    expect(await untrustedChatgptBundleReasonAsync(root, outside, f.async)).toBe(syncReason);
    expect(f.observed).toEqual([]);
    expect(f.asyncCalls).toEqual([]);
  });

  const ancestorCases: Array<[string, Partial<Stat>, number | null, boolean]> = [
    ["local admin group", { mode: 0o775, gid: 456 }, 456, true],
    ["other group", { mode: 0o775, gid: 20 }, 80, false],
    ["unavailable admin lookup", { mode: 0o775 }, null, false],
    ["world-writable admin container", { mode: 0o777 }, 80, false],
    ["trusted sticky container", { mode: 0o1777 }, null, true],
    ["foreign sticky owner", { uid: 502, mode: 0o1777 }, 80, false],
  ];
  for (const [name, change, admin, trusted] of ancestorCases) test(`ancestor policy parity: ${name}`, async () => {
    const f = fixture(new Map([[dirname(root), change]]), admin);
    const syncReason = untrustedChatgptBundleReason(root, binary, f.sync);
    expect(await untrustedChatgptBundleReasonAsync(root, binary, f.async)).toBe(syncReason);
    if (trusted) expect(syncReason).toBeNull();
    else { expect(syncReason).not.toBeNull(); expect(f.asyncCalls).toEqual([]); }
  });

  for (const target of [root, binary]) {
    for (const [name, stage, bad] of [
      ["failed verification", "--verify", { status: 1, output: "" }],
      ["unknown verification status", "--verify", { status: null, output: "" }],
      ["foreign team", "-dv", { status: 0, output: "TeamIdentifier=OTHERTEAM\n" }],
      ["embedded team marker", "-dv", { status: 0, output: `NotTeamIdentifier=${OPENAI_TEAM_ID}\n` }],
      ["unknown detail status", "-dv", { status: null, output: `TeamIdentifier=${OPENAI_TEAM_ID}\n` }],
    ] as const) test(`${name} on ${target === root ? "bundle" : "executable"} is rejected`, async () => {
      const f = fixture(undefined, 80, args => args.at(-1) === target && args[0] === stage ? bad : trustedReply(args));
      const syncReason = untrustedChatgptBundleReason(root, binary, f.sync);
      expect(syncReason).toContain(stage === "--verify" ? "code-signature" : "not signed by OpenAI");
      expect(await untrustedChatgptBundleReasonAsync(root, binary, f.async)).toBe(syncReason);
      expect(f.asyncCalls).toEqual(f.syncCalls);
      expect(f.asyncCalls.at(-1)).toEqual(stage === "--verify" ? ["--verify", "--strict", target] : ["-dv", "--verbose=2", target]);
    });
  }

  test("an already-aborted request does not inspect files or call injected codesign", async () => {
    const f = fixture(), controller = new AbortController(), reason = new Error("cancel trust");
    controller.abort(reason);
    const settled = await untrustedChatgptBundleReasonAsync(root, binary, f.async, controller.signal).then(
      () => null,
      cause => cause,
    );
    expect(settled).toBe(reason);
    expect(f.observed).toEqual([]);
    expect(f.asyncCalls).toEqual([]);
  });

  for (const pendingCall of [1, 4]) test(`abort while signature call ${pendingCall} is pending cannot grant trust`, async () => {
    const f = fixture(), controller = new AbortController(), reason = new Error("cancel pending trust");
    let enter!: () => void, release!: () => void;
    const entered = new Promise<void>(resolve => { enter = resolve; });
    const pending = new Promise<void>(resolve => { release = resolve; });
    f.async.codesign = async (args, signal) => {
      f.asyncCalls.push([...args]);
      expect(signal).toBe(controller.signal);
      if (f.asyncCalls.length === pendingCall) { enter(); await pending; }
      return trustedReply(args);
    };
    const result = untrustedChatgptBundleReasonAsync(root, binary, f.async, controller.signal);
    await entered;
    controller.abort(reason);
    // Open the gate before observing the product promise: observing the
    // pending result must never be what the signature call waits on.
    release();
    const settled = await result.then(() => null, cause => cause);
    expect(settled).toBe(reason);
    expect(f.asyncCalls).toHaveLength(pendingCall);
  });
});

// The injected-spawn seam substitutes a long-lived local process for the trust
// command, keeping the cancellation contract meaningful on hosts without
// directory services and without touching real macOS trust commands. The test
// owns that real child directly and reaps it in its cleanup: nothing nested
// between the test and the process can strand it.
const IDLE_CHILD = 'process.on("SIGTERM", () => {}); console.log("ready"); setInterval(() => {}, 1000);';

interface TrustChildState {
  child: ChildProcess | null;
  observedExit: boolean;
  kills: string[];
  spawns: number;
  spawnedAt?: number;
  killElapsedFromSpawn: number[];
}

// Every product-promise wait below runs under a watchdog inside the 20s test
// timeout: a wedged lookup must not strand its owned child or skip cleanup.
const TEST_WATCHDOG_MS = 15_000;
const bounded = <T>(promise: Promise<T>, label: string): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`test watchdog: ${label} still pending`)),
      TEST_WATCHDOG_MS,
    );
    (timer as { unref?: () => void }).unref?.();
    promise.then(resolve, reject).finally(() => clearTimeout(timer));
  });

/** When body is null the injected spawn refuses like a failed exec. */
function trustChildHarness(body: string | null): {
  state: TrustChildState;
  spawn: TrustCommandSpawn;
  cleanup: (controller?: AbortController) => Promise<void>;
} {
  const state: TrustChildState = { child: null, observedExit: false, kills: [], spawns: 0, killElapsedFromSpawn: [] };
  const spawn: TrustCommandSpawn = file => {
    state.spawns += 1;
    if (file !== "/usr/bin/dscl" && file !== "/usr/bin/codesign") {
      throw new Error("unexpected trust command: " + file);
    }
    if (body === null) throw new Error("spawn refused");
    const child = nodeSpawn(process.execPath, ["--eval", body], { stdio: ["ignore", "pipe", "pipe"] });
    state.child = child;
    state.spawnedAt = Date.now();
    child.once("exit", () => { state.observedExit = true; });
    const kill = child.kill.bind(child);
    child.kill = signal => {
      state.kills.push(String(signal ?? "SIGTERM"));
      if (state.spawnedAt !== undefined) state.killElapsedFromSpawn.push(Date.now() - state.spawnedAt);
      return kill(signal);
    };
    return child;
  };
  const cleanup = async (controller?: AbortController) => {
    controller?.abort(new Error("test cleanup"));
    const child = state.child;
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = bounded(new Promise(resolve => child.once("exit", resolve)), "owned child reaped");
      child.kill("SIGKILL");
      await exited;
    }
  };
  return { state, spawn, cleanup };
}

describe("default async bundle trust cancellation", () => {
  test("already-aborted default calls start zero subprocesses", async () => {
    const h = trustChildHarness(IDLE_CHILD);
    const controller = new AbortController();
    const reason = new Error("cancel default trust");
    controller.abort(reason);
    try {
      const depsError = await bounded(
        defaultAsyncBundleTrustDeps(controller.signal, { spawn: h.spawn }).then(() => null, cause => cause),
        "pre-aborted deps rejection",
      );
      expect(depsError).toBe(reason);
      const trustError = await bounded(
        untrustedChatgptBundleReasonAsync(root, undefined, undefined, controller.signal).then(() => null, cause => cause),
        "pre-aborted trust rejection",
      );
      expect(trustError).toBe(reason);
      expect(h.state.spawns).toBe(0);
    } finally {
      await h.cleanup(controller);
    }
  });

  test("abort of a live default lookup reaps its child before rejecting", async () => {
    const h = trustChildHarness(IDLE_CHILD);
    const controller = new AbortController();
    const reason = new Error("cancel default trust");
    try {
      const run = defaultAsyncBundleTrustDeps(controller.signal, { spawn: h.spawn });
      // The injected spawn ran synchronously inside the first await, so the
      // child exists already; "ready" proves the lookup is genuinely pending.
      await bounded(
        new Promise<void>((resolve, reject) => {
          const child = h.state.child;
          if (!child) return reject(new Error("trust child was not spawned"));
          if (child.exitCode !== null || child.signalCode !== null) return resolve();
          child.stdout?.once("data", () => resolve());
        }),
        "lookup readiness",
      );
      controller.abort(reason);
      const settled = await bounded(run.then(() => null, cause => cause), "abort rejection");
      expect(settled).toBe(reason);
      expect(h.state.spawns).toBe(1);
      expect(h.state.observedExit).toBe(true);
      expect(h.state.kills).toContain("SIGTERM");
      if (process.platform !== "win32") expect(h.state.kills).toContain("SIGKILL");
    } finally {
      await h.cleanup(controller);
    }
  }, 20_000);
});

describe("default trust command runner bounds", () => {
  test("a lookup that outlives its deadline is killed and reaped", async () => {
    const h = trustChildHarness(IDLE_CHILD);
    const startedAt = Date.now();
    try {
      const deps = await bounded(
        defaultAsyncBundleTrustDeps(undefined, { spawn: h.spawn }),
        "deadline lookup",
      );
      const elapsed = Date.now() - startedAt;
      // The 5s dscl deadline fired and supplied no admin-group evidence.
      expect(deps.adminGroupId).toBeUndefined();
      expect(h.state.spawns).toBe(1);
      expect(h.state.observedExit).toBe(true);
      expect(h.state.kills).toContain("SIGTERM");
      if (process.platform !== "win32") expect(h.state.kills).toContain("SIGKILL");
      expect(elapsed).toBeGreaterThanOrEqual(4_500);
      expect(elapsed).toBeLessThan(14_000);
    } finally {
      await h.cleanup();
    }
  }, 20_000);

  test("output past the shared 1 MiB cap stops the lookup before its deadline", async () => {
    const h = trustChildHarness(IDLE_CHILD);
    try {
      const run = bounded(
        defaultAsyncBundleTrustDeps(undefined, { spawn: h.spawn }),
        "overflow lookup",
      );
      const child = h.state.child;
      if (!child) throw new Error("trust child was not spawned");
      // The synchronous emit delivers the overflow inside this call: any kill
      // it records comes from the cap handler, since no timer can fire mid-tick.
      expect(h.state.kills).toHaveLength(0);
      child.stdout?.emit("data", Buffer.alloc(1_048_577));
      expect(h.state.kills).toContain("SIGTERM");
      const deps = await run;
      // Overflow is not trust evidence: the lookup ends killed and reaped.
      expect(deps.adminGroupId).toBeUndefined();
      expect(h.state.observedExit).toBe(true);
    } finally {
      await h.cleanup();
    }
  }, 20_000);

  test("output under the cap reaches the deadline instead of an early stop", async () => {
    const h = trustChildHarness(IDLE_CHILD);
    try {
      const run = bounded(
        defaultAsyncBundleTrustDeps(undefined, { spawn: h.spawn }),
        "under-cap lookup",
      );
      const child = h.state.child;
      if (!child) throw new Error("trust child was not spawned");
      // A synchronous under-cap burst must not stop the lookup: no kill during
      // the emit. The eventual kill can then only come from the 5s deadline.
      child.stdout?.emit("data", Buffer.alloc(1_048_000));
      expect(h.state.kills).toHaveLength(0);
      const deps = await run;
      expect(deps.adminGroupId).toBeUndefined();
      expect(h.state.observedExit).toBe(true);
      expect(h.state.kills).toContain("SIGTERM");
    } finally {
      await h.cleanup();
    }
  }, 20_000);

  // Covers the synchronous throw path of a refused spawn; an asynchronous
  // "error"-event spawn failure is a different runner contract.
  test("a spawn failure rejects the lookup without leaving a child", async () => {
    const h = trustChildHarness(null);
    const error = await bounded(
      defaultAsyncBundleTrustDeps(undefined, { spawn: h.spawn }).then(
        () => null,
        cause => (cause instanceof Error ? cause : new Error(String(cause))),
      ),
      "spawn failure rejection",
    );
    expect(error?.message).toBe("spawn refused");
    expect(h.state.spawns).toBe(1);
    expect(h.state.child).toBeNull();
    expect(h.state.observedExit).toBe(false);
  });
});
