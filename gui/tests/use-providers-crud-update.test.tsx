import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { act, useEffect, useRef, useState } from "react";
import type { Root } from "react-dom/client";
import { Window } from "happy-dom";
import { useProvidersCrud } from "../src/pages/use-providers-crud";
import type { ProviderUpdatePatch } from "../src/components/provider-workspace/types";

const globals = ["document", "window", "navigator", "localStorage", "IS_REACT_ACT_ENVIRONMENT"] as const;
const originalFetch = globalThis.fetch;
let previousGlobals: Record<(typeof globals)[number], unknown>;
let testWindow: Window;

beforeEach(() => {
  previousGlobals = Object.fromEntries(globals.map(key => [key, Reflect.get(globalThis, key)])) as typeof previousGlobals;
  testWindow = new Window({ url: "http://localhost/" });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: testWindow.document },
    window: { configurable: true, value: testWindow },
    navigator: { configurable: true, value: testWindow.navigator },
    localStorage: { configurable: true, value: testWindow.localStorage },
  });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  testWindow.close();
  for (const key of globals) {
    Object.defineProperty(globalThis, key, { configurable: true, value: previousGlobals[key] });
  }
});

test("updateProvider awaits fetchConfig before returning success", async () => {
  let resolveConfig!: () => void;
  const configPromise = new Promise<void>(resolve => {
    resolveConfig = resolve;
  });
  const fetchConfig = mock(() => configPromise);
  globalThis.fetch = (async () => Response.json({ ok: true })) as typeof fetch;

  const container = document.createElement("div");
  document.body.append(container);
  const { createRoot } = await import("react-dom/client");
  let root!: Root;
  let updateProvider!: (name: string, patch: ProviderUpdatePatch) => Promise<{ ok: boolean; error?: string }>;

  function Harness() {
    const removeBusyRef = useRef(false);
    const crud = useProvidersCrud({
      apiBase: "http://localhost:10100",
      t: ((key: string) => key) as never,
      removeBusyRef,
      workspaceSelected: null,
      setWorkspaceSelected: () => {},
      setRemoveConfirmName: () => {},
      notify: () => {},
      fetchConfig,
      fetchOauth: async () => {},
      fetchProviderQuotas: async () => {},
    });
    const [ready, setReady] = useState(false);
    useEffect(() => {
      updateProvider = crud.updateProvider;
      setReady(true);
    }, [crud.updateProvider]);
    return ready ? <div data-ready="1" /> : null;
  }

  await act(async () => {
    root = createRoot(container);
    root.render(<Harness />);
  });
  expect(container.querySelector("[data-ready]")).toBeTruthy();

  let settled: { ok: boolean; error?: string } | undefined;
  const pending = updateProvider("openai", { note: "next" }).then(result => {
    settled = result;
  });

  await act(async () => {
    await Promise.resolve();
  });
  expect(fetchConfig).toHaveBeenCalledTimes(1);
  expect(settled).toBeUndefined();

  await act(async () => {
    resolveConfig();
    await pending;
  });
  expect(settled).toEqual({ ok: true });

  await act(async () => { root.unmount(); });
});
