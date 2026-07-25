import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act, useEffect, useState } from "react";
import type { Root } from "react-dom/client";
import type { ViewMode } from "../src/view-mode";

const globals = ["document", "window", "navigator", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previousGlobals: Record<(typeof globals)[number], unknown>;
let testWindow: Window;

beforeEach(() => {
  previousGlobals = Object.fromEntries(globals.map((key) => [key, Reflect.get(globalThis, key)])) as typeof previousGlobals;
  testWindow = new Window({ url: "http://localhost/" });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: testWindow.document },
    window: { configurable: true, value: testWindow },
    navigator: { configurable: true, value: testWindow.navigator },
  });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  testWindow.close();
  for (const key of globals) {
    Object.defineProperty(globalThis, key, { configurable: true, value: previousGlobals[key] });
  }
});

test("toggling viewMode does not remount an unsupported stateful page", async () => {
  const { createRoot } = await import("react-dom/client");
  const container = document.createElement("div");
  document.body.append(container);
  let mounts = 0;

  function StatefulUnsupportedPage() {
    useEffect(() => {
      mounts += 1;
    }, []);
    return <input aria-label="draft" defaultValue="unsaved" />;
  }

  function SupportedPage({ viewMode }: { viewMode: ViewMode }) {
    return <div data-testid="supported">{viewMode}</div>;
  }

  function Shell() {
    const [viewMode, setViewMode] = useState<ViewMode>("classic");
    return (
      <div>
        <button type="button" onClick={() => setViewMode(mode => (mode === "classic" ? "workspace" : "classic"))}>
          toggle
        </button>
        <StatefulUnsupportedPage />
        <SupportedPage viewMode={viewMode} />
      </div>
    );
  }

  let root!: Root;
  await act(async () => {
    root = createRoot(container);
    root.render(<Shell />);
  });

  const input = container.querySelector<HTMLInputElement>('input[aria-label="draft"]')!;
  input.value = "keep-me";
  expect(input.value).toBe("keep-me");
  expect(mounts).toBe(1);

  await act(async () => {
    container.querySelector("button")!.click();
  });

  expect(container.querySelector('[data-testid="supported"]')?.textContent).toBe("workspace");
  expect(container.querySelector<HTMLInputElement>('input[aria-label="draft"]')?.value).toBe("keep-me");
  expect(mounts).toBe(1);

  await act(async () => { root.unmount(); });
});
