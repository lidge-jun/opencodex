import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { Window } from "happy-dom";
import { createTargetDiscovery } from "../src/api-target-lifecycle";
import { standaloneApiTargets, type ApiTargets } from "../src/api-targets";

let win: Window;
let previous: Record<string, unknown>;

function connectedTargets(): ApiTargets {
  const base = standaloneApiTargets("http://127.0.0.1:4800");
  return {
    ...base,
    connected: true,
    shared: { ...base.shared, baseUrl: "/api/machine/hub-relay", serverOrigin: "https://hub.example", transport: "relay" },
    apiKeyId: "fixture-key",
  };
}

function harness(discover: (base: string, signal: AbortSignal) => Promise<ApiTargets>) {
  let session = false;
  let discoverCalls = 0;
  let bootstrapCalls = 0;
  let targets: ApiTargets | null = null;
  let settled = 0;
  const discovery = createTargetDiscovery({
    initialBase: "http://127.0.0.1:4800",
    discover: async (base, signal) => { discoverCalls += 1; return await discover(base, signal); },
    configure: () => {},
    bootstrap: async () => { bootstrapCalls += 1; session = true; },
    hasSession: () => session,
    onTargets: next => { targets = next; },
    onSessionReady: () => {},
    onError: () => {},
    onSettled: () => { settled += 1; },
    isClientStateChanged: () => false,
  });
  return { discovery, counts: () => ({ discoverCalls, bootstrapCalls, settled, targets }) };
}

beforeEach(() => {
  previous = Object.fromEntries(["window", "document", "navigator", "IS_REACT_ACT_ENVIRONMENT"].map(key => [key, Reflect.get(globalThis, key)]));
  win = new Window({ url: "http://127.0.0.1:4800/" });
  for (const [key, value] of Object.entries({ window: win, document: win.document, navigator: win.navigator, IS_REACT_ACT_ENVIRONMENT: true })) {
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
});

afterEach(() => {
  win.close();
  for (const [key, value] of Object.entries(previous)) {
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
});

test("an event burst coalesces to one in-flight read and one follow-up", async () => {
  let release!: (targets: ApiTargets) => void;
  const { discovery, counts } = harness(async () => await new Promise<ApiTargets>(resolve => { release = resolve; }));
  const first = discovery.refresh();
  void discovery.refresh();
  void discovery.refresh();
  void discovery.refresh();
  expect(counts().discoverCalls).toBe(1);
  release(connectedTargets());
  await first;
  await Promise.resolve();
  await Promise.resolve();
  expect(counts().discoverCalls).toBe(2);
  expect(counts().bootstrapCalls).toBe(1);
  expect(counts().settled).toBe(1);
});

test("a same-target session refresh does not recurse", async () => {
  const { discovery, counts } = harness(async () => connectedTargets());
  await discovery.refresh();
  await discovery.refresh();
  await Promise.resolve();
  expect(counts().discoverCalls).toBe(2);
  expect(counts().bootstrapCalls).toBe(1);
  expect(counts().settled).toBe(2);
});

test("standalone discovery starts no machine poll and no bootstrap", async () => {
  const interval = spyOn(win, "setInterval");
  const { discovery, counts } = harness(async () => standaloneApiTargets("http://127.0.0.1:4800"));
  await discovery.refresh();
  await Promise.resolve();
  expect(counts().discoverCalls).toBe(1);
  expect(counts().bootstrapCalls).toBe(0);
  expect(interval).not.toHaveBeenCalled();
  interval.mockRestore();
});
