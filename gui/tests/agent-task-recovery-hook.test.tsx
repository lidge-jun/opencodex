import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { useAgentTaskRecovery } from "../src/pages/use-agent-task-recovery";

const globals = ["document", "window", "navigator", "fetch", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previous: Record<(typeof globals)[number], unknown>;
let testWindow: Window;
let root: Root | null;

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await new Promise<void>(resolve => testWindow.setTimeout(resolve, 0));
}

beforeEach(() => {
  previous = Object.fromEntries(globals.map(key => [key, Reflect.get(globalThis, key)])) as typeof previous;
  testWindow = new Window({ url: "http://localhost/" });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: testWindow.document },
    window: { configurable: true, value: testWindow },
    navigator: { configurable: true, value: testWindow.navigator },
  });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  root = null;
});

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  for (const key of globals) Object.defineProperty(globalThis, key, { configurable: true, value: previous[key] });
  await testWindow.happyDOM?.close?.();
});

test("a delayed initial read cannot overwrite a successful save", async () => {
  const initialGet = deferred<Response>();
  globalThis.fetch = (async (_input, init) => init?.method === "PUT"
    ? Response.json({ ok: true, enabled: true })
    : initialGet.promise) as typeof fetch;

  let recovery: ReturnType<typeof useAgentTaskRecovery> | undefined;
  function Probe() {
    recovery = useAgentTaskRecovery("http://proxy");
    return null;
  }

  const host = document.createElement("div");
  document.body.append(host);
  const { createRoot } = await import("react-dom/client");
  await act(async () => {
    root = createRoot(host);
    root.render(<Probe />);
  });

  await act(async () => {
    expect(await recovery!.save(true)).toBe(true);
    await flush();
  });
  expect(recovery!.enabled).toBe(true);

  await act(async () => {
    initialGet.resolve(Response.json({ enabled: false }));
    await flush();
  });
  expect(recovery!.enabled).toBe(true);
});
