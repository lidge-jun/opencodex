import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  agentTaskRecoveryCacheSnapshotForTests,
  agentTaskRecoveryWaiterCountForTests,
  cachedAgentTaskRecovery,
  resetAgentTaskRecoveryCache,
  resolveCachedAgentTaskRecovery,
} from "../../src/server/responses/agent-task-recovery-cache";
import {
  recoverEncryptedAgentTaskWithResult,
  restoreCachedEncryptedAgentTasks,
} from "../../src/server/responses/agent-task-recovery";
import {
  codexHeaders,
  encryptedInput,
  originalFetch,
  recoverySse,
  routedConfig,
} from "../helpers/agent-task-recovery";

const realDateNow = Date.now;

describe("agent task recovery cache", () => {
  beforeEach(() => resetAgentTaskRecoveryCache());

  afterEach(() => {
    globalThis.fetch = originalFetch;
    Date.now = realDateNow;
    resetAgentTaskRecoveryCache();
  });

  test("shared failure gives each waiter its own result without contaminating another key", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let fetches = 0;
    globalThis.fetch = (async () => {
      const requestNumber = ++fetches;
      await gate;
      return requestNumber === 1
        ? new Response("raw-failure-sentinel", { status: 503 })
        : new Response(recoverySse("Independent assignment."));
    }) as typeof fetch;
    const req = new Request("http://localhost/v1/responses", { headers: codexHeaders() });
    const config = routedConfig();
    const firstInput = encryptedInput();
    const secondInput = encryptedInput();
    const otherInput = encryptedInput();
    const first = recoverEncryptedAgentTaskWithResult(req, firstInput, {}, config);
    const second = recoverEncryptedAgentTaskWithResult(req, secondInput, {}, config);
    const other = recoverEncryptedAgentTaskWithResult(req, otherInput, {}, config, { parentThreadId: "other-parent" });
    try {
      expect(agentTaskRecoveryWaiterCountForTests()).toBe(3);
      expect(fetches).toBe(2);
      release?.();
      const [firstResult, secondResult, otherResult] = await Promise.all([first, second, other]);
      expect(firstResult).toEqual({ recovered: false, reason: "recovery_unavailable" });
      expect(secondResult).toEqual({ recovered: false, reason: "recovery_unavailable" });
      expect(firstResult).not.toBe(secondResult);
      expect(otherResult).toEqual({ recovered: true });
      expect(firstInput).toEqual(encryptedInput());
      expect(secondInput).toEqual(encryptedInput());
      expect(restoreCachedEncryptedAgentTasks(req, encryptedInput(), config)).toBe(0);
      expect(restoreCachedEncryptedAgentTasks(req, encryptedInput(), config, { parentThreadId: "other-parent" })).toBe(1);
      expect(fetches).toBe(2);
    } finally {
      release?.();
      await Promise.all([first, second, other]);
    }
  });

  for (const succeeds of [true, false]) {
    test(`caller cancellation stays local when the remaining waiter ${succeeds ? "succeeds" : "fails"}`, async () => {
      let release: (() => void) | undefined;
      const gate = new Promise<void>(resolve => { release = resolve; });
      let sharedSignal: AbortSignal | null | undefined;
      let fetches = 0;
      globalThis.fetch = (async (_input, init) => {
        fetches += 1;
        sharedSignal = init?.signal;
        await gate;
        return succeeds ? new Response(recoverySse("Shared assignment.")) : new Response(null, { status: 503 });
      }) as typeof fetch;
      const req = new Request("http://localhost/v1/responses", { headers: codexHeaders() });
      const config = routedConfig();
      const controller = new AbortController();
      const cancelledInput = encryptedInput();
      const first = recoverEncryptedAgentTaskWithResult(req, cancelledInput, {}, config, { abortSignal: controller.signal });
      const second = recoverEncryptedAgentTaskWithResult(req, encryptedInput(), {}, config);
      try {
        expect(agentTaskRecoveryWaiterCountForTests()).toBe(2);
        controller.abort(new Error("private-cancellation-sentinel"));
        expect(await first).toEqual({ recovered: false, reason: "caller_cancelled" });
        expect(cancelledInput).toEqual(encryptedInput());
        expect(sharedSignal?.aborted).toBe(false);
        release?.();
        expect(await second).toEqual(succeeds
          ? { recovered: true }
          : { recovered: false, reason: "recovery_unavailable" });
        expect(fetches).toBe(1);
        expect(restoreCachedEncryptedAgentTasks(req, encryptedInput(), config)).toBe(succeeds ? 1 : 0);
      } finally {
        release?.();
        await Promise.all([first, second]);
      }
    });
  }

  test("already cancelled callers cannot inject a positive cache hit", async () => {
    const req = new Request("http://localhost/v1/responses", { headers: codexHeaders() });
    const config = routedConfig();
    let fetches = 0;
    globalThis.fetch = (async () => { fetches += 1; return new Response(recoverySse("Cached assignment.")); }) as typeof fetch;
    expect(await recoverEncryptedAgentTaskWithResult(req, encryptedInput(), {}, config)).toEqual({ recovered: true });
    const controller = new AbortController();
    controller.abort();
    const input = encryptedInput();
    expect(await recoverEncryptedAgentTaskWithResult(req, input, {}, config, { abortSignal: controller.signal }))
      .toEqual({ recovered: false, reason: "caller_cancelled" });
    expect(input).toEqual(encryptedInput());
    // The existing pre-abort/null path does not discard another caller's cache entry.
    expect(restoreCachedEncryptedAgentTasks(req, encryptedInput(), config)).toBe(1);
    expect(fetches).toBe(1);
  });

  test("cancellation after cache lookup retains the existing discard behavior", async () => {
    const req = new Request("http://localhost/v1/responses", { headers: codexHeaders() });
    const config = routedConfig();
    globalThis.fetch = (async () => new Response(recoverySse("Cached assignment."))) as typeof fetch;
    expect(await recoverEncryptedAgentTaskWithResult(req, encryptedInput(), {}, config)).toEqual({ recovered: true });
    const controller = new AbortController();
    const input = encryptedInput();
    const pending = recoverEncryptedAgentTaskWithResult(req, input, {}, config, { abortSignal: controller.signal });
    // The cache lookup returned an assignment, but the caller has not resumed to inject it.
    controller.abort();
    expect(await pending).toEqual({ recovered: false, reason: "caller_cancelled" });
    expect(input).toEqual(encryptedInput());
    expect(agentTaskRecoveryCacheSnapshotForTests()).toEqual({ entries: 0, bytes: 0 });
  });

  test("input replacement after admission reports input_changed and discards recovered plaintext", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>(resolve => { release = resolve; });
    globalThis.fetch = (async () => { await gate; return new Response(recoverySse("Do not inject.")); }) as typeof fetch;
    const req = new Request("http://localhost/v1/responses", { headers: codexHeaders() });
    const config = routedConfig();
    const input = encryptedInput();
    const pending = recoverEncryptedAgentTaskWithResult(req, input, {}, config);
    try {
      input[0] = { type: "message", role: "user", content: [] };
      const replaced = structuredClone(input);
      release?.();
      expect(await pending).toEqual({ recovered: false, reason: "input_changed" });
      expect(input).toEqual(replaced);
      expect(agentTaskRecoveryCacheSnapshotForTests()).toEqual({ entries: 0, bytes: 0 });
      expect(restoreCachedEncryptedAgentTasks(req, encryptedInput(), config)).toBe(0);
    } finally {
      release?.();
      await pending;
    }
  });

  test("recovery_unavailable does not imply a fetch when all flight slots are occupied", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const pending = Array.from({ length: 32 }, (_, index) => resolveCachedAgentTaskRecovery(
      `occupied-${index}`, 200, async () => { await gate; return null; },
    ));
    let fetches = 0;
    globalThis.fetch = (async () => { fetches += 1; throw new Error("must-not-fetch"); }) as typeof fetch;
    try {
      const req = new Request("http://localhost/v1/responses", { headers: codexHeaders() });
      const input = encryptedInput();
      expect(await recoverEncryptedAgentTaskWithResult(req, input, {}, routedConfig()))
        .toEqual({ recovered: false, reason: "recovery_unavailable" });
      expect(fetches).toBe(0);
      expect(input).toEqual(encryptedInput());
      expect(agentTaskRecoveryCacheSnapshotForTests()).toEqual({ entries: 0, bytes: 0 });
    } finally {
      release?.();
      await Promise.all(pending);
    }
  });

  test("read-only hits retain the original expiry and exact-expiry reads release UTF-8 bytes", async () => {
    const insertedAt = 1_800_000_000_000;
    let now = insertedAt;
    Date.now = () => now;
    let requests = 0;
    expect(cachedAgentTaskRecovery("missing")).toBeNull();
    expect(agentTaskRecoveryCacheSnapshotForTests()).toEqual({ entries: 0, bytes: 0 });
    expect(await resolveCachedAgentTaskRecovery("task", 200, async () => {
      requests++;
      return "한😀"; // Three UTF-8 bytes plus four, rather than three UTF-16 code units.
    })).toBe("한😀");

    for (const elapsed of [0, 60_000, 15 * 60 * 1000 - 1]) {
      now = insertedAt + elapsed;
      expect(cachedAgentTaskRecovery("task")).toBe("한😀");
      expect(agentTaskRecoveryCacheSnapshotForTests()).toEqual({ entries: 1, bytes: 7 });
    }
    now = insertedAt + 15 * 60 * 1000;
    expect(cachedAgentTaskRecovery("task")).toBeNull();
    expect(agentTaskRecoveryCacheSnapshotForTests()).toEqual({ entries: 0, bytes: 0 });
    expect(cachedAgentTaskRecovery("task")).toBeNull();
    expect(requests).toBe(1);

    // Repeated expiry reads must not subtract bytes belonging to a later entry.
    await resolveCachedAgentTaskRecovery("later", 200, async () => "ok");
    expect(cachedAgentTaskRecovery("task")).toBeNull();
    expect(cachedAgentTaskRecovery("later")).toBe("ok");
    expect(agentTaskRecoveryCacheSnapshotForTests()).toEqual({ entries: 1, bytes: 2 });
  });

  test("read-only misses do not join or restart an in-flight recovery", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let requests = 0;
    const pending = resolveCachedAgentTaskRecovery("pending", 200, async () => {
      requests++;
      await gate;
      return "recovered";
    });
    try {
      expect(cachedAgentTaskRecovery("pending")).toBeNull();
      expect(cachedAgentTaskRecovery("unknown")).toBeNull();
      expect(cachedAgentTaskRecovery("pending")).toBeNull();
      expect(agentTaskRecoveryWaiterCountForTests()).toBe(1);
      expect(agentTaskRecoveryCacheSnapshotForTests()).toEqual({ entries: 0, bytes: 0 });
      expect(requests).toBe(1);
    } finally {
      release?.();
      await pending;
    }
    expect(cachedAgentTaskRecovery("pending")).toBe("recovered");
    expect(agentTaskRecoveryWaiterCountForTests()).toBe(0);
    expect(requests).toBe(1);
  });

  test("expires recovered plaintext after fifteen minutes", async () => {
    let now = 1_800_000_000_000;
    Date.now = () => now;
    let requests = 0;
    const recover = async (): Promise<string> => `assignment-${++requests}`;

    expect(await resolveCachedAgentTaskRecovery("task", 200, recover)).toBe("assignment-1");
    expect(await resolveCachedAgentTaskRecovery("task", 200, recover)).toBe("assignment-1");
    now += 15 * 60 * 1000 + 1;
    expect(await resolveCachedAgentTaskRecovery("task", 200, recover)).toBe("assignment-2");
    expect(requests).toBe(2);
  });

  test("keeps a shared request alive while one authenticated waiter remains", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    let sharedSignal: AbortSignal | undefined;
    let requests = 0;
    const recover = async (signal: AbortSignal): Promise<string> => {
      requests += 1;
      sharedSignal = signal;
      await gate;
      return "shared-assignment";
    };
    const firstController = new AbortController();
    const first = resolveCachedAgentTaskRecovery("shared", 200, recover, firstController.signal);
    const second = resolveCachedAgentTaskRecovery("shared", 200, recover);

    firstController.abort();
    expect(await first).toBeNull();
    expect(sharedSignal?.aborted).toBe(false);
    release?.();
    expect(await second).toBe("shared-assignment");
    expect(requests).toBe(1);
  });

  test("fails a thirty-third distinct recovery closed without starting it", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    let requests = 0;
    const pending = Array.from({ length: 32 }, (_, index) => (
      resolveCachedAgentTaskRecovery(`task-${index}`, 200, async () => {
        requests += 1;
        await gate;
        return `assignment-${index}`;
      })
    ));

    const overflow = await resolveCachedAgentTaskRecovery("task-overflow", 200, async () => {
      requests += 1;
      return "must-not-run";
    });
    expect(overflow).toBeNull();
    expect(requests).toBe(32);
    release?.();
    expect((await Promise.all(pending)).filter(Boolean)).toHaveLength(32);
  });

  test("evicts oldest recovered plaintext when the byte budget is exceeded", async () => {
    const assignment = "x".repeat(2 * 1024 * 1024);
    let requests = 0;
    for (let index = 0; index < 5; index += 1) {
      expect((await resolveCachedAgentTaskRecovery(`large-${index}`, 200, async () => {
        requests += 1;
        return assignment;
      }))?.length).toBe(assignment.length);
    }

    expect((await resolveCachedAgentTaskRecovery("large-0", 200, async () => {
      requests += 1;
      return assignment;
    }))?.length).toBe(assignment.length);
    expect(requests).toBe(6);
  });
});
