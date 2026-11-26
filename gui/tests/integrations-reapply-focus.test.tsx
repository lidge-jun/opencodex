import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { setClientResourceData } from "../src/client-resource";
import { LanguageProvider } from "../src/i18n/provider";
import IntegrationsOverview from "../src/pages/integrations/IntegrationsOverview";

const globals = [
  "document",
  "window",
  "navigator",
  "localStorage",
  "sessionStorage",
  "fetch",
  "IS_REACT_ACT_ENVIRONMENT",
] as const;

let previousGlobals: Record<(typeof globals)[number], PropertyDescriptor | undefined>;
let testWindow: Window;
let container: HTMLElement;
let root: Root | null = null;
let mountCount = 0;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function hermesStatus(state: "stale" | "current") {
  return {
    clientId: "hermes" as const,
    state,
    installed: true,
    configPath: "/tmp/home/.hermes/config.yaml",
    snapshotCount: 1,
    retentionDegraded: false,
  };
}

function applyPlan() {
  return {
    version: 1,
    clientId: "hermes",
    operation: "apply",
    state: "stale",
    foreignEdit: "none",
    changes: [
      { kind: "replace", path: "providers.opencodex" },
      { kind: "snapshot", path: "$snapshot" },
      { kind: "ownership", path: "$ownership" },
      { kind: "journal", path: "$journal" },
    ],
    fingerprint: `p1:${"1".repeat(32)}`,
    canApply: true,
    willChange: true,
  };
}

beforeEach(() => {
  previousGlobals = Object.fromEntries(
    globals.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
  ) as typeof previousGlobals;
  testWindow = new Window({ url: "http://localhost/#integrations" });
  Object.defineProperty(testWindow.navigator, "language", { configurable: true, value: "en-US" });
  Object.defineProperties(globalThis, {
    document: { configurable: true, writable: true, value: testWindow.document },
    window: { configurable: true, writable: true, value: testWindow },
    navigator: { configurable: true, writable: true, value: testWindow.navigator },
    localStorage: { configurable: true, writable: true, value: testWindow.localStorage },
    sessionStorage: { configurable: true, writable: true, value: testWindow.sessionStorage },
    IS_REACT_ACT_ENVIRONMENT: { configurable: true, writable: true, value: true },
  });
  container = testWindow.document.createElement("div") as unknown as HTMLElement;
  testWindow.document.body.appendChild(container as never);
});

afterEach(async () => {
  if (root) {
    const current = root;
    await act(async () => { current.unmount(); });
    root = null;
  }
  testWindow.close();
  for (const key of globals) {
    const descriptor = previousGlobals[key];
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

test("a completed file reapply restores focus to the card title when its trigger was removed while the dialog was open", async () => {
  mountCount += 1;
  const apiBase = `http://ocx-reapply-focus-${mountCount}.invalid`;
  let hermesState: "stale" | "current" = "stale";
  let resolvePut: ((response: Response) => void) | null = null;

  const mockFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const method = (init?.method ?? "GET").toUpperCase();
    if (url.endsWith("/api/client-integrations/preview")) return json(applyPlan());
    if (url.includes("/journal")) return json({ operations: [] });
    if (url.includes("/api/startup-health")) return json({ routingInjected: false, status: "native", recommendedCommand: null });
    if (url.includes("/api/keys")) return json({ keys: [] });
    if (url.includes("/api/claude-desktop/status")) {
      return json({ desiredEnabled: false, installed: false, observedKind: "absent", applied: false, stale: false, activeProfile: null, appliedAt: null });
    }
    if (url.includes("/api/native-integrations")) return json({ clients: [] });
    if (url.includes("/api/claude-code")) return json({ enabled: false });
    if (url.includes("/api/grok")) return json({ present: false, models: [] });
    if (method === "PUT") return new Promise<Response>(resolve => { resolvePut = resolve; });
    return json({ clients: [hermesStatus(hermesState)] });
  }) as typeof fetch;
  Object.defineProperty(globalThis, "fetch", { configurable: true, value: mockFetch });
  Object.defineProperty(testWindow, "fetch", { configurable: true, value: mockFetch });

  const { createRoot } = await import("react-dom/client");
  await act(async () => {
    root = createRoot(container);
    root.render(<LanguageProvider><IntegrationsOverview apiBase={apiBase} active /></LanguageProvider>);
  });
  await act(async () => { await new Promise<void>(resolve => testWindow.setTimeout(resolve, 30)); });

  const card = () => container.querySelector(".integration-card[data-client='hermes']")!;
  const pill = () => card().querySelector<HTMLButtonElement>("button.integration-badge-action");
  const trigger = pill()!;
  expect(trigger.textContent?.trim()).toBe("Update needed");

  // Cancelling while the card is still stale returns focus to the pill and leaves it actionable.
  await act(async () => { trigger.focus(); trigger.click(); });
  await act(async () => { await new Promise<void>(resolve => testWindow.setTimeout(resolve, 30)); });
  const closeBtn = Array.from(container.querySelectorAll<HTMLButtonElement>(".integration-consequence-dialog button"))
    .find(button => (button.textContent ?? "").trim() === "Close")!;
  await act(async () => { closeBtn.click(); });
  expect(container.querySelector(".integration-consequence-dialog")).toBeNull();
  expect(trigger.isConnected).toBe(true);
  expect(testWindow.document.activeElement).toBe(trigger as never);

  // Re-open via the pill, then let a status read remove the pill before the apply PUT finishes.
  await act(async () => { pill()!.focus(); pill()!.click(); });
  await act(async () => { await new Promise<void>(resolve => testWindow.setTimeout(resolve, 30)); });
  const dialog = container.querySelector(".integration-consequence-dialog")!;
  const confirmBtn = dialog.querySelector<HTMLButtonElement>(".modal-actions .btn-primary")!;
  await act(async () => { confirmBtn.focus(); confirmBtn.click(); });

  hermesState = "current";
  await act(async () => {
    setClientResourceData(`integration-states:${apiBase}`, [hermesStatus("current")]);
  });
  expect(trigger.isConnected).toBe(false);
  expect(pill()).toBeNull();
  expect(dialog.contains(testWindow.document.activeElement as never)).toBe(true);

  expect(resolvePut).not.toBeNull();
  await act(async () => {
    resolvePut!(json({ ok: true, clientId: "hermes", changed: true, state: "current", message: "applied" }));
  });
  await act(async () => { await new Promise<void>(resolve => testWindow.setTimeout(resolve, 30)); });
  expect(container.querySelector(".integration-consequence-dialog")).toBeNull();
  expect(testWindow.document.activeElement).toBe(card().querySelector(".integration-card-link") as never);
});
