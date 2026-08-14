import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  resetAgentTaskRecoveryCache,
  resolveCachedAgentTaskRecovery,
} from "../src/server/responses/agent-task-recovery-cache";

const realDateNow = Date.now;

describe("agent task recovery cache", () => {
  beforeEach(() => resetAgentTaskRecoveryCache());

  afterEach(() => {
    Date.now = realDateNow;
    resetAgentTaskRecoveryCache();
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
