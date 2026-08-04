/** @jsxImportSource react */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import ApiKeysWorkspace, { type ApiKeysWorkspaceProps } from "../src/components/apikeys-workspace/ApiKeysWorkspace";
import { LanguageProvider } from "../src/i18n/provider";
import type { ApiEndpointInfo } from "../src/pages/api-keys-utils";

// Phase 4 of the API tab unit: rename, the delete that waits for its own
// request, and the zero-vs-unavailable attribution distinction.

const endpoints: ApiEndpointInfo = {
  baseUrl: "http://127.0.0.1:10100/v1",
  responses: "http://127.0.0.1:10100/v1/responses",
  chatCompletions: "http://127.0.0.1:10100/v1/chat/completions",
  messages: "http://127.0.0.1:10100/v1/messages",
  models: "http://127.0.0.1:10100/v1/models",
};

const AUTH_MATRIX = [
  { endpoint: "/v1/responses", bearer: "rejected", dedicated: "required", xApiKey: "rejected" },
  { endpoint: "/v1/models", bearer: "accepted", dedicated: "accepted", xApiKey: "accepted" },
] as const;

const globals = ["document", "window", "navigator", "localStorage", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previousGlobals: Record<(typeof globals)[number], unknown>;
let testWindow: Window;
let active: Root | null = null;

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

afterEach(async () => {
  if (active) {
    const root = active;
    active = null;
    await act(async () => { root.unmount(); });
  }
  testWindow.close();
  for (const key of globals) {
    Object.defineProperty(globalThis, key, { configurable: true, value: previousGlobals[key] });
  }
});

async function mount(props: Partial<ApiKeysWorkspaceProps>): Promise<HTMLDivElement> {
  // Use the GLOBAL document (which beforeEach points at testWindow): React reads
  // globals, so a container created off the raw window object is not the same
  // document it renders into, and synthetic input events never reach it.
  const container = document.createElement("div");
  document.body.append(container);
  const value: ApiKeysWorkspaceProps = {
    keys: [{
      id: "k1",
      name: "alpha",
      prefix: "ocx_data_aaaaaaaa...",
      createdAt: "2026-01-01T00:00:00.000Z",
      usage: { requests7d: 0, totalRequests: 0 },
    }],
    attributionSince: "2026-07-01T00:00:00.000Z",
    authMatrix: [...AUTH_MATRIX],
    keysLoading: false,
    keysLoadFailed: false,
    endpoints,
    claudeCodeEnabled: true,
    newName: "",
    creating: false,
    newKey: null,
    copied: false,
    filteredModels: [],
    modelsLoading: false,
    modelsLoadFailed: false,
    modelCount: 0,
    hasModelData: true,
    modelQuery: "",
    copiedModelId: null,
    modelTests: {},
    canTestModels: false,
    onNewNameChange: () => {},
    onCreate: () => {},
    onDismissNewKey: () => {},
    onCopyKey: () => {},
    onDelete: async () => true,
    onRename: async () => true,
    onModelQueryChange: () => {},
    onRetryModels: () => {},
    onCopyModelId: () => {},
    onTestModel: () => {},
    sourceLabel: () => "proxy",
    protocolLabel: p => p,
    ...props,
  };
  // Import AFTER beforeEach installed the globals: a module-level import binds
  // react-dom to whatever document existed at load time, and synthetic events
  // then never reach the tree React actually rendered into.
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(container);
  active = root;
  await act(async () => { root.render(<LanguageProvider><ApiKeysWorkspace {...value} /></LanguageProvider>); });
  return container;
}

/** React tracks the last value it wrote; set through the prototype so the
 *  synthetic change event is not swallowed as a no-op. */
async function typeInto(input: HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    // React caches the last value it wrote on an internal tracker. Setting the
    // property alone leaves that tracker holding the SAME value, so React treats
    // the event as a no-op and never calls onChange. Resetting the tracker is
    // what makes a synthetic edit look like a real one.
    const proto = Object.getPrototypeOf(input) as object;
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(input, value);
    (input as unknown as { _valueTracker?: { setValue(v: string): void } })._valueTracker?.setValue("");
    input.dispatchEvent(new testWindow.Event("input", { bubbles: true }) as never);
  });
}

const button = (c: HTMLElement, text: string): HTMLButtonElement =>
  [...c.querySelectorAll("button")].find(b => b.textContent?.trim() === text)!;



async function openKey(container: HTMLElement): Promise<void> {
  await act(async () => {
    [...container.querySelectorAll("button")].find(b => b.textContent?.includes("alpha"))!.click();
  });
}

test("the rename editor opens with the current name and the server's length cap", async () => {
  const container = await mount({});
  await openKey(container);
  await act(async () => { button(container, "Rename").click(); });

  const input = container.querySelector<HTMLInputElement>("#awi-key-name")!;
  // Seeded from the key so a small correction does not mean retyping the name.
  expect(input.value).toBe("alpha");
  // The server rejects anything longer; the GUI must not accept it either.
  expect(input.maxLength).toBe(64);

  // Cancel leaves the pane intact and the name untouched.
  await act(async () => { button(container, "Cancel").click(); });
  expect(container.querySelector("#awi-key-name")).toBeNull();
  expect(container.textContent).toContain("Key details");
});

