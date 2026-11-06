import { createCodexCliTestRoot } from "../helpers/codex-cli-fixture-root";
/**
 * Worker-dispatch integration coverage for the Codex CLI update offload.
 *
 * The generic gate/fence and fixture-worker cases below prove the dispatch
 * contract; they do not by themselves prove the production callers are
 * protected — the real plan/apply worker path and the seven gated parent
 * operations have their own regression cases elsewhere.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CodexCliApplyDeps } from "../../src/codex/cli-update-apply";
import type { TrustedNodeLaunchContext } from "../../src/cli/launcher-context";
import {
  runCodexCliUpdatePlanInWorker, runCodexCliUpdateApplyInWorker,
  cancelCodexCliUpdateWorkerJob, codexCliUpdateUnjoinedWorkerCount,
  codexCliUpdateUnjoinedWorkerClosedTotal, codexCliUpdateWorkerDiagnostics,
} from "../../src/codex/cli-update-job-worker";
import {
  createCodexCliUpdateFence, cancelCodexCliUpdateFence, codexCliUpdateIsCancelled,
  codexCliUpdateSelectionGate, beginCodexCliSelectionParentWrite,
  createWorkerCommitWindow, resetCodexCliSelectionGatesForTests,
  allocateCodexCliUpdateGateOwner,
} from "../../src/codex/cli-update-selection-gate";
import { recoverClosedCodexCliUpdateWorker } from "../../src/codex/cli-update-worker-recovery";
import { hardenSecretDirAsync } from "../../src/lib/windows-secret-acl";
import { trustWindowsTempFixtureAncestry } from "../helpers/windows-temp-ancestry";
import { codexCliUpdateInspectionDepsFromSnapshot } from "../../src/codex/cli-update-inspection-context";
import { removeTreeAfterBackgroundWork } from "../helpers/remove-tree";
import { spawnTestChild } from "../helpers/spawn-test-child";
import { repoRoot } from "../helpers/repo-root";
import { createCodexCliWorkerLifetime } from "../../src/codex/cli-update-worker";
import { WindowsApplyAcquisition, WindowsApplyAuthorityPins } from "../../src/codex/cli-update-job-store-windows";
import {
  FIXTURE_ENTERED, FIXTURE_RELEASE, FIXTURE_RUNS, FIXTURE_FINISHED,
  FIXTURE_CONTROL_WORDS, type FixtureConfiguration,
} from "../helpers/cli-update-fixture-worker";
type Snapshot = TrustedNodeLaunchContext["codexCliInspectionEnv"];
type RunMessage = {
  type: "run"; requestId: string; jobId: string; operation: "plan" | "apply";
  planId?: string; snapshot: Snapshot; gate: SharedArrayBuffer; fence: SharedArrayBuffer;
  env?: { CODEX_HOME?: string; OPENCODEX_HOME?: string };
};
const planId = "a".repeat(32);
const roots: string[] = [];
let jobSequence = 0;
const workers: OwnedWorker[] = [];
function snapshot(configDir: string): NonNullable<Snapshot> {
  return {
    codexCliPath: join(configDir, "selected", "codex.cmd"),
    path: "", pathExt: ".EXE;.CMD", home: configDir, nodePath: null,
    managerRoots: {}, transportEnv: {}, arch: process.arch, configDir,
  };
}
function home() {
  const root = createCodexCliTestRoot("ocx-update-worker-");
  roots.push(root);
  return root;
}
// Deadline is only a stuck-fixture watchdog, never a performance threshold:
// a cold production-worker module import on Windows legitimately takes
// seconds, so the bound is generous and only failure paths ever reach it.
// No main-thread Atomics.wait: it would invalidate the responsiveness test.
async function until(check: () => boolean, label: string): Promise<void> {
  const deadline = performance.now() + 15_000;
  while (!check()) {
    if (performance.now() >= deadline) throw new Error("fixture did not reach " + label);
    await new Promise<void>(resolve => setTimeout(resolve, 0));
  }
}
interface OwnedWorker {
  worker: Worker;
  control: Int32Array;
  runMessages: RunMessage[];
  messages: unknown[];
  terminateCalls: number;
  closed: boolean;
  errors: string[];
  finished: Promise<void>;
  detach(): void;
  release(): void;
}
function ownWorker(url: URL, config?: Omit<FixtureConfiguration, "type" | "control">): OwnedWorker {
  const worker = new Worker(url, { type: "module" });
  const control = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * FIXTURE_CONTROL_WORDS));
  let complete!: () => void;
  const finished = new Promise<void>(resolve => { complete = resolve; });
  const owner: OwnedWorker = {
    worker, control, runMessages: [], messages: [], terminateCalls: 0,
    closed: false, errors: [], finished,
    release() { Atomics.store(control, FIXTURE_RELEASE, 1); Atomics.notify(control, FIXTURE_RELEASE); },
    detach() {
      worker.removeEventListener("message", onMessage);
      worker.removeEventListener("error", onError);
      worker.removeEventListener("close", onClose);
    },
  };
  const onMessage = (event: MessageEvent) => { owner.messages.push(event.data); };
  const onError = (event: ErrorEvent) => {
    owner.errors.push(event.message);
    event.preventDefault(); // host's own listener still observes the same error
  };
  const onClose = () => { owner.closed = true; complete(); };
  worker.addEventListener("message", onMessage);
  worker.addEventListener("error", onError);
  worker.addEventListener("close", onClose);
  const post = worker.postMessage.bind(worker);
  Object.defineProperty(worker, "postMessage", {
    configurable: true,
    value: (...args: Parameters<Worker["postMessage"]>) => {
      const message = args[0] as Partial<RunMessage> | undefined;
      if (message?.type === "run") owner.runMessages.push(message as RunMessage);
      return Reflect.apply(post, worker, args);
    },
  });
  const terminate = worker.terminate.bind(worker);
  Object.defineProperty(worker, "terminate", {
    configurable: true,
    value: (...args: Parameters<Worker["terminate"]>) => {
      owner.terminateCalls++;
      return Reflect.apply(terminate, worker, args);
    },
  });
  workers.push(owner);
  if (config) post({ type: "fixture-config", control: control.buffer, ...config });
  return owner;
}
function fixture(config: Omit<FixtureConfiguration, "type" | "control"> = {}) {
  const owner = ownWorker(new URL("../helpers/cli-update-fixture-worker.ts", import.meta.url), config);
  const configDir = home(), jobId = "fixture-job-" + (++jobSequence);
  const options = {
    jobId, snapshot: snapshot(configDir),
    env: { CODEX_HOME: join(configDir, "codex"), OPENCODEX_HOME: configDir },
    spawnWorkerFn: (_url: string, _key: string) => owner.worker,
  };
  return { owner, options, jobId, configDir };
}
async function joined(owner: OwnedWorker) {
  await until(() => owner.closed, "worker close");
  await owner.finished;
  expect(owner.terminateCalls).toBe(0);
  expect(owner.runMessages).toHaveLength(1);
}
afterEach(async () => {
  // Release every exact fixture even if an assertion failed. Never terminate a
  // dispatched worker whose done result might conceal an owned native child.
  // A failed close wait must not lose the remaining owners: every worker gets
  // its release+join attempt, and one that still will not close is re-queued
  // so a later afterEach still owns it instead of leaking it untracked.
  const owned = workers.splice(0);
  const abandoned: OwnedWorker[] = [];
  let firstError: unknown;
  for (const owner of owned) {
    try {
      owner.release();
      if (!owner.closed) {
        // A fixture before its RunMsg may be idle; FIFO close is harmless after run.
        try { owner.worker.postMessage({ type: "fixture-close" }); }
        catch { /* A concurrently closing worker still must emit the close observed below. */ }
      }
      await until(() => owner.closed, "owned worker close during cleanup");
      await owner.finished;
      expect(owner.terminateCalls).toBe(0);
    } catch (error) {
      if (firstError === undefined) firstError = error;
      if (!owner.closed) abandoned.push(owner);
    } finally {
      owner.detach();
    }
  }
  workers.push(...abandoned);
  // Do not erase gate state or remove homes until every owned worker has closed.
  resetCodexCliSelectionGatesForTests();
  for (const root of roots.splice(0)) await removeTreeAfterBackgroundWork(root);
  if (firstError !== undefined) throw firstError;
});
describe("process-wide selection commit gate and cancellation fence", () => {
  test("only the dead pre-spawn owner's generation can recover installation admission", async () => {
    const root = createCodexCliTestRoot("ocx-generation-close-"), configDir = join(root, "config");
    roots.push(root); mkdirSync(configDir, { mode: 0o700 });
    if (process.platform === "win32") {
      await hardenSecretDirAsync(root, { required: true });
      await hardenSecretDirAsync(configDir, { required: true }); trustWindowsTempFixtureAncestry(root);
    }
    const gate = codexCliUpdateSelectionGate(), fence = createCodexCliUpdateFence();
    const generation = allocateCodexCliUpdateGateOwner(gate);
    const old = createWorkerCommitWindow({ gate, fence, owner: generation });
    expect(old.tryEnter()).toBe(true);
    recoverClosedCodexCliUpdateWorker(gate, createCodexCliUpdateFence(), generation + 1, crypto.randomUUID(), configDir);
    expect(Atomics.load(new Int32Array(gate), 0)).toBe(generation);
    recoverClosedCodexCliUpdateWorker(gate, fence, generation, crypto.randomUUID(), configDir);
    expect(old.commit()).toBe(false);
    const nextFence = createCodexCliUpdateFence();
    const next = createWorkerCommitWindow({ gate, fence: nextFence });
    expect(next.tryEnter()).toBe(true);
    old.exit(); // A stale worker cannot release the new installation owner.
    expect(beginCodexCliSelectionParentWrite().entered).toBe(false);
    expect(next.commit()).toBe(true);
    recoverClosedCodexCliUpdateWorker(gate, nextFence, Atomics.load(new Int32Array(gate), 0), crypto.randomUUID(), configDir);
    expect(beginCodexCliSelectionParentWrite().entered).toBe(false);
    next.exit(); // Native terminal + readback path owns release after COMMITTED.
    const writer = beginCodexCliSelectionParentWrite();
    expect(writer.entered).toBe(true); writer.exit();
  });
  test("a rejected authority acquisition roots failed pins before any returned authority exists", () => {
    const pins = new WindowsApplyAuthorityPins();
    let fault = true, closes = 0, detached = 0;
    const kernel = { symbols: { CloseHandle: () => { closes++; return fault ? 0 : 1; } } } as unknown as Parameters<WindowsApplyAuthorityPins["release"]>[1];
    const lifetime = createCodexCliWorkerLifetime(() => { detached++; });
    const anchor: { acquisition?: WindowsApplyAcquisition } = {};
    const token = lifetime.retain(anchor);
    // Model the actual callback order: ctx publication -> pin creation -> failure -> finally.
    anchor.acquisition = new WindowsApplyAcquisition({ fixtureContext: true }, pins);
    const exactPin = pins.keep(456n);
    try { throw new Error("fixture acquisition rejected"); }
    catch { pins.closeAll(kernel); }
    expect(anchor.acquisition.releaseIfClean(token)).toBe(false);
    lifetime.finish();
    expect(detached).toBe(0);
    expect(pins.remaining).toBe(1); expect(closes).toBe(1);
    pins.closeAll(kernel); expect(closes).toBe(1);
    // Only explicit fixture recovery retries the exact fake handle; not an automatic policy.
    fault = false;
    expect(pins.release(exactPin, kernel)).toBe(true);
    expect(anchor.acquisition.releaseIfClean(token)).toBe(true);
    expect(detached).toBe(1);
    const cleanAnchor = new WindowsApplyAcquisition({}, new WindowsApplyAuthorityPins());
    let released = 0;
    expect(cleanAnchor.releaseIfClean({ release() { released++; } })).toBe(true);
    expect(released).toBe(1);
  });
  test("a failed pin close keeps its lifetime token without an automatic close retry", () => {
    const pins = new WindowsApplyAuthorityPins(), handle = pins.keep(123n);
    let attempts = 0, fault = true, detached = 0;
    const kernel = { symbols: { CloseHandle: () => { attempts++; return fault ? 0 : 1; } } } as unknown as Parameters<WindowsApplyAuthorityPins["release"]>[1];
    const lifetime = createCodexCliWorkerLifetime(() => { detached++; });
    const token = lifetime.retain(pins);
    expect(pins.release(handle, kernel)).toBe(false);
    pins.closeAll(kernel);
    expect(attempts).toBe(1);
    expect(pins.remaining).toBe(1);
    lifetime.finish();
    expect(detached).toBe(0);
    // Explicit fixture-only recovery of the same recorded handle, not production retry.
    fault = false;
    expect(pins.release(handle, kernel)).toBe(true);
    expect(pins.remaining).toBe(0);
    token.release();
    expect(detached).toBe(1);
    expect(pins.release(handle, kernel)).toBe(true);
    expect(attempts).toBe(2); // Already released never closes a potentially reused handle.
  });
  test("execution retention roots survive completion until every exact owner releases", () => {
    let detached = 0;
    const lifetime = createCodexCliWorkerLifetime(() => { detached++; });
    const first = lifetime.retain({ native: "authority-acquisition-anchor" });
    const second = lifetime.retain({ native: "unresolved-overlapped-owner" });
    first.release();
    expect(detached).toBe(0);
    lifetime.finish();
    expect(detached).toBe(0);
    first.release();
    expect(detached).toBe(0);
    second.release(); lifetime.finish(); second.release();
    expect(detached).toBe(1);
  });
  test("parent write is nonblocking busy; release restores admission", async () => {
    const first = beginCodexCliSelectionParentWrite();
    expect(first.entered).toBe(true);
    try {
      const second = beginCodexCliSelectionParentWrite();
      try { expect(second.entered).toBe(false); } finally { second.exit(); }
      const fence = createCodexCliUpdateFence();
      const window = createWorkerCommitWindow({
        gate: codexCliUpdateSelectionGate(), fence, deadlineMs: 0,
      });
      try {
        expect(window.tryEnter()).toBe(false);
        expect(await window.waitEnter()).toBe(false);
      } finally { window.exit(); }
    } finally { first.exit(); }
    const next = beginCodexCliSelectionParentWrite();
    try { expect(next.entered).toBe(true); } finally { next.exit(); }
  });
  test("worker waitEnter wins the gate once the parent writer releases", async () => {
    const writer = beginCodexCliSelectionParentWrite();
    expect(writer.entered).toBe(true);
    const fence = createCodexCliUpdateFence();
    const window = createWorkerCommitWindow({
      gate: codexCliUpdateSelectionGate(), fence,
      // The sleep seam releases the parent write mid-wait deterministically.
      sleep: async () => { writer.exit(); },
    });
    try {
      expect(await window.waitEnter()).toBe(true);
      const blocked = beginCodexCliSelectionParentWrite();
      try { expect(blocked.entered).toBe(false); } finally { blocked.exit(); }
    } finally { window.exit(); writer.exit(); }
  });
  test("all callers share one gate, including aliased and different directory snapshots", () => {
    const root = home();
    const selections = [snapshot(root), snapshot(join(root, ".")), snapshot(join(root, "other"))];
    const gate = codexCliUpdateSelectionGate();
    const window = createWorkerCommitWindow({ gate, fence: createCodexCliUpdateFence() });
    expect(window.tryEnter()).toBe(true);
    try {
      for (const selected of selections) {
        // Gate intentionally takes no configDir: aliases cannot form a second lock.
        expect(selected.configDir).toBeDefined();
        expect(codexCliUpdateSelectionGate()).toBe(gate);
        const writer = beginCodexCliSelectionParentWrite();
        try { expect(writer.entered).toBe(false); } finally { writer.exit(); }
      }
    } finally { window.exit(); }
    // This tests shared gate behavior, not filesystem alias resolution or callers.
  });
  test("cancel CAS wins before commit and cannot be overwritten", () => {
    const fence = createCodexCliUpdateFence(), cancelled = codexCliUpdateIsCancelled(fence);
    const window = createWorkerCommitWindow({ gate: codexCliUpdateSelectionGate(), fence });
    expect(window.tryEnter()).toBe(true);
    try {
      expect(cancelled()).toBe(false);
      expect(cancelCodexCliUpdateFence(fence)).toBe(true);
      expect(cancelCodexCliUpdateFence(fence)).toBe(false);
      expect(window.commit()).toBe(false);
      expect(cancelled()).toBe(true);
    } finally { window.exit(); }
  });
  test("committed CAS wins; later cancellation is deferred, not reported aborted", () => {
    const fence = createCodexCliUpdateFence(), cancelled = codexCliUpdateIsCancelled(fence);
    const window = createWorkerCommitWindow({ gate: codexCliUpdateSelectionGate(), fence });
    expect(window.tryEnter()).toBe(true);
    try {
      expect(window.commit()).toBe(true);
      expect(cancelCodexCliUpdateFence(fence)).toBe(false);
      expect(cancelled()).toBe(false);
      const writer = beginCodexCliSelectionParentWrite();
      try { expect(writer.entered).toBe(false); } finally { writer.exit(); }
    } finally { window.exit(); }
    const writer = beginCodexCliSelectionParentWrite();
    try { expect(writer.entered).toBe(true); } finally { writer.exit(); }
  });
});
describe("actual Worker dispatch and parent responsiveness", () => {
  test("fresh main-thread entry and fixture imports preserve the message sentinel", async () => {
    const urls = ["../../src/codex/cli-update-worker.ts", "../helpers/cli-update-fixture-worker.ts"]
      .map(path => new URL(path, import.meta.url).href);
    // A new main process has imported neither module before installing the sentinel;
    // no query-string cache assumption or extra production export is needed.
    const program = 'if(Bun.isMainThread!==true)throw new Error("not main");'
      + 'const sentinel=()=>{};globalThis.onmessage=sentinel;let imports=0;'
      + `try{for(const url of ${JSON.stringify(urls)}){await import(url);imports++;`
      + 'if(globalThis.onmessage!==sentinel)throw new Error("main handler replaced");}'
      + 'console.log(JSON.stringify({main:Bun.isMainThread,imports,sentinelPreserved:globalThis.onmessage===sentinel}));'
      + '}finally{globalThis.onmessage=null;}';
    const result = await spawnTestChild([process.execPath, "--no-env-file", "--no-install", "-e", program],
      { cwd: repoRoot(), env: process.env, deadlineMs: 2_500 });
    expect(result.timedOut, `${result.stdout}\n${result.stderr}`).toBe(false);
    expect(result.reaped && result.pipesClosed).toBe(true);
    expect(result.exitCode, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ main: true, imports: 2, sentinelPreserved: true });
  });
  test("detached message handler keeps a real Bun child alive until observed exit", async () => {
    const releasePath = join(home(), "release-child");
    const f = fixture({ reply: "ambiguous", childDrain: { releasePath } });
    const initial = codexCliUpdateUnjoinedWorkerCount();
    const operation = runCodexCliUpdateApplyInWorker(planId, { ...f.options, closeGraceMs: 10 });
    try {
      expect(await operation).toMatchObject({ outcome: "ambiguous", reason: "job_result_unknown", leaseRetained: true });
      const started = f.owner.messages.find(m => (m as { type?: string }).type === "fixture-child-started") as { pid: number };
      expect(started?.pid).toBeGreaterThan(0);
      expect(f.owner.closed).toBe(false);
      expect(f.owner.terminateCalls).toBe(0);
      expect(codexCliUpdateUnjoinedWorkerCount()).toBe(initial + 1);
      expect(f.owner.messages.some(m => (m as { type?: string }).type === "fixture-child-exited")).toBe(false);
    } finally { writeFileSync(releasePath, "release"); }
    await joined(f.owner);
    expect(f.owner.messages).toContainEqual(expect.objectContaining({ type: "fixture-child-exited", exitCode: 0 }));
    await until(() => codexCliUpdateUnjoinedWorkerCount() === initial, "real child owner drained");
  });
  test("parent HTTP health and stream advance while the Worker is synchronously blocked", async () => {
    const f = fixture({ block: "before-reply" });
    let push!: (bytes: Uint8Array) => void;
    let finishStream!: () => void;
    const encoder = new TextEncoder();
    const server = Bun.serve({
      hostname: "127.0.0.1", port: 0,
      fetch(request) {
        if (new URL(request.url).pathname === "/health") return new Response("healthy");
        return new Response(new ReadableStream<Uint8Array>({
          start(controller) {
            push = bytes => controller.enqueue(bytes);
            finishStream = () => controller.close();
            controller.enqueue(encoder.encode("first"));
          },
        }));
      },
    });
    const operation = runCodexCliUpdateApplyInWorker(planId, f.options);
    // Install a rejection consumer immediately; finally still joins the same run.
    void operation.catch(() => {});
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    const write = beginCodexCliSelectionParentWrite();
    expect(write.entered).toBe(true);
    try {
      await until(() => Atomics.load(f.owner.control, FIXTURE_ENTERED) === 1, "sync worker barrier");
      expect(Atomics.load(f.owner.control, FIXTURE_RELEASE)).toBe(0);
      expect(await (await fetch(new URL("/health", server.url))).text()).toBe("healthy");
      reader = (await fetch(new URL("/stream", server.url))).body!.getReader();
      expect(new TextDecoder().decode((await reader.read()).value)).toBe("first");
      push(encoder.encode("second"));
      expect(new TextDecoder().decode((await reader.read()).value)).toBe("second");
      expect(Atomics.load(f.owner.control, FIXTURE_FINISHED)).toBe(0);
      // General parent HTTP/stream work continues even with the selection gate busy.
      finishStream();
      expect((await reader.read()).done).toBe(true);
    } finally {
      write.exit();
      await reader?.cancel();
      server.stop(true);
      f.owner.release();
    }
    expect(await operation).toMatchObject({ outcome: "refused", reason: "preparation_failed" });
    await joined(f.owner);
  });
  test("done is not sufficient: result stays pending until Worker close", async () => {
    const f = fixture({ block: "after-reply" });
    let settled = false;
    const operation = runCodexCliUpdateApplyInWorker(planId, { ...f.options, closeGraceMs: 1_000 });
    void operation.then(() => { settled = true; }, () => { settled = true; });
    try {
      await until(() => f.owner.messages.some(m => (m as { type?: string }).type === "done"), "done message");
      await Promise.resolve();
      expect(settled).toBe(false);
      expect(f.owner.closed).toBe(false);
    } finally { f.owner.release(); }
    expect(await operation).toMatchObject({ outcome: "refused", reason: "preparation_failed" });
    await joined(f.owner);
  });
  test("unknown-child done without close becomes ambiguous and NEVER terminates worker", async () => {
    const f = fixture({ reply: "ambiguous", block: "after-reply" });
    const initial = codexCliUpdateUnjoinedWorkerCount();
    const initialClosed = codexCliUpdateUnjoinedWorkerClosedTotal();
    const operation = runCodexCliUpdateApplyInWorker(planId, { ...f.options, closeGraceMs: 10 });
    try {
      const result = await operation;
      expect(result).toMatchObject({
        outcome: "ambiguous", reason: "job_result_unknown", leaseRetained: true,
      });
      expect(f.owner.closed).toBe(false);
      expect(f.owner.messages).toContainEqual(expect.objectContaining({
        type: "done", result: expect.objectContaining({
          reason: "installer_state_unknown", leaseRetained: true, verificationPid: 424242,
        }),
      }));
      expect(Atomics.load(f.owner.control, FIXTURE_RELEASE)).toBe(0);
      expect(f.owner.terminateCalls).toBe(0);
      expect(codexCliUpdateUnjoinedWorkerCount()).toBe(initial + 1);
      expect(f.owner.runMessages).toHaveLength(1);
      expect(cancelCodexCliUpdateWorkerJob(f.jobId)).toBe(false);
      // The settled job is off the live ledger but its Worker is still tracked.
      const diagnostics = codexCliUpdateWorkerDiagnostics();
      expect(diagnostics.gate).toBe("free");
      expect(diagnostics.liveJobs.some(job => job.jobId === f.jobId)).toBe(false);
      expect(diagnostics.unjoinedWorkers).toBe(initial + 1);
    } finally { f.owner.release(); }
    await joined(f.owner);
    await until(() => codexCliUpdateUnjoinedWorkerCount() === initial, "unjoined set removal on actual close");
    // Removed from the live set but kept as evidence: closed-after-unknown total.
    await until(() => codexCliUpdateUnjoinedWorkerClosedTotal() === initialClosed + 1,
      "closed-after-unknown diagnostic");
  });
  test("real AbortSignal listener and job cancellation reach the same preparing fence", async () => {
    const f = fixture({ block: "before-reply" });
    const controller = new AbortController();
    let abortEvents = 0;
    const onAbort = () => { abortEvents++; };
    controller.signal.addEventListener("abort", onAbort, { once: true });
    const operation = runCodexCliUpdateApplyInWorker(planId, { ...f.options, signal: controller.signal });
    void operation.catch(() => {});
    try {
      await until(() => Atomics.load(f.owner.control, FIXTURE_ENTERED) === 1, "cancellable worker");
      const run = f.owner.runMessages[0]!;
      expect(controller.signal).toBeInstanceOf(AbortSignal);
      controller.abort();
      expect(abortEvents).toBe(1);
      expect(codexCliUpdateIsCancelled(run.fence)()).toBe(true);
      expect(cancelCodexCliUpdateWorkerJob(f.jobId)).toBe(false);
      const window = createWorkerCommitWindow({ gate: run.gate, fence: run.fence });
      try { expect(window.commit()).toBe(false); } finally { window.exit(); }
    } finally {
      controller.signal.removeEventListener("abort", onAbort);
      f.owner.release();
    }
    await operation;
    await joined(f.owner);
  });
  test("AbortSignal remains a real native-fetch signal, separate from synchronous SAB cancellation", async () => {
    const fence = createCodexCliUpdateFence(), controller = new AbortController();
    const deps: Pick<CodexCliApplyDeps, "signal" | "isCancelled"> = {
      signal: controller.signal, isCancelled: codexCliUpdateIsCancelled(fence),
    };
    let requestSeen = false;
    const server = Bun.serve({
      hostname: "127.0.0.1", port: 0,
      fetch() { requestSeen = true; return new Promise<Response>(() => {}); },
    });
    const request = fetch(server.url, { signal: deps.signal });
    // Consume rejection immediately; abort is intentionally issued after request admission.
    const outcome = request.then(() => ({ rejected: false }), error => ({ rejected: true, error }));
    try {
      await until(() => requestSeen, "native fetch admission");
      expect(deps.signal).toBeInstanceOf(AbortSignal);
      expect(cancelCodexCliUpdateFence(fence)).toBe(true);
      expect(deps.isCancelled!()).toBe(true);
      expect(deps.signal!.aborted).toBe(false); // SAB hook did not widen/replace the signal.
      controller.abort();
      expect((await outcome).rejected).toBe(true);
      expect(deps.signal!.aborted).toBe(true);
    } finally { controller.abort(); server.stop(true); await outcome; }
  });
});
describe("reply correlation, loss and run-once ownership", () => {
  for (const correlation of ["stale-first", "duplicate"] as const) {
    test(correlation + " cannot replace the first matching reply or replay apply", async () => {
      const f = fixture({ correlation });
      expect(await runCodexCliUpdateApplyInWorker(planId, f.options)).toMatchObject({
        outcome: "refused", reason: "preparation_failed", leaseRetained: false,
      });
      await joined(f.owner);
      expect(Atomics.load(f.owner.control, FIXTURE_RUNS)).toBe(1);
    });
  }
  for (const mode of ["none", "die", "throw", "malformed", "error"] as const) {
    test(mode + " after run delivery is ambiguous, never a safe preparation refusal", async () => {
      const f = fixture({ reply: mode });
      expect(await runCodexCliUpdateApplyInWorker(planId, f.options)).toMatchObject({
        outcome: "ambiguous", reason: "job_result_unknown", leaseRetained: true,
      });
      await joined(f.owner);
      expect(Atomics.load(f.owner.control, FIXTURE_RUNS)).toBe(1);
    });
  }
  for (const staleField of ["requestId", "jobId", "both"] as const) {
  test("wrong " + staleField + " followed by close does not qualify as done", async () => {
    const f = fixture({ correlation: "stale-only", staleField });
    expect(await runCodexCliUpdateApplyInWorker(planId, f.options)).toMatchObject({
      outcome: "ambiguous", reason: "job_result_unknown", leaseRetained: true,
    });
    await joined(f.owner);
  });
  }
  test("spawn failure before any run delivery is refused once", async () => {
    let attempts = 0;
    const result = await runCodexCliUpdateApplyInWorker(planId, {
      jobId: "never-started", snapshot: snapshot(home()),
      spawnWorkerFn() { attempts++; throw new Error("fixture-spawn-failed"); },
    });
    expect(result).toMatchObject({ outcome: "refused", reason: "preparation_failed", leaseRetained: false });
    expect(attempts).toBe(1);
  });
  test("postMessage throwing AFTER possible delivery must not falsely claim not started", async () => {
    const f = fixture({});
    const post = f.owner.worker.postMessage.bind(f.owner.worker);
    Object.defineProperty(f.owner.worker, "postMessage", {
      configurable: true,
      value: (...args: Parameters<Worker["postMessage"]>) => {
        Reflect.apply(post, f.owner.worker, args);
        if ((args[0] as { type?: string }).type === "run") throw new Error("after-delivery-fixture-error");
      },
    });
    expect(await runCodexCliUpdateApplyInWorker(planId, f.options)).toMatchObject({
      outcome: "ambiguous", reason: "job_result_unknown", leaseRetained: true,
    });
    await joined(f.owner);
  });
  test("plan loss rejects plan_unavailable without a retry", async () => {
    const f = fixture({ reply: "none" });
    await expect(runCodexCliUpdatePlanInWorker(f.options)).rejects.toThrow("plan_unavailable");
    await joined(f.owner);
  });
  test("production entry ignores duplicate/late RunMsg and emits one correlated reply", async () => {
    const owner = ownWorker(new URL("../../src/codex/cli-update-worker.ts", import.meta.url));
    const run: RunMessage = {
      type: "run", operation: "plan", requestId: "run-once-request", jobId: "run-once-job",
      snapshot: null, gate: codexCliUpdateSelectionGate(), fence: createCodexCliUpdateFence(),
      env: { CODEX_HOME: home(), OPENCODEX_HOME: home() },
    };
    // Null trusted snapshot fails closed and must never query a real provider.
    owner.worker.postMessage(run);
    owner.worker.postMessage({ ...run, requestId: "late-request", jobId: "late-job" });
    await until(() => owner.closed, "production worker close");
    const replies = owner.messages.filter(m => ["done", "error"].includes((m as { type: string }).type));
    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatchObject({ requestId: run.requestId, jobId: run.jobId });
    expect(owner.terminateCalls).toBe(0);
    // Two input messages are intentional here. No host retry/install replay occurred.
  });
});
describe("snapshot target does not fall back to ambient homes", () => {
  test("explicit snapshot and worker-home override remain distinct", async () => {
    const f = fixture({}), ambient = home();
    const original = process.env.OPENCODEX_HOME;
    process.env.OPENCODEX_HOME = ambient;
    try {
      const captured = f.options.snapshot;
      expect(await runCodexCliUpdateApplyInWorker(planId, {
        ...f.options, env: { OPENCODEX_HOME: ambient, CODEX_HOME: ambient },
      })).toMatchObject({ outcome: "refused" });
      await joined(f.owner);
      expect(f.owner.runMessages[0]!.snapshot).toEqual(captured);
      expect(f.owner.runMessages[0]!.snapshot!.configDir).toBe(f.configDir);
      expect(f.owner.runMessages[0]!.env).toEqual({ OPENCODEX_HOME: ambient, CODEX_HOME: ambient });
      const deps = codexCliUpdateInspectionDepsFromSnapshot(captured);
      expect(deps.configDir).toBe(f.configDir);
      expect(deps.env?.CODEX_CLI_PATH).toBe(captured.codexCliPath!);
      expect(deps.env?.HOME).toBe(captured.home!);
    } finally {
      if (original === undefined) delete process.env.OPENCODEX_HOME;
      else process.env.OPENCODEX_HOME = original;
    }
  });
  test("null or missing manager-root proof fails closed without ambient backfill", () => {
    const original = process.env.OPENCODEX_HOME;
    process.env.OPENCODEX_HOME = home();
    try {
      for (const captured of [null, { ...snapshot(home()), managerRoots: null }]) {
        const deps = codexCliUpdateInspectionDepsFromSnapshot(captured);
        expect(deps.env?.PATH).toBe("");
        expect(deps.configDir).toBe(".");
        expect(deps.env?.CODEX_CLI_PATH).toBeUndefined();
      }
    } finally {
      if (original === undefined) delete process.env.OPENCODEX_HOME;
      else process.env.OPENCODEX_HOME = original;
    }
  });
});
