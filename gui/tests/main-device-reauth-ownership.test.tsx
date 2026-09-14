import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act, createElement, StrictMode, useEffect } from "react";
import type { Root } from "react-dom/client";
import { useMainDeviceReauth } from "../src/components/use-main-device-reauth";

type Hook = ReturnType<typeof useMainDeviceReauth>;
type Dto = Record<string, unknown>;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function request(method: string, url: string) {
  const response = deferred<Response>();
  const body = deferred<Dto>();
  let headersSent = false;
  return {
    method, url, response, body, claimed: false,
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
    drain() {
      // Abort is deliberately ignored by this fake: already-delivered bodies can
      // finish late. Drain both boundaries so teardown leaves no task waiting.
      this.reply({});
    },
  };
}
type Request = ReturnType<typeof request>;

const globalKeys = ["window", "document", "navigator", "IS_REACT_ACT_ENVIRONMENT", "fetch", "setTimeout"] as const;
let descriptors: Map<string, PropertyDescriptor | undefined>;
let win: Window;
let host: HTMLElement;
let root: Root | null;
let hook: Hook;
let completed: number;
let setups: number;
let cleanups: number;
let requests: Request[];
let tasks: Promise<void>[];
let sleepers: Array<() => void>;

beforeEach(() => {
  descriptors = new Map(globalKeys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  win = new Window({ url: "http://localhost/" });
  host = win.document.createElement("div") as unknown as HTMLElement;
  win.document.body.appendChild(host);
  root = null;
  completed = 0;
  setups = 0;
  cleanups = 0;
  requests = [];
  tasks = [];
  sleepers = [];
  const realSetTimeout = globalThis.setTimeout;
  Object.defineProperties(globalThis, {
    window: { configurable: true, value: win },
    document: { configurable: true, value: win.document },
    navigator: { configurable: true, value: win.navigator },
    IS_REACT_ACT_ENVIRONMENT: { configurable: true, value: true },
    fetch: {
      configurable: true,
      value: (input: RequestInfo | URL, init?: RequestInit) => {
        const pending = request(init?.method ?? "GET", String(input));
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
  for (const [key, descriptor] of descriptors) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

async function mount(strict = false) {
  const { createRoot } = await import("react-dom/client");
  function Probe() {
    const value = useMainDeviceReauth("", () => { completed += 1; });
    useEffect(() => { hook = value; });
    useEffect(() => {
      setups += 1;
      return () => { cleanups += 1; };
    }, []);
    return null;
  }
  await act(async () => {
    root = createRoot(host);
    const child = createElement(Probe);
    root.render(strict ? createElement(StrictMode, null, child) : child);
  });
}

async function invoke(action: () => Promise<void>) {
  await act(async () => { tasks.push(action()); });
}

function take(method: string, flowId?: string): Request {
  const pending = requests.find(candidate =>
    !candidate.claimed && candidate.method === method &&
    (flowId === undefined || new URL(candidate.url, "http://localhost").searchParams.get("flowId") === flowId));
  expect(pending).toBeDefined();
  pending!.claimed = true;
  return pending!;
}

async function reply(pending: Request, dto: Dto, status = 200) {
  await act(async () => { pending.reply(dto, status); });
}

async function beginFlow(flowId: string) {
  await invoke(() => hook.start());
  await reply(take("POST"), { flowId });
  await reply(take("GET", flowId), {
    flowId, status: "pending", verificationUrl: "https://auth.openai.com/codex/device",
    deviceCode: "ABCD-1234",
  });
  expect(hook.state).toMatchObject({ phase: "pending", flowId });
}

for (const late of ["succeeded", "failed", "unknown_flow", "network"] as const) {
  test(`late DELETE ${late} for A cannot disturb restarted flow B`, async () => {
    await mount();
    await beginFlow("A");
    await invoke(() => hook.cancel());
    const first = take("DELETE", "A");
    await invoke(() => hook.cancel());
    const delayed = take("DELETE", "A");
    await reply(first, { status: "failed", code: "publication_failed" });
    await beginFlow("B");
    const before = hook.state;
    await act(async () => {
      if (late === "network") delayed.response.reject(new Error("late network failure"));
      else if (late === "unknown_flow") delayed.reply({ code: "unknown_flow" }, 404);
      else delayed.reply({ status: late, code: "publication_failed" });
    });
    expect(hook.state).toEqual(before);
    expect(completed).toBe(0);
    // State alone can look unchanged even when the private flowRef was lost.
    await invoke(() => hook.cancel());
    await reply(take("DELETE", "B"), { status: "cancelled" });
    expect(hook.state.phase).toBe("cancelled");
  });
}

for (const boundary of ["headers", "json"] as const) {
  test(`late GET ${boundary} for A cannot settle restarted flow B`, async () => {
    await mount();
    await invoke(() => hook.start());
    await reply(take("POST"), { flowId: "A" });
    const delayed = take("GET", "A");
    if (boundary === "json") await act(async () => { delayed.headers(); });
    await invoke(() => hook.cancel());
    await reply(take("DELETE", "A"), { status: "cancelled" });
    await beginFlow("B");
    const before = hook.state;
    await reply(delayed, { flowId: "A", status: "succeeded" });
    expect(hook.state).toEqual(before);
    expect(completed).toBe(0);
    await invoke(() => hook.cancel());
    await reply(take("DELETE", "B"), { status: "cancelled" });
  });
}

for (const outcome of ["success", "http_failure"] as const) {
  test(`late POST JSON ${outcome} cannot replace a newer start`, async () => {
    await mount();
    await invoke(() => hook.start());
    const delayed = take("POST");
    await act(async () => { delayed.headers(outcome === "success" ? 200 : 409); });
    await beginFlow("B");
    const before = hook.state;
    await act(async () => {
      delayed.body.resolve(outcome === "success" ? { flowId: "A" } : { code: "flow_in_progress" });
    });
    expect(hook.state).toEqual(before);
    expect(completed).toBe(0);
    expect(requests.filter(pending => pending.method === "GET" && pending.url.includes("flowId=A"))).toHaveLength(0);
    await invoke(() => hook.cancel());
    await reply(take("DELETE", "B"), { status: "cancelled" });
  });
}

test("a DELETE body delivered after unmount cannot invoke completion", async () => {
  await mount();
  await beginFlow("A");
  await invoke(() => hook.cancel());
  const delayed = take("DELETE", "A");
  await act(async () => { delayed.headers(); });
  await act(async () => { root!.unmount(); root = null; });
  await reply(delayed, { status: "succeeded" });
  expect(completed).toBe(0);
});

test("StrictMode setup-cleanup-setup still permits start and polling", async () => {
  await mount(true);
  expect(setups).toBe(2);
  expect(cleanups).toBe(1);
  await beginFlow("A");
  await invoke(() => hook.cancel());
  await reply(take("DELETE", "A"), { status: "cancelled" });
  expect(hook.state.phase).toBe("cancelled");
});

for (const failure of ["network", "http", "nonterminal"] as const) {
  test(`polling observes completion after retryable cancellation ${failure}`, async () => {
    await mount();
    await beginFlow("A");
    await invoke(() => hook.cancel());
    const cancellation = take("DELETE", "A");
    await act(async () => {
      if (failure === "network") cancellation.response.reject(new Error("transient cancellation failure"));
      else if (failure === "http") cancellation.reply({ code: "unavailable" }, 503);
      else cancellation.reply({ status: "pending" });
    });
    expect(hook.state).toMatchObject({ phase: "pending", flowId: "A", cancelFailed: true });
    await act(async () => { for (const wake of sleepers.splice(0)) wake(); });
    await reply(take("GET", "A"), { status: "pending" });
    expect(hook.state).toMatchObject({ phase: "pending", flowId: "A", cancelFailed: true });
    await act(async () => { for (const wake of sleepers.splice(0)) wake(); });
    await reply(take("GET", "A"), { status: "succeeded" });
    expect(hook.state.phase).toBe("succeeded");
    expect(completed).toBe(1);
  });
}

test("two successful cancellation replies complete the same flow only once", async () => {
  await mount();
  await beginFlow("A");
  await invoke(() => hook.cancel());
  const first = take("DELETE", "A");
  await invoke(() => hook.cancel());
  const second = take("DELETE", "A");
  await reply(first, { status: "succeeded" });
  await reply(second, { status: "succeeded" });
  expect(hook.state.phase).toBe("succeeded");
  expect(completed).toBe(1);
});