test("rename is pessimistic: pending locks, failure keeps the draft, success closes", async () => {
  let settle!: (ok: boolean) => void;
  const calls: Array<[string, string]> = [];
  const container = await mount({
    onRename: (id, name) => {
      calls.push([id, name]);
      return new Promise<boolean>(resolve => { settle = resolve; });
    },
  });
  await openKey(container);
  await act(async () => { button(container, "Rename").click(); });

  const input = container.querySelector<HTMLInputElement>("#awi-key-name")!;
  expect(input.value).toBe("alpha");           // seeded, so a fix is not a retype
  expect(input.maxLength).toBe(64);            // matches the server's own limit
  await typeInto(input, "renamed");
  await act(async () => { button(container, "Save name").click(); });

  // In flight: the typed name went out, and the controls lock so a second
  // submit cannot race the first.
  expect(calls).toEqual([["k1", "renamed"]]);
  expect(container.querySelector<HTMLInputElement>("#awi-key-name")!.disabled).toBe(true);

  // Rejected: the editor, the draft and a local error all survive.
  await act(async () => { settle(false); await Promise.resolve(); });
  const afterFailure = container.querySelector<HTMLInputElement>("#awi-key-name")!;
  expect(afterFailure.value).toBe("renamed");
  expect(afterFailure.disabled).toBe(false);
  expect(container.querySelector(".awi-rename-error")).not.toBeNull();

  // Accepted: only now does the editor close.
  await act(async () => { button(container, "Save name").click(); });
  await act(async () => { settle(true); await Promise.resolve(); });
  expect(container.querySelector("#awi-key-name")).toBeNull();
  expect(container.textContent).toContain("Key details");
});

test("delete waits for its own request before leaving the pane", async () => {
  let settle!: (ok: boolean) => void;
  const container = await mount({
    onDelete: () => new Promise<boolean>(resolve => { settle = resolve; }),
  });
  await openKey(container);
  await act(async () => {
    [...container.querySelectorAll("button")].find(b => b.textContent?.includes("Delete key"))!.click();
  });
  await act(async () => { await new Promise(r => setTimeout(r, 350)); });
  await act(async () => { button(container, "Confirm").click(); });

  // Pending: still on the key, and the confirm is locked.
  expect(container.textContent).toContain("Key details");
  expect(button(container, "Deleting…")).toBeTruthy();

  // Rejected: the pane stays, so the error is not orphaned from its key.
  await act(async () => { settle(false); await Promise.resolve(); });
  expect(container.textContent).toContain("Key details");

  // Accepted: now it returns to the overview.
  await act(async () => { button(container, "Confirm").click(); });
  await act(async () => { settle(true); await Promise.resolve(); });
  expect(container.textContent).toContain("Generate key");
  expect(container.textContent).not.toContain("Key details");
});

test("a failed delete keeps the detail pane open", async () => {
  const container = await mount({ onDelete: async () => false });
  await openKey(container);
  await act(async () => {
    [...container.querySelectorAll("button")].find(b => b.textContent?.includes("Delete key"))!.click();
  });
  await act(async () => { await new Promise(r => setTimeout(r, 350)); });
  await act(async () => { button(container, "Confirm").click(); });

  // Navigating away on failure left the error detached from the key it was about.
  expect(container.textContent).toContain("Key details");
  expect(container.textContent).not.toContain("Generate key");
});

// One chip click per protocol, checked against the requests that really left
// `fetch`, lives in tests/apikeys-model-test-wire.test.tsx. Asserting it here
// would mean supplying `onTestModel` from the test, which only proves the test
// agrees with itself. What belongs here is the presentation contract below.

test("without a fresh key the protocol chips are disabled, not silently passing", async () => {
  const container = await mount({
    filteredModels: [{ id: "gpt-5.4", displayName: "gpt-5.4", provider: "openai", native: true }],
    modelCount: 1,
    canTestModels: false,
  });
  const chips = [...container.querySelectorAll(".api-model-test-chip button")] as HTMLButtonElement[];
  expect(chips.length).toBeGreaterThan(0);
  // On loopback an unauthenticated test passes whether or not the key works,
  // which is the one thing this button is supposed to prove.
  expect(chips.every(c => c.disabled)).toBe(true);
  expect(chips.every(c => (c.getAttribute("title") ?? "").length > 0)).toBe(true);
});

test("a protocol result belongs to its own chip", async () => {
  const container = await mount({
    filteredModels: [{ id: "gpt-5.4", displayName: "gpt-5.4", provider: "openai", native: true }],
    modelCount: 1,
    canTestModels: true,
    modelTests: { "gpt-5.4": { chat: { state: "error", detail: "boom" } } },
  });
  const notes = [...container.querySelectorAll(".api-test-note")];
  // Exactly one result rendered, announced, and attached to the chat chip only.
  expect(notes).toHaveLength(1);
  expect(notes[0]!.textContent).toContain("boom");
  expect(notes[0]!.getAttribute("role")).toBe("status");
  expect(notes[0]!.getAttribute("aria-live")).toBe("polite");
});

