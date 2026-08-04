/** @jsxImportSource react */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { LanguageProvider } from "../src/i18n/provider";
import { clearClientResourceStoresForTests } from "../src/client-resource";
import ApiKeys from "../src/pages/ApiKeys";

// Delete and rename hold the detail pane's navigation lock while they run. A
// connection that accepts the request and then never answers used to leave the
// rail, Back, and Overview disabled with no way out but a reload.

const originalFetch = globalThis.fetch;
let restoreGlobals: (() => void) | undefined;
let previousLanguageDescriptor: PropertyDescriptor | undefined;
let previousAbortTimeout: PropertyDescriptor | undefined;
let testWindow: Window;

const AUTH_MATRIX = [
  { endpoint: "/v1/responses", bearer: "rejected", dedicated: "required", xApiKey: "rejected" },
  { endpoint: "/v1/models", bearer: "accepted", dedicated: "accepted", xApiKey: "accepted" },
];

const KEYS_OK = {
  keys: [
    { id: "key-1", name: "alpha", prefix: "ocx_data_aaaaaaaa...", createdAt: "2026-01-15T12:00:00.000Z",
      usage: { requests7d: 3, totalRequests: 8 } },
    { id: "key-2", name: "beta", prefix: "ocx_data_bbbbbbbb...", createdAt: "2026-01-16T12:00:00.000Z",
      usage: { requests7d: 0, totalRequests: 0 } },
  ],
  attributionSince: "2026-07-20T00:00:00.000Z",
  authMatrix: AUTH_MATRIX,
  baseUrl: "http://127.0.0.1:10100/v1",
  endpoint: "http://127.0.0.1:10100/v1/responses",
  claudeCodeEnabled: true,
};

beforeEach(() => {
  clearClientResourceStoresForTests();
  testWindow = new Window({ url: "http://localhost/" });
  previousLanguageDescriptor = Object.getOwnPropertyDescriptor(globalThis.navigator, "language");
  Object.defineProperty(globalThis.navigator, "language", { configurable: true, value: "en-US" });
  // Shorten the fuse rather than the wiring. `createBoundedFetch` still runs,
  // still builds the combined signal, and the page still has to pass it to
  // `fetch` — waiting the real 15s would only prove the clock works, at the
  // price of half a minute on every suite run. The timer itself is covered in
  // tests/bounded-fetch.test.ts.
  previousAbortTimeout = Object.getOwnPropertyDescriptor(AbortSignal, "timeout");
  Object.defineProperty(AbortSignal, "timeout", {
    configurable: true,
    value: (ms: number) => {
      expect(ms).toBe(15_000);
      const controller = new AbortController();
      setTimeout(() => controller.abort(new DOMException("TimeoutError", "TimeoutError")), 30);
      return controller.signal;
    },
  });
  const keys = ["document", "window", "localStorage", "IS_REACT_ACT_ENVIRONMENT"] as const;
  const previous = Object.fromEntries(
    keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
  ) as Record<(typeof keys)[number], PropertyDescriptor | undefined>;
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: testWindow.document },
    window: { configurable: true, value: testWindow },
    localStorage: { configurable: true, value: testWindow.localStorage },
    IS_REACT_ACT_ENVIRONMENT: { configurable: true, value: true },
  });
  restoreGlobals = () => {
    for (const key of keys) {
      const descriptor = previous[key];
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete (globalThis as Record<string, unknown>)[key];
    }
    if (previousLanguageDescriptor) {
      Object.defineProperty(globalThis.navigator, "language", previousLanguageDescriptor);
    } else {
      delete (globalThis.navigator as { language?: string }).language;
    }
  };
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  clearClientResourceStoresForTests();
  restoreGlobals?.();
  testWindow.close();
  if (previousAbortTimeout) Object.defineProperty(AbortSignal, "timeout", previousAbortTimeout);
});

async function tick(ms = 0): Promise<void> {
  await act(async () => {
    await new Promise<void>(resolve => testWindow.setTimeout(resolve, ms));
    await Promise.resolve();
  });
}

/** A mutation that is accepted and then abandoned; only the abort signal ends it. */
function installStallingFetch(seen: { aborted: boolean }): void {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    if (url.endsWith("/v1/models")) return Response.json({ data: [] });
    if (url.endsWith("/api/keys") && method === "GET") return Response.json(KEYS_OK);
    return new Promise((_resolve, reject) => {
      const signal = init?.signal;
      signal?.addEventListener("abort", () => {
        seen.aborted = true;
        reject(new DOMException("The operation was aborted.", "AbortError"));
      });
    });
  }) as typeof fetch;
}

