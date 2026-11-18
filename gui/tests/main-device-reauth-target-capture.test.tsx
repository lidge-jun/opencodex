import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act, useLayoutEffect } from "react";
import type { Root } from "react-dom/client";
import { configureApiTargets } from "../src/api";
import { standaloneApiTargets } from "../src/api-targets";
import { useMainDeviceReauth } from "../src/components/use-main-device-reauth";

/**
 * The native-main device reauth belongs to the logical target it started on.
 * Start, poll, cancel and unmount cleanup must use the flow's original capture;
 * a target change releases the abandoned flow without claiming an outcome.
 */

type Dto = Record<string, unknown>;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}

function request(method: string, url: string, target: string | null) {
  const response = deferred<Response>();
  const body = deferred<Dto>();
  let headersSent = false;
  return {
    method, url, target, response, body, claimed: false,
    headers(status = 200) {
      if (headersSent) return;
      headersSent = true;
      response.resolve({
        ok: status >= 200 && status < 300,
        status,
        json: () => body.promise,
      } as Response);
    },
    reply(dto: Dto, status = 200) {
      this.headers(status);
      body.resolve(dto);
    },
    drain() { this.reply({}); },
  };
}
type Request = ReturnType<typeof request>;

const globalKeys = ["window", "document", "navigator", "localStorage", "IS_REACT_ACT_ENVIRONMENT", "fetch", "setTimeout"] as const;
let descriptors: Map<string, PropertyDescriptor | undefined>;
let win: Window;
let host: HTMLElement;
let root: Root | null;
let hook: ReturnType<typeof useMainDeviceReauth>;
let completed: number;
let requests: Request[];
let tasks: Promise<void>[];
let sleepers: Array<() => void>;

function relay(apiBase: string, origin: string) {
  const base = standaloneApiTargets(apiBase);
  return {
    ...base,
    connected: true,
    shared: { ...base.shared, baseUrl: apiBase, serverOrigin: origin, transport: "relay" as const },
    apiKeyId: "fixture-key",
    relayTargetCheck: "expected-target-v1" as const,
  };
}

