import { expect, test } from "bun:test";
import { startRouteIntentTick } from "../../src/integrations/route-intent-tick";

const connection = { transport: "link", link: { linkId: "lnk_0123456789abcdef", tunnelPort: 22001 } } as never;
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

test("watch requests share periodic ownership and a request during apply receives a fresh subsequent apply", async () => {
  const timers: Array<{ run: () => void; ms: number; cancelled?: boolean }> = [];
  const complete: Array<(value: number) => void> = [];
  let calls = 0, reported = 0;
  const scheduler = startRouteIntentTick(connection, {
    sync: () => { calls++; return new Promise<number>(resolve => complete.push(resolve)); },
    onApplied: () => { reported++; },
    setTimer: (run, ms) => { const timer = { run, ms }; timers.push(timer); return timer; },
    clearTimer: timer => { (timer as { cancelled: boolean }).cancelled = true; },
  });
  const first = scheduler.requestSync();
  const second = scheduler.requestSync();
  expect(calls).toBe(1);
  expect(timers[0]?.cancelled).toBe(true);
  complete.shift()!(1); expect(await first).toBe(1); await flush();
  expect(calls).toBe(2); expect(reported).toBe(1);
  complete.shift()!(2); expect(await second).toBe(2); await flush();
  expect(reported).toBe(2);
  expect(timers.at(-1)?.ms).toBe(60_000);
  scheduler.stop();
  await expect(scheduler.requestSync()).rejects.toThrow("client_runtime_stopping");
});

test("busy applies reject the request and retry on the short cadence without overlapping", async () => {
  const timers: Array<{ run: () => void; ms: number }> = [];
  let calls = 0;
  const scheduler = startRouteIntentTick(connection, {
    sync: async () => { if (++calls === 1) throw new Error("link_apply_busy"); return "applied"; },
    setTimer: (run, ms) => { timers.push({ run, ms }); return timers.length; }, clearTimer: () => {},
  });
  await expect(scheduler.requestSync()).rejects.toThrow("link_apply_busy"); await flush();
  expect(timers.at(-1)?.ms).toBe(5_000);
  timers.at(-1)!.run(); await flush();
  expect(calls).toBe(2);
  expect(timers.at(-1)?.ms).toBe(60_000);
  scheduler.stop();
});
