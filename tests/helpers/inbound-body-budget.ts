import assert from "node:assert/strict";
import {
  inboundBodyBudget,
  MAX_QUEUED_INBOUND_BODIES,
} from "../../src/server/inbound-body-budget";

/** Fill admission counters and its queue without allocating request-sized bodies. */
export async function saturateInboundBodyBudget(): Promise<() => Promise<void>> {
  const capacity = inboundBodyBudget.capacity();
  const holder = await inboundBodyBudget.acquire(
    capacity, new AbortController().signal, 0,
  );
  assert.ok(holder, "fixture requires an idle shared inbound body budget");
  const controllers: AbortController[] = [];
  const waiting: Promise<unknown>[] = [];
  let restored = false;
  const restore = async (): Promise<void> => {
    if (restored) return;
    restored = true;
    try {
      for (const controller of controllers) controller.abort();
      await Promise.all(waiting);
    } finally { holder.release(); }
  };
  try {
    for (let i = 0; i < MAX_QUEUED_INBOUND_BODIES; i++) {
      const controller = new AbortController();
      controllers.push(controller);
      waiting.push(inboundBodyBudget.acquire(1, controller.signal).catch(error => error));
    }
    assert.deepEqual(inboundBodyBudget.snapshot(), {
      reservedBytes: capacity,
      activeLeases: 1,
      queuedRequests: MAX_QUEUED_INBOUND_BODIES,
    });
    return restore;
  } catch (error) {
    await restore();
    throw error;
  }
}
