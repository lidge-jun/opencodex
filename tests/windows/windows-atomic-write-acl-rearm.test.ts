import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  forgetHardenedSecretPath,
  flushWindowsSecretAclReapsBeforeRemoval,
  hardenSecretPath,
  resetHardenedStateForTests,
  setAsyncIcaclsRunnerForTests,
  setAsyncIcaclsBeltSchedulerForTests,
  setIcaclsRunnerForTests,
  setNowForTests,
  setPlatformForTests,
  TIMEOUT_MEMO_REARM_MS,
  timedOutSecretPathCountForTests,
  windowsSecretAclReapPendingForPath,
  type IcaclsResult,
} from "../../src/lib/windows-secret-acl";
import {
  resetWindowsPrincipalForTests,
  setAsyncWindowsPrincipalRunnerForTests,
  setWindowsPrincipalRunnerForTests,
} from "../../src/lib/windows-user-principal";

const native = { ...fs };
let root = "";
let denyUnlink = false;
// Exercise the default cleanup hardener, rather than replacing io.harden with a fake.
mock.module("node:fs", () => ({
  ...native,
  unlinkSync(path: fs.PathLike) {
    if (denyUnlink && String(path).startsWith(join(root, "secret.json.ocx."))) {
      throw Object.assign(new Error("fixture holds temporary file"), { code: "EACCES" });
    }
    native.unlinkSync(path);
  },
}));
const {
  atomicWriteFile,
  atomicWriteFileAsync,
  atomicWriteFileStreamed,
  AtomicWriteResidualTempError,
  setWindowsHardeningForTests,
} = await import("../../src/config/atomic-write");

const OK: IcaclsResult = { success: true, exitCode: 0, timedOut: false, stdout: "" };
const PRINCIPAL = { ...OK, stdout: "S-1-5-21-9-9-9-1001\r\nTESTHOST\\tester" };
let now = 0;
let state: "healthy" | "timeout" | "denied" = "healthy";
let grants: string[] = [];
let previousTimeout: string | undefined;
let previousVerify: string | undefined;

function runAcl(args: string[]): IcaclsResult {
  if (args.includes("/grant:r")) grants.push(native.readFileSync(args[0]!, "utf8"));
  if (state === "timeout") {
    now += 1_000; // Exhaust the injected 1s hardening budget without a real wait.
    return { success: false, exitCode: null, timedOut: true, stdout: "" };
  }
  return state === "healthy" ? OK : { ...OK, success: false, exitCode: 5 };
}

beforeEach(() => {
  // The writer resolves the destination's real parent, and macOS tmpdir() is a symlink
  // (/var -> /private/var); the unlink fixture must match the path the writer actually uses.
  root = native.realpathSync(native.mkdtempSync(join(tmpdir(), "ocx-atomic-acl-rearm-")));
  native.writeFileSync(join(root, "secret.json"), "previous", "utf8");
  previousTimeout = process.env.OPENCODEX_ACL_TIMEOUT_MS;
  previousVerify = process.env.OPENCODEX_ACL_VERIFY_EXISTING;
  process.env.OPENCODEX_ACL_TIMEOUT_MS = "1000";
  delete process.env.OPENCODEX_ACL_VERIFY_EXISTING;
  resetHardenedStateForTests();
  now = 0; state = "healthy"; grants = []; denyUnlink = false;
  setPlatformForTests("win32");
  setWindowsHardeningForTests(true);
  setWindowsPrincipalRunnerForTests(() => PRINCIPAL);
  setAsyncWindowsPrincipalRunnerForTests(async () => PRINCIPAL);
  setIcaclsRunnerForTests(runAcl);
  setAsyncIcaclsRunnerForTests(async args => runAcl(args));
  setNowForTests(() => now);
});