test("a failed delete reports beside the key, and the error does not follow the user", async () => {
  const container = await mount({
    keys: [
      { id: "k1", name: "alpha", prefix: "ocx_data_aaaaaaaa...", createdAt: "2026-01-01T00:00:00.000Z",
        usage: { requests7d: 0, totalRequests: 0 } },
      { id: "k2", name: "beta", prefix: "ocx_data_bbbbbbbb...", createdAt: "2026-01-02T00:00:00.000Z",
        usage: { requests7d: 0, totalRequests: 0 } },
    ],
    onDelete: async () => false,
  });
  await openKey(container);
  await act(async () => {
    [...container.querySelectorAll("button")].find(b => b.textContent?.includes("Delete key"))!.click();
  });
  await act(async () => { await new Promise(r => setTimeout(r, 350)); });
  await act(async () => { button(container, "Confirm").click(); });

  const error = container.querySelector(".awi-delete-error");
  expect(error).not.toBeNull();
  expect(error!.getAttribute("role")).toBe("alert");

  // Selecting another key must not inherit the previous key's failure. With the
  // rail gone the key list is not beside the detail pane, so reaching another
  // key goes back to the overview first — the same journey a user now makes.
  await act(async () => {
    [...container.querySelectorAll<HTMLButtonElement>("button")].find(b => b.textContent?.includes("Back"))!.click();
  });
  await act(async () => {
    [...container.querySelectorAll<HTMLButtonElement>(".awi-keylist-name")].find(b => b.textContent === "beta")!.click();
  });
  expect(container.querySelector(".awi-delete-error")).toBeNull();
});

test("a pending mutation cannot land its result on another key", async () => {
  let settle!: (ok: boolean) => void;
  const container = await mount({
    keys: [
      { id: "k1", name: "alpha", prefix: "ocx_data_aaaaaaaa...", createdAt: "2026-01-01T00:00:00.000Z",
        usage: { requests7d: 0, totalRequests: 0 } },
      { id: "k2", name: "beta", prefix: "ocx_data_bbbbbbbb...", createdAt: "2026-01-02T00:00:00.000Z",
        usage: { requests7d: 0, totalRequests: 0 } },
    ],
    onDelete: () => new Promise<boolean>(resolve => { settle = resolve; }),
  });
  await openKey(container);
  await act(async () => {
    [...container.querySelectorAll("button")].find(b => b.textContent?.includes("Delete key"))!.click();
  });
  await act(async () => { await new Promise(r => setTimeout(r, 350)); });
  await act(async () => { button(container, "Confirm").click(); });

  // Mid-flight, navigation is locked: otherwise alpha's outcome would land on
  // whichever key the user wandered to. Back is the way out of the detail pane,
  // so it is the control the lock has to hold.
  const back = () => [...container.querySelectorAll<HTMLButtonElement>("button")]
    .find(b => b.textContent?.includes("Back"))!;
  expect(back().disabled).toBe(true);
  await act(async () => { back().click(); });
  expect(container.textContent).toContain("alpha");

  await act(async () => { settle(false); await Promise.resolve(); });
  // Only now can the user move, and the error stays with the key it belongs to.
  expect(container.querySelector(".awi-delete-error")).not.toBeNull();
  expect(back().disabled).toBe(false);
});

test("zero usage and unavailable attribution read differently", async () => {
  const live = await mount({});
  await openKey(live);
  // A live dataset with a zero counter: the key really was used zero times.
  expect(live.textContent).toContain("Total attributed requests");
  expect(live.textContent).toContain("Not used since attribution began");
  expect(live.textContent).not.toContain("No usage has been attributed yet");

  await act(async () => { active!.unmount(); });
  active = null;

  const empty = await mount({ attributionSince: undefined });
  await openKey(empty);
  // Same zero counters, but nothing is attributable — a different statement.
  expect(empty.textContent).toContain("No usage has been attributed yet");
  expect(empty.textContent).not.toContain("Total attributed requests");
});

test("a duplicate-id key reports ambiguity instead of a number", async () => {
  const container = await mount({
    keys: [{
      id: "dup",
      name: "alpha",
      prefix: "ocx_data_dddddddd...",
      createdAt: "2026-01-01T00:00:00.000Z",
      usage: { ambiguous: true },
    }],
  });
  await openKey(container);
  expect(container.textContent).toContain("Two keys share this ID");
  expect(container.textContent).not.toContain("Total attributed requests");
});

test("the auth matrix renders the server's rows, in the server's order", async () => {
  const container = await mount({});
  const rows = [...container.querySelectorAll(".api-auth-matrix tbody tr")];
  expect(rows).toHaveLength(2);
  expect(rows[0]!.textContent).toContain("/v1/responses");
  expect(rows[0]!.textContent).toContain("Required");
  expect(rows[1]!.textContent).toContain("/v1/models");
  // The rule the old prose got wrong: bearer is NOT accepted on Responses.
  expect(rows[0]!.textContent).toContain("Not accepted");
  // And it is not hidden behind a disclosure any more.
  expect(container.querySelector(".api-auth-matrix")!.closest("details")).toBeNull();
});