async function mountPage(): Promise<{ container: HTMLDivElement; root: Root }> {
  const container = testWindow.document.createElement("div") as unknown as HTMLDivElement;
  testWindow.document.body.appendChild(container);
  const { createRoot } = await import("react-dom/client");
  let root!: Root;
  await act(async () => {
    root = createRoot(container);
    root.render(
      <LanguageProvider>
        <ApiKeys apiBase="http://localhost" />
      </LanguageProvider>,
    );
  });
  await tick();
  return { container, root };
}

/**
 * Retargeted from the workspace rail to the key table: the rail was replaced by a
 * pinned section strip plus a table in the Keys section. The contract these tests
 * protect — navigation locks while a mutation is in flight and unlocks after it
 * settles — is unchanged; only the control that navigates moved.
 */
function railRows(container: HTMLDivElement): HTMLButtonElement[] {
  return [...container.querySelectorAll<HTMLButtonElement>(".awi-keylist-name")];
}

/**
 * The control that leaves the open key. With the rail gone the key table is not
 * rendered beside the detail pane, so "is navigation locked?" is asked of Back —
 * the only way out of a detail view — instead of a list of sibling rows. Asking
 * the old way would have been vacuous: an empty node list makes `every` true and
 * `some` false regardless of the lock.
 */
function backButton(container: HTMLDivElement): HTMLButtonElement {
  return [...container.querySelectorAll<HTMLButtonElement>("button")]
    .find(button => button.textContent?.includes("Back"))!;
}

async function openKey(container: HTMLDivElement, name: string): Promise<void> {
  const row = railRows(container).find(candidate => candidate.textContent?.includes(name));
  expect(row).toBeTruthy();
  await act(async () => { row!.click(); });
  await tick();
}

test("a delete that never answers gives navigation back instead of locking it", async () => {
  const seen = { aborted: false };
  installStallingFetch(seen);
  const { container, root } = await mountPage();
  try {
    await openKey(container, "alpha");

    const del = [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find(button => button.textContent?.includes("Delete key"));
    expect(del).toBeTruthy();
    await act(async () => { del!.click(); });
    await tick(320);
    const confirm = [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find(button => button.textContent?.includes("Confirm"));
    await act(async () => { confirm!.click(); });
    await tick();

    // While it is in flight the lock is correct: another key must not receive
    // the result of this one.
    expect(backButton(container).disabled).toBe(true);

    // The bound fires and the page is usable again — no reload required.
    await tick(120);
    await tick();

    expect(seen.aborted).toBe(true);
    expect(backButton(container).disabled).toBe(false);
    // A timed-out delete is not a confirmed delete, so the pane stays on the
    // key it was about rather than claiming success.
    expect(container.textContent).toContain("alpha");
  } finally {
    await act(async () => { root.unmount(); });
  }
});

test("a rename that never answers releases the lock and keeps the draft", async () => {
  const seen = { aborted: false };
  installStallingFetch(seen);
  const { container, root } = await mountPage();
  try {
    await openKey(container, "alpha");

    const rename = [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find(button => button.textContent?.trim() === "Rename");
    expect(rename).toBeTruthy();
    await act(async () => { rename!.click(); });
    await tick();

    const input = container.querySelector<HTMLInputElement>(".awi-rename input");
    expect(input).toBeTruthy();
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        testWindow.HTMLInputElement.prototype, "value",
      )!.set!;
      setter.call(input!, "renamed-draft");
      input!.dispatchEvent(new testWindow.Event("input", { bubbles: true }));
    });
    const save = [...container.querySelectorAll<HTMLButtonElement>(".awi-rename button")]
      .find(button => !button.textContent?.includes("Cancel"));
    await act(async () => { save!.click(); });
    await tick();

    expect(backButton(container).disabled).toBe(true);

    await tick(120);
    await tick();

    expect(seen.aborted).toBe(true);
    expect(backButton(container).disabled).toBe(false);
    // What was typed survives the failure; retyping it would be the second
    // penalty for one dropped connection.
    expect(container.querySelector<HTMLInputElement>(".awi-rename input")?.value).toBe("renamed-draft");
  } finally {
    await act(async () => { root.unmount(); });
  }
});