afterEach(() => {
  denyUnlink = false;
  setWindowsHardeningForTests(null);
  setIcaclsRunnerForTests(null);
  setAsyncIcaclsRunnerForTests(null);
  setNowForTests(null);
  setPlatformForTests(null);
  setWindowsPrincipalRunnerForTests(null);
  setAsyncWindowsPrincipalRunnerForTests(null);
  resetWindowsPrincipalForTests();
  resetHardenedStateForTests();
  if (previousTimeout === undefined) delete process.env.OPENCODEX_ACL_TIMEOUT_MS;
  else process.env.OPENCODEX_ACL_TIMEOUT_MS = previousTimeout;
  if (previousVerify === undefined) delete process.env.OPENCODEX_ACL_VERIFY_EXISTING;
  else process.env.OPENCODEX_ACL_VERIFY_EXISTING = previousVerify;
  native.rmSync(root, { recursive: true, force: true });
});
afterAll(() => { mock.restore(); });

const writers = {
  sync: async (path: string, content: string) => { atomicWriteFile(path, content); },
  streamed: async (path: string, content: string) => {
    atomicWriteFileStreamed(path, descriptor => native.writeFileSync(descriptor, content));
  },
  async: (path: string, content: string) => atomicWriteFileAsync(path, content),
};

for (const [name, write] of Object.entries(writers)) {
  describe(`${name} atomic writer timeout recovery (#7834)`, () => {
    test("a later write recovers the same destination, preserving bytes on failure", async () => {
      const destination = join(root, "secret.json");
      state = "timeout";
      await expect(write(destination, "unpublished")).rejects.toMatchObject({ code: "ETIMEDOUT" });
      expect(native.readFileSync(destination, "utf8")).toBe("previous");
      expect(grants).toEqual([""]); // Required ACL admission precedes secret bytes.
      state = "healthy";
      await write(destination, "recovered");
      expect(native.readFileSync(destination, "utf8")).toBe("recovered");
      expect(grants).toEqual(["", ""]);
      expect(timedOutSecretPathCountForTests()).toBe(0);
    });

    test("a stalled recovery admits only one attempt per re-arm window", async () => {
      const destination = join(root, "secret.json");
      state = "timeout";
      await expect(write(destination, "first")).rejects.toMatchObject({ code: "ETIMEDOUT" });
      const consumedAt = now;
      await expect(write(destination, "recovery")).rejects.toMatchObject({ code: "ETIMEDOUT" });
      expect(grants).toHaveLength(2);
      now = consumedAt + TIMEOUT_MEMO_REARM_MS - 1;
      state = "healthy";
      await expect(write(destination, "too early")).rejects.toMatchObject({ code: "EACLRETRYEXHAUSTED" });
      await expect(write(destination, "still early")).rejects.toMatchObject({ code: "EACLRETRYEXHAUSTED" });
      expect(grants).toHaveLength(2);
      now++;
      state = "timeout";
      const rearmedAt = now;
      await expect(write(destination, "still stalled")).rejects.toMatchObject({ code: "ETIMEDOUT" });
      expect(grants).toHaveLength(3);
      expect(native.readFileSync(destination, "utf8")).toBe("previous");
      state = "healthy";
      await expect(write(destination, "blocked again")).rejects.toMatchObject({ code: "EACLRETRYEXHAUSTED" });
      expect(grants).toHaveLength(3);
      now = rearmedAt + TIMEOUT_MEMO_REARM_MS;
      await write(destination, "recovered");
      expect(grants).toEqual(["", "", "", ""]);
      expect(native.readFileSync(destination, "utf8")).toBe("recovered");
    });

    test("non-timeout ACL errors fail closed without a retry or timeout memo", async () => {
      const destination = join(root, "secret.json");
      state = "denied";
      for (let attempt = 1; attempt <= 2; attempt++) {
        await expect(write(destination, "unpublished")).rejects.toThrow();
        expect(grants).toHaveLength(attempt);
        expect(timedOutSecretPathCountForTests()).toBe(0);
        expect(native.readFileSync(destination, "utf8")).toBe("previous");
      }
      state = "healthy";
      await write(destination, "recovered");
      expect(native.readFileSync(destination, "utf8")).toBe("recovered");
    });

    test("cleanup leaves an empty residual without spending the recovery attempt", async () => {
      const destination = join(root, "secret.json");
      state = "timeout"; denyUnlink = true;
      await expect(write(destination, "unpublished")).rejects.toBeInstanceOf(AtomicWriteResidualTempError);
      expect(grants).toEqual([""]);
      const residuals = native.readdirSync(root).filter(path => path.endsWith(".tmp"));
      expect(residuals).toHaveLength(1);
      expect(native.readFileSync(join(root, residuals[0]!), "utf8")).toBe("");
      expect(native.readFileSync(destination, "utf8")).toBe("previous");
      denyUnlink = false; state = "healthy";
      await write(destination, "recovered");
      expect(grants).toEqual(["", ""]);
      expect(native.readFileSync(destination, "utf8")).toBe("recovered");
    });
  });
}

