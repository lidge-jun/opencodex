import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import {
  QUOTA_LIVE_REFRESH_DEFAULT,
  clampQuotaLiveRefreshSeconds,
  parseQuotaLiveRefreshPref,
  readQuotaLiveRefreshPref,
  subscribeQuotaLiveRefreshPref,
  writeQuotaLiveRefreshPref,
} from "../src/quota-live-refresh-pref";

const KEY = "ocx.quota.liveRefresh";
const globals = ["window"] as const;
let previous: Record<(typeof globals)[number], PropertyDescriptor | undefined>;
let win: Window;

beforeEach(() => {
  previous = Object.fromEntries(globals.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)])) as typeof previous;
  win = new Window({ url: "http://localhost/" });
  Object.defineProperty(globalThis, "window", { configurable: true, value: win });
});

afterEach(() => {
  win.close();
  for (const key of globals) {
    const descriptor = previous[key];
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

test("nothing stored means live updates are on at 15 seconds", () => {
  expect(QUOTA_LIVE_REFRESH_DEFAULT).toEqual({ enabled: true, intervalSeconds: 15 });
  expect(readQuotaLiveRefreshPref()).toEqual({ enabled: true, intervalSeconds: 15 });
  // useSyncExternalStore needs one snapshot object per stored value.
  expect(readQuotaLiveRefreshPref()).toBe(readQuotaLiveRefreshPref());
});

test("a stored value that is not a preference falls back field by field", () => {
  for (const raw of [null, "", "not json", "[]", "null", "42", "\"on\""]) {
    expect(parseQuotaLiveRefreshPref(raw)).toEqual(QUOTA_LIVE_REFRESH_DEFAULT);
  }
  expect(parseQuotaLiveRefreshPref("{\"enabled\":\"yes\",\"intervalSeconds\":\"30\"}")).toEqual(QUOTA_LIVE_REFRESH_DEFAULT);
  expect(parseQuotaLiveRefreshPref("{\"enabled\":false}")).toEqual({ enabled: false, intervalSeconds: 15 });
  expect(parseQuotaLiveRefreshPref("{\"enabled\":true,\"intervalSeconds\":2}")).toEqual({ enabled: true, intervalSeconds: 5 });
  expect(parseQuotaLiveRefreshPref("{\"enabled\":true,\"intervalSeconds\":86400}")).toEqual({ enabled: true, intervalSeconds: 600 });
  expect(parseQuotaLiveRefreshPref("{\"enabled\":false,\"intervalSeconds\":12.6}")).toEqual({ enabled: false, intervalSeconds: 13 });
  win.localStorage.setItem(KEY, "{\"enabled\":false,\"intervalSeconds\":-1}");
  expect(readQuotaLiveRefreshPref()).toEqual({ enabled: false, intervalSeconds: 5 });
});

test("the interval is whole seconds from 5 to 600", () => {
  expect(clampQuotaLiveRefreshSeconds(0)).toBe(5);
  expect(clampQuotaLiveRefreshSeconds(4.4)).toBe(5);
  expect(clampQuotaLiveRefreshSeconds(5)).toBe(5);
  expect(clampQuotaLiveRefreshSeconds(30.5)).toBe(31);
  expect(clampQuotaLiveRefreshSeconds(600)).toBe(600);
  expect(clampQuotaLiveRefreshSeconds(601)).toBe(600);
  expect(clampQuotaLiveRefreshSeconds(Number.NaN)).toBe(15);
  expect(clampQuotaLiveRefreshSeconds(Number.POSITIVE_INFINITY)).toBe(15);
});

test("a write is clamped before it is stored and tells this tab's subscribers", () => {
  let calls = 0;
  const unsubscribe = subscribeQuotaLiveRefreshPref(() => { calls += 1; });
  expect(writeQuotaLiveRefreshPref({ enabled: false, intervalSeconds: 1 })).toEqual({ enabled: false, intervalSeconds: 5 });
  expect(JSON.parse(win.localStorage.getItem(KEY)!)).toEqual({ enabled: false, intervalSeconds: 5 });
  expect(readQuotaLiveRefreshPref()).toEqual({ enabled: false, intervalSeconds: 5 });
  expect(calls).toBe(1);
  unsubscribe();
  writeQuotaLiveRefreshPref({ enabled: true, intervalSeconds: 20 });
  expect(calls).toBe(1);
});

test("a change made in another tab reaches subscribers through the storage event", () => {
  let calls = 0;
  const unsubscribe = subscribeQuotaLiveRefreshPref(() => { calls += 1; });
  win.localStorage.setItem(KEY, JSON.stringify({ enabled: false, intervalSeconds: 45 }));
  win.dispatchEvent(new win.StorageEvent("storage", { key: "unrelated" }));
  expect(calls).toBe(0);
  win.dispatchEvent(new win.StorageEvent("storage", { key: KEY }));
  expect(calls).toBe(1);
  expect(readQuotaLiveRefreshPref()).toEqual({ enabled: false, intervalSeconds: 45 });
  // `key: null` is another tab clearing all of storage.
  win.localStorage.clear();
  win.dispatchEvent(new win.StorageEvent("storage", { key: null }));
  expect(calls).toBe(2);
  expect(readQuotaLiveRefreshPref()).toEqual(QUOTA_LIVE_REFRESH_DEFAULT);
  unsubscribe();
  win.dispatchEvent(new win.StorageEvent("storage", { key: KEY }));
  expect(calls).toBe(2);
});

test("disabled storage reads as the default and keeps a choice for this tab", () => {
  const storage = win.localStorage;
  Object.defineProperty(win, "localStorage", { configurable: true, get: () => { throw new Error("storage disabled"); } });
  expect(readQuotaLiveRefreshPref()).toEqual(QUOTA_LIVE_REFRESH_DEFAULT);
  let calls = 0;
  const unsubscribe = subscribeQuotaLiveRefreshPref(() => { calls += 1; });
  expect(() => writeQuotaLiveRefreshPref({ enabled: false, intervalSeconds: 30 })).not.toThrow();
  expect(readQuotaLiveRefreshPref()).toEqual({ enabled: false, intervalSeconds: 30 });
  expect(calls).toBe(1);
  // Storage coming back: the next successful write replaces the tab-only choice.
  Object.defineProperty(win, "localStorage", { configurable: true, get: () => storage });
  writeQuotaLiveRefreshPref({ enabled: true, intervalSeconds: 20 });
  expect(JSON.parse(storage.getItem(KEY)!)).toEqual({ enabled: true, intervalSeconds: 20 });
  expect(readQuotaLiveRefreshPref()).toEqual({ enabled: true, intervalSeconds: 20 });
  unsubscribe();
});
