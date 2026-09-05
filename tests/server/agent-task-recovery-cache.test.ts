import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  agentTaskRecoveryCacheSnapshotForTests,
  agentTaskRecoveryWaiterCountForTests,
  cachedAgentTaskRecovery,
  resetAgentTaskRecoveryCache,
  resolveCachedAgentTaskRecovery,
} from "../../src/server/responses/agent-task-recovery-cache";

const realDateNow = Date.now;

describe("agent task recovery cache", () => {
  beforeEach(() => resetAgentTaskRecoveryCache());

  afterEach(() => {
    Date.now = realDateNow;
    resetAgentTaskRecoveryCache();
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