for (const kind of ["sync", "async"] as const) {
  test(`${kind} pre-rename hardener admits a re-armed memo only after a full harden`, async () => {
    const destination = join(root, "secret.json");
    const afterTempWrite = (temp: string) => {
      // Independently poison/consume the destination memo AFTER the initial harden,
      // then invalidate the temp's success memo to exercise the fifth/fourth call site.
      forgetHardenedSecretPath(temp);
      state = "timeout";
      expect(() => hardenSecretPath(temp, { required: true, timeoutMemoKey: destination })).toThrow();
      const consumedAt = now;
      expect(() => hardenSecretPath(temp, {
        required: true, timeoutMemoKey: destination, retryTimedOutOnce: true,
      })).toThrow();
      now = consumedAt + TIMEOUT_MEMO_REARM_MS;
      state = "healthy";
    };
    if (kind === "sync") atomicWriteFile(destination, "replacement", undefined, { afterTempWrite });
    else await atomicWriteFileAsync(destination, "replacement", undefined, { afterTempWrite });
    expect(grants).toEqual(["", "replacement", "replacement", "replacement"]);
    expect(native.readFileSync(destination, "utf8")).toBe("replacement");
    expect(timedOutSecretPathCountForTests()).toBe(0);
  });

  test(`${kind} pre-rename ACL denial still prevents publication`, async () => {
    const destination = join(root, "secret.json");
    const afterTempWrite = (temp: string) => {
      forgetHardenedSecretPath(temp);
      state = "denied";
    };
    if (kind === "sync") expect(() => atomicWriteFile(destination, "replacement", undefined, { afterTempWrite })).toThrow();
    else await expect(atomicWriteFileAsync(destination, "replacement", undefined, { afterTempWrite })).rejects.toThrow();
    expect(grants).toEqual(["", "replacement"]);
    expect(native.readFileSync(destination, "utf8")).toBe("previous");
  });
}

