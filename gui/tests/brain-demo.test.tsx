import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";

import { clearClientResourceStoresForTests } from "../src/client-resource";
import { LanguageProvider } from "../src/i18n/provider";
import DemoController from "../src/pages/DemoController";

const originalFetch = globalThis.fetch;
const domGlobals = ["document", "window", "navigator", "localStorage", "sessionStorage", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previousGlobals: Record<(typeof domGlobals)[number], PropertyDescriptor | undefined>;
let testWindow: Window;
let container: HTMLElement;
let root: Root | null = null;

beforeEach(() => {
  clearClientResourceStoresForTests();
  previousGlobals = Object.fromEntries(
    domGlobals.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
  ) as typeof previousGlobals;
  testWindow = new Window({ url: "http://localhost/#demo" });
  testWindow.localStorage.setItem("ocx-lang", "en");
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: testWindow.document },
    window: { configurable: true, value: testWindow },
    navigator: { configurable: true, value: testWindow.navigator },
    localStorage: { configurable: true, value: testWindow.localStorage },
    sessionStorage: { configurable: true, value: testWindow.sessionStorage },
    IS_REACT_ACT_ENVIRONMENT: { configurable: true, value: true },
  });
  container = testWindow.document.createElement("div") as unknown as HTMLElement;
  testWindow.document.body.appendChild(container as never);

  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    if (url.endsWith("/api/agent-os/projects")) {
      if (init?.method === "POST") {
        return Response.json({ project: { id: "proj_demo", name: "Smart Factory Pack", rootPath: "./demo", scanEnabled: true, scanMode: "standard" } }, { status: 201 });
      }
      return Response.json({ projects: [{ id: "proj_demo", name: "Smart Factory Pack", rootPath: "./demo", scanEnabled: true, scanMode: "standard" }] });
    }
    if (url.endsWith("/api/agent-os/tasks")) return Response.json({ tasks: [{ id: "t1", kind: "render", title: "Render smart factory", status: "succeeded", attempts: 1, error: null }] });
    if (url.endsWith("/api/agent-os/permits/pending")) return Response.json({ approvals: [{ id: "a1", capability: "deploy", reason: "released", status: "pending", requestedMs: 1 }] });
    if (url.includes("/api/agent-os/audit")) {
      const events = [
        { tool: "generate_stock_ideas", actor: "agent-demo", result: "success" },
        { tool: "start_render_job", actor: "agent-demo", result: "success" },
      ];
      return Response.json({ events });
    }
    return Response.json({ error: "not found" }, { status: 404 });
  }) as typeof fetch;
});

afterEach(async () => {
  if (root) {
    await act(async () => root?.unmount());
    root = null;
  }
  globalThis.fetch = originalFetch;
  clearClientResourceStoresForTests();
  for (const key of domGlobals) {
    const descriptor = previousGlobals[key];
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
  await testWindow.happyDOM?.close?.();
});

async function mount(): Promise<void> {
  const { createRoot } = await import("react-dom/client");
  await act(async () => {
    root = createRoot(container);
    root.render(
      <LanguageProvider>
        <DemoController apiBase="" />
      </LanguageProvider>,
    );
  });
}

async function waitFor(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error("waitFor timed out");
    await new Promise<void>((resolve) => testWindow.setTimeout(resolve, 5));
  }
}

test("demo controller shows scenario status, project, approvals and actions", async () => {
  await mount();
  await waitFor(() => (container.textContent?.includes("Smart Factory") ?? false) && container.textContent?.includes("pending approval") === true);
  expect(container.querySelector(".demo-step")).not.toBeNull();
  expect(container.textContent).toContain("Smart Factory Pack");
  expect(container.textContent).toContain("pending approval");
  const buttons = [...container.querySelectorAll<HTMLButtonElement>("button")].map((button) => button.textContent ?? "");
  expect(buttons.some((text) => text.includes("Reset"))).toBe(true);
  expect(buttons.some((text) => text.includes("Load"))).toBe(true);
});

test("demo controller shows agent activity from audit trail", async () => {
  await mount();
  await waitFor(() => container.textContent?.includes("generate_stock_ideas") ?? false);
  expect(container.textContent).toContain("generate_stock_ideas");
  expect(container.textContent).toContain("start_render_job");
});
