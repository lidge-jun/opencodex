import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { LanguageProvider } from "../src/i18n/provider";
import { AdvisorEditor, type AdvisorSettings } from "../src/pages/Advisor";

const globals = [
  "document",
  "window",
  "navigator",
  "localStorage",
  "IS_REACT_ACT_ENVIRONMENT",
] as const;

let previousGlobals: Record<(typeof globals)[number], unknown>;
let testWindow: Window;
const originalFetch = globalThis.fetch;

const initialSettings: AdvisorSettings = {
  enabled: true,
  model: "expert/gpt-6-astra",
  effort: "medium",
  policy: "manual",
  timeoutMs: 5000,
  contextSharingConsent: "v1",
};

beforeEach(() => {
  previousGlobals = Object.fromEntries(
    globals.map(key => [key, Reflect.get(globalThis, key)]),
  ) as typeof previousGlobals;
  testWindow = new Window({ url: "http://localhost/#advisor" });
  Object.defineProperty(testWindow.navigator, "language", { configurable: true, value: "en-US" });
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

async function mountEditor(initial = initialSettings): Promise<{ root: Root; container: HTMLElement }> {
  const container = testWindow.document.createElement("div") as unknown as HTMLElement;
  testWindow.document.body.append(container as never);
  const { createRoot } = await import("react-dom/client");
  let root!: Root;
  await act(async () => {
    root = createRoot(container);
    root.render(
      <LanguageProvider>
        <AdvisorEditor apiBase="http://localhost:3000" initial={initial} />
      </LanguageProvider>,
    );
  });
  return { root, container };
}

async function setModel(container: HTMLElement, value: string): Promise<void> {
  const input = container.querySelector<HTMLInputElement>("#advisor-model")!;
  expect(input).toBeTruthy();
  await act(async () => {
    Object.getOwnPropertyDescriptor(testWindow.HTMLInputElement.prototype, "value")!
      .set!.call(input, value);
    input.dispatchEvent(new testWindow.Event("input", { bubbles: true }));
  });
}

async function clickSave(container: HTMLElement): Promise<void> {
  const button = container.querySelector<HTMLButtonElement>("button.btn")!;
  expect(button).toBeTruthy();
  await act(async () => {
    button.click();
    // Allow the microtask queue to run for async save
    await new Promise(r => setTimeout(r, 0));
  });
}

test("Case 1: a new save clears previous success feedback and fails with only error notice visible", async () => {
  let saveCount = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.endsWith("/api/advisor/settings") && init?.method === "PUT") {
      saveCount += 1;
      if (saveCount === 1) {
        return new Response(
          JSON.stringify({
            settings: { ...initialSettings, model: "expert/gpt-first" },
            runnable: true,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify({ error: { message: "Simulated save failure" } }),
        { status: 500, headers: { "Content-Type": "application/json" } },
      );
    }
    return new Response(null, { status: 404 });
  }) as typeof fetch;

  const { root, container } = await mountEditor();

  // Save 1: succeeds
  await setModel(container, "expert/gpt-first");
  await clickSave(container);

  expect(container.querySelector(".notice-ok")?.textContent).toContain("Advisor settings saved.");
  expect(container.querySelector(".notice-err")).toBeNull();

  // Save 2: started before 2500ms and fails
  await setModel(container, "expert/gpt-second");
  await clickSave(container);

  // Success notice must be cleared immediately when save 2 starts; only error notice visible
  expect(container.querySelector(".notice-ok")).toBeNull();
  expect(container.querySelector(".notice-err")?.textContent).toContain("Simulated save failure");

  await act(async () => {
    root.unmount();
  });
});

test("Case 2: a second save before timer 1 expires cancels timer 1 and keeps its own feedback active", async () => {
  let currentModel = initialSettings.model;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.endsWith("/api/advisor/settings") && init?.method === "PUT") {
      const parsed = JSON.parse(init.body as string);
      currentModel = parsed.model;
      return new Response(
        JSON.stringify({
          settings: { ...initialSettings, model: currentModel },
          runnable: true,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    return new Response(null, { status: 404 });
  }) as typeof fetch;

  const { root, container } = await mountEditor();

  // Save 1 at t=0
  await setModel(container, "expert/model-1");
  await clickSave(container);
  expect(container.querySelector(".notice-ok")?.textContent).toContain("Advisor settings saved.");

  // Advance 1000ms
  await act(async () => {
    await new Promise(r => setTimeout(r, 1000));
  });
  expect(container.querySelector(".notice-ok")).not.toBeNull();

  // Save 2 at t=1000ms
  await setModel(container, "expert/model-2");
  await clickSave(container);
  expect(container.querySelector(".notice-ok")?.textContent).toContain("Advisor settings saved.");

  // Advance 1600ms (total elapsed 2600ms; timer 1 would have expired at 2500ms)
  await act(async () => {
    await new Promise(r => setTimeout(r, 1600));
  });
  // Timer 1 must NOT have cleared save 2's feedback!
  expect(container.querySelector(".notice-ok")?.textContent).toContain("Advisor settings saved.");

  // Advance another 1000ms (total elapsed from save 2 is 2600ms > 2500ms)
  await act(async () => {
    await new Promise(r => setTimeout(r, 1000));
  });
  // Now timer 2 has expired and notice is cleared
  expect(container.querySelector(".notice-ok")).toBeNull();

  await act(async () => {
    root.unmount();
  });
});

test("Case 3: component unmount with a pending timer cleans up without post-unmount effects", async () => {
  globalThis.fetch = (async () => {
    return new Response(
      JSON.stringify({
        settings: { ...initialSettings, model: "expert/gpt-unmount" },
        runnable: true,
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }) as typeof fetch;

  const { root, container } = await mountEditor();

  await setModel(container, "expert/gpt-unmount");
  await clickSave(container);
  expect(container.querySelector(".notice-ok")).not.toBeNull();

  // Unmount while 2500ms timer is pending
  await act(async () => {
    root.unmount();
  });

  // Advance time past the 2500ms timeout
  await act(async () => {
    await new Promise(r => setTimeout(r, 2600));
  });

  // No error thrown and unmount cleanup succeeded
});