test.each(["timeout", "success", "rejection"] as const)("sequential retries retain one ACL child across re-arm windows (%s)", async reapOutcome => {
  const destination = join(root, "secret.json");
  const held: { path: string; release: (result: IcaclsResult) => void; reject: () => void }[] = [];
  const beltRefusals: string[] = [];
  setAsyncIcaclsRunnerForTests(args => {
    if (!args[0]!.startsWith(`${destination}.ocx.`)) return Promise.resolve(runAcl(args));
    return new Promise((resolve, reject) => {
      held.push({ path: args[0]!, release: resolve, reject: () => reject(new Error("fixture runner failure")) });
    });
  });
  setAsyncIcaclsBeltSchedulerForTests(callback => {
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      now += 1_001;
      callback();
      // Retention must block admission before the timed-out writer reaches finally.
      try { atomicWriteFile(destination, "blocked during belt"); beltRefusals.push("published"); }
      catch (error) { beltRefusals.push((error as NodeJS.ErrnoException).code ?? "unknown"); }
    });
    return () => { cancelled = true; };
  });
  try {
    const retained: number[] = [];
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt > 0) now += TIMEOUT_MEMO_REARM_MS;
      await expect(atomicWriteFileAsync(destination, "unpublished")).rejects.toThrow();
      retained.push(held.filter(entry => windowsSecretAclReapPendingForPath(entry.path)).length);
    }
    expect(retained).toEqual([1, 1, 1]);
    expect(beltRefusals).toEqual(["ETIMEDOUT"]);
    expect(held).toHaveLength(1);
    for (const write of [writers.sync, writers.streamed, writers.async]) {
      now += TIMEOUT_MEMO_REARM_MS;
      await expect(write(destination, "unpublished")).rejects.toMatchObject({ code: "ETIMEDOUT" });
      expect(held).toHaveLength(1);
      expect(grants).toEqual([]);
      expect(native.readFileSync(destination, "utf8")).toBe("previous");
      expect(native.readFileSync(held[0]!.path, "utf8")).toBe("");
    }
    // A different destination is independent, even while this child is retained.
    setAsyncIcaclsBeltSchedulerForTests(null);
    await atomicWriteFileAsync(join(root, "other.json"), "other");
    expect(native.readFileSync(join(root, "other.json"), "utf8")).toBe("other");
    if (reapOutcome === "rejection") held[0]!.reject();
    else held[0]!.release(reapOutcome === "success" ? OK : { ...OK, success: false, timedOut: true, exitCode: null });
    await flushWindowsSecretAclReapsBeforeRemoval(root);
    setAsyncIcaclsRunnerForTests(async args => runAcl(args));
    // Refusals while held must not consume recovery; actual reap admits it immediately.
    await atomicWriteFileAsync(destination, "recovered");
    expect(native.readFileSync(destination, "utf8")).toBe("recovered");
    expect(timedOutSecretPathCountForTests()).toBe(0);
  } finally {
    for (const entry of held) entry.release({ ...OK, success: false, timedOut: true, exitCode: null });
    await flushWindowsSecretAclReapsBeforeRemoval(root);
    setAsyncIcaclsBeltSchedulerForTests(null);
  }
});

test("healthy ACL work allows overlapping async, sync and streamed writers", async () => {
  const destination = join(root, "secret.json");
  let release!: (result: IcaclsResult) => void;
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  let firstCall = true;
  setAsyncIcaclsRunnerForTests(args => {
    if (!firstCall) return Promise.resolve(runAcl(args));
    firstCall = false;
    expect(native.readFileSync(args[0]!, "utf8")).toBe("");
    runAcl(args);
    return new Promise(resolve => { release = resolve; entered(); });
  });
  const first = atomicWriteFileAsync(destination, "first");
  try {
    await started;
    for (const name of ["async", "sync", "streamed"] as const) {
      await writers[name](destination, name);
      expect(native.readFileSync(destination, "utf8")).toBe(name);
    }
    release(OK);
    await first;
    expect(native.readFileSync(destination, "utf8")).toBe("first");
    expect(grants).toEqual(["", "", "", ""]);
    expect(timedOutSecretPathCountForTests()).toBe(0);
  } finally {
    release(OK);
    await first;
    await flushWindowsSecretAclReapsBeforeRemoval(root);
  }
});

test("healthy writes succeed while an earlier write is paused before rename", async () => {
  const destination = join(root, "secret.json");
  let resume!: () => void;
  let entered!: () => void;
  const paused = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { resume = resolve; });
  const first = atomicWriteFileAsync(destination, "first", undefined, {
    afterTempWrite: async temp => {
      expect(native.readFileSync(temp, "utf8")).toBe("first");
      entered();
      await gate;
    },
  });
  try {
    await paused;
    for (const name of ["async", "sync", "streamed"] as const) {
      await writers[name](destination, name);
      expect(native.readFileSync(destination, "utf8")).toBe(name);
    }
    resume();
    await first;
    expect(native.readFileSync(destination, "utf8")).toBe("first");
    expect(grants).toEqual(["", "", "", ""]);
  } finally {
    resume();
    await first;
  }
});

