import { expect, test } from "bun:test";
import { RouteIntentWatch } from "../../src/link/route-intent-watch";

test("notify wakes only the intended admitted link, and every terminal path releases its slot", async () => {
  const watch = new RouteIntentWatch(20, 2);
  const a = new AbortController(), b = new AbortController();
  const first = watch.wait("link-a", a.signal), second = watch.wait("link-b", b.signal);
  expect(watch.size).toBe(2);
  expect(watch.notify("unrelated")).toBe(false);
  expect(watch.notify("link-a")).toBe(true);
  expect(await first).toBe("notified"); expect(watch.size).toBe(1);
  expect(watch.notify("link-a")).toBe(false);
  b.abort("private abort reason"); expect(await second).toBe("cancelled"); expect(watch.size).toBe(0);
  expect(await watch.wait("link-a", new AbortController().signal)).toBe("timeout"); expect(watch.size).toBe(0);
  expect(await watch.wait("link-b", b.signal)).toBe("cancelled"); expect(watch.size).toBe(0);
});

test("one waiter per link and global cap refuse without evicting another caller", async () => {
  const watch = new RouteIntentWatch(30, 1);
  const abort = new AbortController();
  const waiting = watch.wait("a", abort.signal);
  expect(await watch.wait("a", new AbortController().signal)).toBe("busy");
  expect(await watch.wait("b", new AbortController().signal)).toBe("busy");
  expect(watch.size).toBe(1);
  watch.notify("a"); expect(await waiting).toBe("notified"); expect(watch.size).toBe(0);
  const reused = watch.wait("b", abort.signal);
  abort.abort(); expect(await reused).toBe("cancelled"); expect(watch.size).toBe(0);
  for (const ms of [0, -1, NaN, Infinity, 30001]) expect(() => new RouteIntentWatch(ms)).toThrow();
  expect(() => new RouteIntentWatch(30000, 257)).toThrow();
});
