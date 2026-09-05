import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act, useLayoutEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useQuotaRefreshCoordinator } from "../src/pages/Providers";

const globals = ["document", "window", "navigator", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previous: Record<(typeof globals)[number], unknown>;
let win: Window;
let root: Root | null;
let coordinator: ReturnType<typeof useQuotaRefreshCoordinator>;

function Harness() {
  const currentCoordinator = useQuotaRefreshCoordinator("/coordinator");
  useLayoutEffect(() => { coordinator = currentCoordinator; }, [currentCoordinator]);
  return null;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
beforeEach(async () => {
  previous = Object.fromEntries(globals.map(key => [key, Reflect.get(globalThis, key)])) as typeof previous;
  win = new Window({ url: "http://localhost" });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: win.document }, window: { configurable: true, value: win },
    navigator: { configurable: true, value: win.navigator }, IS_REACT_ACT_ENVIRONMENT: { configurable: true, value: true },
  });
  const host = win.document.createElement("div");
  win.document.body.appendChild(host);
  await act(async () => { root = createRoot(host as unknown as HTMLElement); root.render(<Harness />); });
});
afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); root = null; });
  for (const key of globals) Object.defineProperty(globalThis, key, { configurable: true, value: previous[key] });
  await win.happyDOM.close();
});

test("production coordinator supersedes tickets and joins only matching report/account outcomes", async () => {
  const firstAccounts = deferred<boolean>();
  const secondAccounts = deferred<boolean>();
  const firstReport = deferred<boolean>();
  const secondReport = deferred<boolean>();
  const results: Array<[string, boolean]> = [];
  await act(async () => {
    void coordinator.beginQuotaRefresh(() => firstAccounts.promise).then(ok => { results.push(["first", ok]); });
  });
  const firstEpoch = coordinator.quotaRefresh.epoch;
  void firstReport.promise.then(ok => coordinator.settleQuotaRefresh(ok, firstEpoch));
  await act(async () => {
    void coordinator.beginQuotaRefresh(() => secondAccounts.promise).then(ok => { results.push(["second", ok]); });
  });
  const secondEpoch = coordinator.quotaRefresh.epoch;
  void secondReport.promise.then(ok => coordinator.settleQuotaRefresh(ok, secondEpoch));
  expect(secondEpoch).toBe(firstEpoch + 1);
  expect(results).toEqual([["first", false]]);
  // Reverse completion: a report success alone cannot settle even the current ticket.
  await act(async () => { secondReport.resolve(true); });
  expect(results).toEqual([["first", false]]);
  await act(async () => { secondAccounts.resolve(true); });
  expect(results).toEqual([["first", false], ["second", true]]);
  await act(async () => { firstReport.resolve(true); firstAccounts.resolve(true); });
  expect(results).toEqual([["first", false], ["second", true]]);
});

test("an older report cannot settle a newer ticket whose accounts already finished", async () => {
  let first!: Promise<boolean>;
  let second!: Promise<boolean>;
  const results: boolean[] = [];
  await act(async () => { first = coordinator.beginQuotaRefresh(); });
  const oldEpoch = coordinator.quotaRefresh.epoch;
  await act(async () => { second = coordinator.beginQuotaRefresh(async () => true); void second.then(ok => { results.push(ok); }); });
  expect(await first).toBe(false);
  await act(async () => { coordinator.settleQuotaRefresh(true, oldEpoch); });
  expect(results).toEqual([]);
  await act(async () => { coordinator.settleQuotaRefresh(false, coordinator.quotaRefresh.epoch); });
  expect(await second).toBe(false);
  expect(results).toEqual([false]);
});

test("account failure wins over successful report; mutation and unmount resolve superseded tickets false", async () => {
  let result!: Promise<boolean>;
  await act(async () => { result = coordinator.beginQuotaRefresh(async () => false); });
  await act(async () => { coordinator.settleQuotaRefresh(true, coordinator.quotaRefresh.epoch); });
  expect(await result).toBe(false);
  await act(async () => { result = coordinator.beginQuotaRefresh(); });
  await act(async () => { coordinator.invalidateProviderQuotas(false); });
  expect(await result).toBe(false);
  const hanging = deferred<boolean>();
  await act(async () => { result = coordinator.beginQuotaRefresh(() => hanging.promise); });
  await act(async () => { root!.unmount(); root = null; });
  expect(await result).toBe(false);
  hanging.resolve(true);
});