test("completing a healthy peer preserves another write's retained-child guard", async () => {
  const destination = join(root, "secret.json");
  let resume!: () => void;
  let entered!: () => void;
  let reap!: (result: IcaclsResult) => void;
  const paused = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { resume = resolve; });
  const first = atomicWriteFileAsync(destination, "first", undefined, {
    afterTempWrite: async () => { entered(); await gate; },
  });
  try {
    await paused;
    setAsyncIcaclsRunnerForTests(() => new Promise(resolve => { reap = resolve; }));
    setAsyncIcaclsBeltSchedulerForTests(callback => {
      let cancelled = false;
      queueMicrotask(() => { if (!cancelled) { now += 1_001; callback(); } });
      return () => { cancelled = true; };
    });
    await expect(atomicWriteFileAsync(destination, "unpublished")).rejects.toBeInstanceOf(AtomicWriteResidualTempError);
    resume();
    await first;
    expect(native.readFileSync(destination, "utf8")).toBe("first");
    setAsyncIcaclsBeltSchedulerForTests(null);
    setAsyncIcaclsRunnerForTests(async args => runAcl(args));
    for (const write of Object.values(writers)) {
      await expect(write(destination, "blocked")).rejects.toMatchObject({ code: "ETIMEDOUT" });
    }
    expect(grants).toEqual([""]);
    reap({ ...OK, success: false, timedOut: true, exitCode: null });
    await flushWindowsSecretAclReapsBeforeRemoval(root);
    await atomicWriteFileAsync(destination, "recovered");
    expect(native.readFileSync(destination, "utf8")).toBe("recovered");
  } finally {
    resume();
    reap?.({ ...OK, success: false, timedOut: true, exitCode: null });
    await first;
    await flushWindowsSecretAclReapsBeforeRemoval(root);
    setAsyncIcaclsBeltSchedulerForTests(null);
  }
});

test("overlaps admitted before timeout stay guarded until the last child reaps", async () => {
  const destination = join(root, "secret.json");
  const held: { path: string; release: (result: IcaclsResult) => void }[] = [];
  const belts: (() => void)[] = [];
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  setAsyncIcaclsRunnerForTests(args => new Promise(resolve => {
    held.push({ path: args[0]!, release: resolve });
    if (held.length === 2) entered();
  }));
  setAsyncIcaclsBeltSchedulerForTests(callback => { belts.push(callback); return () => {}; });
  const results = ["first", "second"].map(content => atomicWriteFileAsync(destination, content).then(
    () => "published", error => error.name,
  ));
  try {
    expect(await Promise.race([started.then(() => true), results[1]!.then(() => false)])).toBe(true);
    now += 1_001;
    for (const belt of belts) belt();
    expect(await Promise.all(results)).toEqual(["AtomicWriteResidualTempError", "AtomicWriteResidualTempError"]);
    expect(held.every(entry => windowsSecretAclReapPendingForPath(entry.path))).toBe(true);
    setAsyncIcaclsBeltSchedulerForTests(null);
    setAsyncIcaclsRunnerForTests(async args => runAcl(args));
    await expect(atomicWriteFileAsync(destination, "blocked")).rejects.toMatchObject({ code: "ETIMEDOUT" });
    held[0]!.release({ ...OK, success: false, timedOut: true, exitCode: null });
    await flushWindowsSecretAclReapsBeforeRemoval(held[0]!.path);
    now += TIMEOUT_MEMO_REARM_MS;
    await expect(atomicWriteFileAsync(destination, "still blocked")).rejects.toMatchObject({ code: "ETIMEDOUT" });
    expect(native.readFileSync(destination, "utf8")).toBe("previous");
    expect(grants).toEqual([]);
    held[1]!.release(OK);
    await flushWindowsSecretAclReapsBeforeRemoval(root);
    await atomicWriteFileAsync(destination, "recovered");
    expect(native.readFileSync(destination, "utf8")).toBe("recovered");
  } finally {
    now += 1_001;
    for (const belt of belts) belt();
    for (const entry of held) entry.release({ ...OK, success: false, timedOut: true, exitCode: null });
    await Promise.all(results);
    await flushWindowsSecretAclReapsBeforeRemoval(root);
    setAsyncIcaclsBeltSchedulerForTests(null);
  }
});