beforeEach(() => {
  descriptors = new Map(globalKeys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  win = new Window({ url: "http://localhost/" });
  host = win.document.createElement("div") as unknown as HTMLElement;
  win.document.body.appendChild(host);
  root = null;
  completed = 0;
  requests = [];
  tasks = [];
  sleepers = [];
  const realSetTimeout = globalThis.setTimeout;
  Object.defineProperties(globalThis, {
    window: { configurable: true, value: win },
    document: { configurable: true, value: win.document },
    navigator: { configurable: true, value: win.navigator },
    localStorage: { configurable: true, value: win.localStorage },
    IS_REACT_ACT_ENVIRONMENT: { configurable: true, value: true },
    fetch: {
      configurable: true,
      value: (input: RequestInfo | URL, init?: RequestInit) => {
        const headers = new Headers(init?.headers ?? undefined);
        const pending = request(
          init?.method ?? "GET",
          String(input),
          headers.get("x-opencodex-expected-target"),
        );
        requests.push(pending);
        return pending.response.promise;
      },
    },
    setTimeout: {
      configurable: true,
      value: ((callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) => {
        if (delay === 2_000) {
          sleepers.push(() => callback(...args));
          return 0;
        }
        return realSetTimeout(callback, delay, ...args);
      }) as typeof setTimeout,
    },
  });
});

afterEach(async () => {
  await act(async () => {
    root?.unmount();
    root = null;
    for (const pending of requests) pending.drain();
    for (const wake of sleepers.splice(0)) wake();
  });
  await act(async () => {
    for (const wake of sleepers.splice(0)) wake();
    await Promise.allSettled(tasks);
  });
  host.remove();
  // Leave the shared api module on the default standalone target for the next file.
  configureApiTargets(standaloneApiTargets(""));
  for (const [key, descriptor] of descriptors) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

function Probe({ targetKey }: { targetKey: string }) {
  const value = useMainDeviceReauth("/same", () => { completed += 1; }, targetKey);
  useLayoutEffect(() => { hook = value; });
  return null;
}

async function mount(targetKey: string): Promise<void> {
  const { createRoot } = await import("react-dom/client");
  await act(async () => {
    if (!root) root = createRoot(host);
    root.render(<Probe targetKey={targetKey} />);
  });
}

async function invoke(action: () => Promise<void>): Promise<void> {
  await act(async () => { tasks.push(action()); });
}

async function settle(action: () => Promise<void>): Promise<void> {
  await act(async () => { await action(); });
}

function take(method: string, flowId?: string): Request {
  const pending = requests.find(candidate =>
    !candidate.claimed && candidate.method === method &&
    (flowId === undefined || new URL(candidate.url, "http://localhost").searchParams.get("flowId") === flowId));
  expect(pending).toBeDefined();
  pending!.claimed = true;
  return pending!;
}

async function reply(pending: Request, dto: Dto, status = 200): Promise<void> {
  await act(async () => { pending.reply(dto, status); });
}

async function beginFlow(flowId: string): Promise<void> {
  await invoke(() => hook.start());
  await reply(take("POST"), { flowId });
  await reply(take("GET", flowId), {
    flowId, status: "pending", verificationUrl: "https://auth.openai.com/codex/device",
    deviceCode: "ABCD-1234",
  });
  expect(hook.state).toMatchObject({ phase: "pending", flowId });
}

test("a render gap refuses the start POST before fetch", async () => {
  configureApiTargets(relay("/same", "hub-a"));
  await mount("hub-a");
  configureApiTargets(relay("/same", "hub-b"));
  await settle(() => hook.start());
  expect(requests).toEqual([]);
  expect(hook.state).toEqual({ phase: "failed", code: "request_failed" });
});

test("a stale cancel is refused and expires the flow instead of claiming delivery", async () => {
  configureApiTargets(relay("/same", "hub-a"));
  await mount("hub-a");
  await beginFlow("A");
  configureApiTargets(relay("/same", "hub-b"));
  await settle(() => hook.cancel());
  expect(requests.filter(pending => !pending.claimed)).toEqual([]);
  expect(hook.state).toEqual({ phase: "failed", code: "request_failed" });
  expect(completed).toBe(0);
});

test("a stale poll stops without a status request to B", async () => {
  configureApiTargets(relay("/same", "hub-a"));
  await mount("hub-a");
  await beginFlow("A");
  configureApiTargets(relay("/same", "hub-b"));
  await act(async () => {
    for (const wake of sleepers.splice(0)) wake();
    await new Promise(resolve => setTimeout(resolve, 0));
  });
  expect(requests.filter(pending => !pending.claimed)).toEqual([]);
  expect(hook.state).toEqual({ phase: "failed", code: "request_failed" });
  expect(completed).toBe(0);
});

test("a target change resets the card and B can run its own flow", async () => {
  configureApiTargets(relay("/same", "hub-a"));
  await mount("hub-a");
  await beginFlow("A");

  configureApiTargets(relay("/same", "hub-b"));
  await mount("hub-b");
  await act(async () => {
    for (const wake of sleepers.splice(0)) wake();
    await new Promise(resolve => setTimeout(resolve, 0));
  });
  expect(hook.state).toEqual({ phase: "idle" });
  expect(requests.filter(pending => !pending.claimed)).toEqual([]);

  await invoke(() => hook.start());
  const post = take("POST");
  expect(post.target).toBe("hub-b");
  await reply(post, { flowId: "B" });
  await reply(take("GET", "B"), { status: "pending", verificationUrl: "https://auth.openai.com/codex/device", deviceCode: "WXYZ-9876" });
  await invoke(() => hook.cancel());
  const cancellation = take("DELETE", "B");
  expect(cancellation.target).toBe("hub-b");
  await reply(cancellation, { status: "cancelled" });
  expect(hook.state.phase).toBe("cancelled");
});

test("ABA does not revive the abandoned A flow", async () => {
  configureApiTargets(relay("/same", "hub-a"));
  await mount("hub-a");
  await beginFlow("A");
  configureApiTargets(relay("/same", "hub-b"));
  await mount("hub-b");
  configureApiTargets(relay("/same", "hub-a"));
  await mount("hub-a");
  expect(hook.state).toEqual({ phase: "idle" });
  await settle(() => hook.cancel());
  expect(requests.filter(pending => !pending.claimed)).toEqual([]);

  await invoke(() => hook.start());
  const post = take("POST");
  expect(post.target).toBe("hub-a");
  await reply(post, { flowId: "C" });
  await reply(take("GET", "C"), { status: "pending", verificationUrl: "https://auth.openai.com/codex/device", deviceCode: "QQQQ-1111" });
  await invoke(() => hook.cancel());
  await reply(take("DELETE", "C"), { status: "cancelled" });
  expect(hook.state.phase).toBe("cancelled");
});

test("a completion in flight during a target change is dropped", async () => {
  configureApiTargets(relay("/same", "hub-a"));
  await mount("hub-a");
  await beginFlow("A");
  await act(async () => { for (const wake of sleepers.splice(0)) wake(); });
  const inFlight = take("GET", "A");
  configureApiTargets(relay("/same", "hub-b"));
  await mount("hub-b");
  await reply(inFlight, { status: "succeeded" });
  expect(completed).toBe(0);
  expect(hook.state.phase).not.toBe("succeeded");
});

test("a completion on the flow's own target still completes once", async () => {
  configureApiTargets(relay("/same", "hub-a"));
  await mount("hub-a");
  await beginFlow("A");
  await act(async () => { for (const wake of sleepers.splice(0)) wake(); });
  await reply(take("GET", "A"), { status: "succeeded" });
  expect(hook.state.phase).toBe("succeeded");
  expect(completed).toBe(1);
});
