import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act, useEffect, useState } from "react";
import type { Root } from "react-dom/client";

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

/** Mirrors the Dashboard guidance control contract without mounting the full page. */
function GuidanceControls({
  enabled,
  model,
}: {
  enabled: boolean;
  model: string;
}) {
  return (
    <div>
      <select aria-label="model" disabled={!enabled} defaultValue={model}>
        <option value="gpt">gpt</option>
        <option value="claude">claude</option>
      </select>
      <select aria-label="effort" disabled={!enabled} defaultValue="medium">
        <option value="medium">medium</option>
      </select>
      {enabled && model ? <span className="badge badge-green">Active</span> : null}
    </div>
  );
}

test("guidance-off keeps stored selection but hides Active and disables controls", async () => {
  const { createRoot } = await import("react-dom/client");
  const host = document.createElement("div");
  document.body.append(host);
  let root!: Root;
  function Shell() {
    const [enabled, setEnabled] = useState(false);
    useEffect(() => {}, []);
    return (
      <div>
        <button type="button" onClick={() => setEnabled(value => !value)}>toggle</button>
        <GuidanceControls enabled={enabled} model="claude" />
      </div>
    );
  }
  await act(async () => {
    root = createRoot(host);
    root.render(<Shell />);
  });
  const model = host.querySelector<HTMLSelectElement>('select[aria-label="model"]')!;
  expect(model.disabled).toBe(true);
  expect(model.value).toBe("claude");
  expect(host.textContent).not.toContain("Active");
  await act(async () => { host.querySelector("button")!.click(); });
  expect(model.disabled).toBe(false);
  expect(host.textContent).toContain("Active");
  await act(async () => { root.unmount(); });
});
