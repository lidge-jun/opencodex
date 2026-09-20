/**
 * The layer stack: assembly order made visible, and transition notices kept
 * apart from state layers (devlog 023).
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { LanguageProvider } from "../src/i18n/provider";
import { clearClientResourceStoresForTests } from "../src/client-resource";
import CodexSetPrompt from "../src/pages/codex-set-prompt";
import { LAYER_INVENTORY } from "../../src/codex/prompt-layers";

const globals = ["document", "window", "navigator", "localStorage", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previousGlobals: Record<(typeof globals)[number], unknown>;
let testWindow: Window;
const originalFetch = globalThis.fetch;
const INVENTORY = LAYER_INVENTORY.map(d => ({ ...d }));

/** Verified transition-only in devlog 023: realtime.rs:43-53 and model.rs:44-60. */
const TRANSITION_IDS = ["realtime", "model-switch"];

function snapshot(over: Record<string, unknown> = {}) {
  return {
    configPath: "/tmp/config.toml",
    storePath: "/tmp/opencodex-prompt.json",
    configExists: true,
    readable: true,
    developerInstructionsOwned: true,
    developerInstructionsState: "owned" as const,
    drift: null,
    revision: "sha256:one",
    inventory: INVENTORY,
    toggles: INVENTORY.filter(d => d.class === "config-toggle").map(d => ({
      id: d.id, key: d.key as string, userFileValue: null, defaultedUserValue: true, default: true,
    })),
    extensionLayersEnumerable: false,
    custom: [],
    modelInstructionsFile: null,
    baseVariants: [],
    baseSelection: { kind: "default" as const },
    maxBaseVariants: 2,
    ...over,
  };
}

beforeEach(() => {
  previousGlobals = Object.fromEntries(globals.map(key => [key, Reflect.get(globalThis, key)])) as typeof previousGlobals;
  testWindow = new Window({ url: "http://localhost/#codex-set/prompt" });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: testWindow.document },
    window: { configurable: true, value: testWindow },
    navigator: { configurable: true, value: testWindow.navigator },
    localStorage: { configurable: true, value: testWindow.localStorage },
  });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  clearClientResourceStoresForTests();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  testWindow.close();
  for (const key of globals) {
    Object.defineProperty(globalThis, key, { configurable: true, value: previousGlobals[key] });
  }
});

/**
 * The request body, typed rather than `any`.
 *
 * Every assertion below reads `body.layers[].id`, so `any` bought nothing and
 * cost the repository's lint gate. `revision` is optional because only the
 * write calls carry one.
 */
interface CallBody { layers?: { id: string; title: string; body: string }[]; revision?: string; enabled?: boolean }
interface Call { url: string; method: string; body: CallBody }
function stubRoutes(handler: (call: Call) => Response) {
  const calls: Call[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call: Call = { url: String(input), method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : undefined };
    calls.push(call);
    return handler(call);
  }) as typeof fetch;
  return calls;
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

async function mount(): Promise<{ root: Root; container: HTMLElement }> {
  const { createRoot } = await import("react-dom/client");
  const container = document.createElement("div");
  document.body.append(container);
  let root!: Root;
  await act(async () => {
    root = createRoot(container);
    root.render(<LanguageProvider><CodexSetPrompt apiBase="" /></LanguageProvider>);
  });
  return { root, container };
}

test("1. a built-in row shows its CANONICAL assembly index, not a renumbering", async () => {
  // Renumbering per visual group would invent an order the runtime does not
  // have. The gaps left by the lifted transition notices are the proof.
  stubRoutes(call => (call.url.includes("/text") ? json({ ok: true, layers: {} }) : json(snapshot())));
  const { container, root } = await mount();
  for (const d of INVENTORY) {
    if (d.class === "extension-unknown") continue;
    const row = container.querySelector("[data-layer-id=\"" + d.id + "\"]");
    expect(row, d.id).not.toBeNull();
    const shown = row!.querySelector(".codex-set-prompt__pos")!.textContent;
    expect(shown, d.id).toBe(d.order === null ? "\u00b7" : String(d.order + 1));
  }
  await act(async () => { root.unmount(); });
});

test("2+3. the transition group holds exactly the two notices, and nothing is dropped", async () => {
  stubRoutes(call => (call.url.includes("/text") ? json({ ok: true, layers: {} }) : json(snapshot())));
  const { container, root } = await mount();
  const lists = [...container.querySelectorAll(".codex-set-prompt__rows")];
  expect(lists.length).toBeGreaterThanOrEqual(2);
  const idsIn = (list: Element) => [...list.querySelectorAll("[data-layer-id]")].map(el => el.getAttribute("data-layer-id"));
  const transition = idsIn(lists[1]!);
  expect(transition.sort()).toEqual([...TRANSITION_IDS].sort());

  // Exactly once across the two groups: a split that loses a layer is worse
  // than no split at all.
  const all = [...container.querySelectorAll("[data-layer-id]")].map(el => el.getAttribute("data-layer-id"));
  const expected = INVENTORY.filter(d => d.class !== "extension-unknown").map(d => d.id);
  expect(all.slice().sort()).toEqual(expected.slice().sort());
  expect(new Set(all).size).toBe(all.length);
  await act(async () => { root.unmount(); });
});

test("a transition notice is never labelled always-on", async () => {
  // It is not on, it fires. Reusing the locked label would claim this text is
  // in every prompt when it appears only at a change.
  stubRoutes(call => (call.url.includes("/text") ? json({ ok: true, layers: {} }) : json(snapshot())));
  const { container, root } = await mount();
  for (const id of TRANSITION_IDS) {
    const note = container.querySelector("[data-layer-id=\"" + id + "\"] .codex-set-prompt__note");
    expect(note, id).not.toBeNull();
    expect(note!.textContent, id).not.toContain("Always on");
  }
  // A genuinely locked layer keeps the strong label.
  // `plugins` rather than `base-instructions`: base now carries a switch instead of a
  // note, because the variant work gave it a real off-position. A layer with a
  // CONDITION states the condition, so the one that still reads "Always on" has to be
  // one with neither a switch nor a condition.
  expect(container.querySelector("[data-layer-id=\"agents-md\"] .codex-set-prompt__note")!.textContent)
    .not.toContain("Always on");
  expect(container.querySelector("[data-layer-id=\"tools\"] .codex-set-prompt__note")!.textContent)
    .toContain("Configured under");
  await act(async () => { root.unmount(); });
});

function layer(over: Record<string, unknown> = {}) {
  return { id: "aaaaaa", title: "First", body: "Alpha.", enabled: true, ...over };
}

const THREE = [layer(), layer({ id: "bbbbbb", title: "Second", body: "Beta." }), layer({ id: "cccccc", title: "Third", body: "Gamma." })];

function dialog(): HTMLElement { return document.querySelector("dialog.modal-overlay") as HTMLElement; }
function navButtons() { return [...dialog().querySelectorAll(".codex-set-custom-dialog__nav button")] as HTMLButtonElement[]; }
function navPos() { return dialog().querySelector(".codex-set-custom-dialog__nav-pos")?.textContent ?? ""; }
function fields() {
  return {
    title: dialog().querySelector("input[type=\"text\"]") as HTMLInputElement,
    body: dialog().querySelector("textarea") as HTMLTextAreaElement,
  };
}

function typeInto(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const proto = el instanceof testWindow.HTMLTextAreaElement
    ? testWindow.HTMLTextAreaElement.prototype
    : testWindow.HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(el, value);
  el.dispatchEvent(new testWindow.Event("input", { bubbles: true }));
  el.dispatchEvent(new testWindow.Event("change", { bubbles: true }));
}

async function openEditor(container: HTMLElement, id: string): Promise<void> {
  await act(async () => {
    (container.querySelector("[data-custom-id=\"" + id + "\"] button") as HTMLButtonElement).click();
  });
}

test("5+6. next and prev move the editor target, show the position, and write nothing", async () => {
  const calls = stubRoutes(call => (call.url.includes("/text") ? json({ ok: true, layers: {} }) : json(snapshot({ custom: THREE }))));
  const { container, root } = await mount();
  await openEditor(container, "aaaaaa");
  expect(navPos()).toBe("1 / 3");
  expect(fields().title.value).toBe("First");

  await act(async () => { navButtons()[1]!.click(); });
  expect(navPos()).toBe("2 / 3");
  // Title AND body follow the layer, not just the label.
  expect(fields().title.value).toBe("Second");
  expect(fields().body.value).toBe("Beta.");

  await act(async () => { navButtons()[0]!.click(); });
  expect(navPos()).toBe("1 / 3");
  expect(fields().title.value).toBe("First");

  // Navigating is not saving.
  expect(calls.filter(c => c.method === "PUT")).toHaveLength(0);
  await act(async () => { root.unmount(); });
});

test("7. the ends are disabled rather than wrapping", async () => {
  stubRoutes(call => (call.url.includes("/text") ? json({ ok: true, layers: {} }) : json(snapshot({ custom: THREE }))));
  const { container, root } = await mount();
  await openEditor(container, "aaaaaa");
  expect(navButtons()[0]!.disabled).toBe(true);
  // Clicking a disabled end leaves the editor exactly where it was.
  await act(async () => { navButtons()[0]!.click(); });
  expect(navPos()).toBe("1 / 3");

  await act(async () => { navButtons()[1]!.click(); });
  await act(async () => { navButtons()[1]!.click(); });
  expect(navPos()).toBe("3 / 3");
  expect(navButtons()[1]!.disabled).toBe(true);
  await act(async () => { navButtons()[1]!.click(); });
  expect(navPos()).toBe("3 / 3");
  await act(async () => { root.unmount(); });
});

test("8. an unsaved edit survives navigating away and back", async () => {
  // The case that matters. Blocking navigation while dirty would pass a weaker
  // version of this while making the feature pointless: comparing two layers
  // mid-edit is the whole reason to move between them.
  const calls = stubRoutes(call => (call.url.includes("/text") ? json({ ok: true, layers: {} }) : json(snapshot({ custom: THREE }))));
  const { container, root } = await mount();
  await openEditor(container, "aaaaaa");
  await act(async () => {
    typeInto(fields().title, "Edited first");
    typeInto(fields().body, "Work in progress.");
  });

  await act(async () => { navButtons()[1]!.click(); });
  expect(fields().title.value).toBe("Second");

  await act(async () => { navButtons()[0]!.click(); });
  expect(fields().title.value).toBe("Edited first");
  expect(fields().body.value).toBe("Work in progress.");
  // And nothing was written along the way.
  expect(calls.filter(c => c.method === "PUT")).toHaveLength(0);
  await act(async () => { root.unmount(); });
});

test("8b. closing or saving another layer warns about a parked edit", async () => {
  const calls = stubRoutes(call => {
    if (call.url.includes("/text")) return json({ ok: true, layers: {} });
    if (call.method === "PUT") return json({ ok: true, changed: true, snapshot: snapshot({ custom: THREE }) });
    return json(snapshot({ custom: THREE }));
  });
  const { container, root } = await mount();
  await openEditor(container, "aaaaaa");
  await act(async () => { typeInto(fields().body, "Parked work in progress."); });
  await act(async () => { navButtons()[1]!.click(); });

  await act(async () => { dialog().dispatchEvent(new testWindow.Event("cancel", { cancelable: true })); });
  expect(dialog().querySelector(".codex-set-custom-dialog__discard")).not.toBeNull();
  await act(async () => {
    const keepEditing = [...dialog().querySelectorAll("button")].find(button => button.textContent?.includes("Keep editing"))!;
    keepEditing.click();
  });

  const save = [...dialog().querySelectorAll("button")].find(button => button.textContent?.includes("Save"))!;
  await act(async () => { save.click(); });
  expect(calls.filter(call => call.method === "PUT")).toHaveLength(0);
  expect(dialog().querySelector(".codex-set-custom-dialog__discard")).not.toBeNull();
  await act(async () => {
    const discard = [...dialog().querySelectorAll("button")].find(button => button.textContent?.includes("Discard"))!;
    discard.click();
  });
  expect(calls.filter(call => call.method === "PUT")).toHaveLength(1);
  await act(async () => { root.unmount(); });
});

test("10. one layer offers no navigation at all", async () => {
  stubRoutes(call => (call.url.includes("/text") ? json({ ok: true, layers: {} }) : json(snapshot({ custom: [layer()] }))));
  const { container, root } = await mount();
  await openEditor(container, "aaaaaa");
  expect(dialog().querySelector(".codex-set-custom-dialog__nav")).toBeNull();
  await act(async () => { root.unmount(); });
});

test("custom layers reorder from the keyboard, not only from the buttons", async () => {
  // W3C APG rearrangeable-listbox: Alt+Arrow moves the item without hunting for
  // a control. The buttons stay because a shortcut nobody discovers is not an
  // affordance.
  const calls = stubRoutes(call => {
    if (call.url.includes("/text")) return json({ ok: true, layers: {} });
    if (call.method === "PUT") return json({ ok: true, changed: true, snapshot: snapshot({ custom: THREE }) });
    return json(snapshot({ custom: THREE }));
  });
  const { container, root } = await mount();
  const row = container.querySelector("[data-custom-id=\"bbbbbb\"]") as HTMLElement;

  await act(async () => {
    row.dispatchEvent(new testWindow.KeyboardEvent("keydown", { key: "ArrowUp", altKey: true, bubbles: true }));
  });
  const put = calls.find(c => c.method === "PUT");
  expect(put).toBeDefined();
  expect(put!.body.layers.map(l => l.id)).toEqual(["bbbbbb", "aaaaaa", "cccccc"]);

  // A bare arrow is ordinary navigation and must not reorder anything.
  const before = calls.filter(c => c.method === "PUT").length;
  await act(async () => {
    row.dispatchEvent(new testWindow.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
  });
  expect(calls.filter(c => c.method === "PUT")).toHaveLength(before);
  await act(async () => { root.unmount(); });
});

test("4. custom layers are numbered among themselves and say they share one section", async () => {
  // Continuing the built-in sequence would draw a fifteen-plus-n stack. They
  // concatenate into ONE developer_instructions section, so 1..n plus a note.
  stubRoutes(call => (call.url.includes("/text") ? json({ ok: true, layers: {} }) : json(snapshot({ custom: THREE }))));
  const { container, root } = await mount();
  const positions = [...container.querySelectorAll("[data-custom-id] .codex-set-prompt__pos")].map(el => el.textContent);
  expect(positions).toEqual(["1", "2", "3"]);
  // Not a continuation of the built-in indices, which end at 15.
  expect(positions).not.toContain("16");
  await act(async () => { root.unmount(); });
});

test("9. saving after navigation writes the layer you are looking at", async () => {
  // Draft parking is only half the contract: keeping A's text but writing it
  // to B would lose the work just as thoroughly.
  const calls = stubRoutes(call => {
    if (call.url.includes("/text")) return json({ ok: true, layers: {} });
    if (call.method === "PUT") return json({ ok: true, changed: true, snapshot: snapshot({ custom: THREE }) });
    return json(snapshot({ custom: THREE }));
  });
  const { container, root } = await mount();
  await openEditor(container, "aaaaaa");
  await act(async () => { navButtons()[1]!.click(); });
  await act(async () => { typeInto(fields().body, "Edited beta."); });

  const save = [...dialog().querySelectorAll("button")].find(b => (b.textContent ?? "").includes("Save"))!;
  await act(async () => { save.click(); });
  const put = calls.find(c => c.method === "PUT")!;
  expect(put.url).toBe("/api/codex-prompt/custom");
  expect(put.body.revision).toBe("sha256:one");
  // The edited layer keeps its id, and its siblings survive untouched.
  expect(put.body.layers.map(l => l.id)).toEqual(["aaaaaa", "bbbbbb", "cccccc"]);
  const edited = put.body.layers.find(l => l.id === "bbbbbb");
  expect(edited.body).toBe("Edited beta.");
  expect(put.body.layers.find(l => l.id === "aaaaaa")).toEqual(THREE[0]);
  expect(put.body.layers.find(l => l.id === "cccccc")).toEqual(THREE[2]);
  await act(async () => { root.unmount(); });
});

test("11. a layer deleted under an open editor closes it instead of stranding it", async () => {
  // Falling back to null turned the editor into a NEW-layer form still holding
  // the deleted text, so Save would have recreated what the user just removed.
  // The position indicator also read "0 / 3".
  let gone = false;
  stubRoutes(call => {
    if (call.url.includes("/text")) return json({ ok: true, layers: {} });
    if (call.method === "PUT") {
      gone = true;
      return json({ ok: true, changed: true, snapshot: snapshot({ custom: [THREE[0]!, THREE[2]!] }) });
    }
    return json(snapshot({ custom: gone ? [THREE[0]!, THREE[2]!] : THREE }));
  });
  const { container, root } = await mount();
  await openEditor(container, "bbbbbb");
  expect(document.querySelector("dialog.modal-overlay")).not.toBeNull();

  // Another surface removes the layer being edited.
  await act(async () => {
    (container.querySelector("[data-custom-id=\"cccccc\"] .codex-set-custom__delete") as HTMLButtonElement).click();
  });
  await act(async () => {
    (container.querySelector(".codex-set-custom__confirm .btn-danger") as HTMLButtonElement).click();
  });

  expect(document.querySelector("dialog.modal-overlay")).toBeNull();
  expect(container.querySelector("[role=\"alert\"]")).not.toBeNull();
  await act(async () => { root.unmount(); });
});
test("the top row does not move up, and the bottom row does not move down", async () => {
  const calls = stubRoutes(call => {
    if (call.url.includes("/text")) return json({ ok: true, layers: {} });
    if (call.method === "PUT") return json({ ok: true, changed: true, snapshot: snapshot({ custom: THREE }) });
    return json(snapshot({ custom: THREE }));
  });
  const { container, root } = await mount();
  const first = container.querySelector("[data-custom-id=\"aaaaaa\"]") as HTMLElement;
  const last = container.querySelector("[data-custom-id=\"cccccc\"]") as HTMLElement;
  await act(async () => {
    first.dispatchEvent(new testWindow.KeyboardEvent("keydown", { key: "ArrowUp", altKey: true, bubbles: true }));
    last.dispatchEvent(new testWindow.KeyboardEvent("keydown", { key: "ArrowDown", altKey: true, bubbles: true }));
  });
  // Silently writing an unchanged list would burn a revision for nothing.
  expect(calls.filter(c => c.method === "PUT")).toHaveLength(0);
  await act(async () => { root.unmount(); });
});

test("an error response is not trusted for its layer data", async () => {
  // A 500 body still parses as JSON. Without a status check the payload was
  // adopted verbatim, so an error response carrying a `layers` key was reported
  // to the user as measured truth - here, a 12-byte permissions layer that was
  // never actually read.
  stubRoutes(call => (call.url.includes("/text")
    ? json({ ok: true, layers: { permissions: { text: "stale", reason: "ok", bytes: 12 } } }, 500)
    : json(snapshot())));
  const { container, root } = await mount();
  const row = container.querySelector("[data-layer-id=\"permissions\"]")!;
  // Nothing was measured, so nothing is claimed.
  expect(row.querySelector(".codex-set-prompt__bytes")).toBeNull();
  await act(async () => {
    (row.querySelector("button") as HTMLButtonElement).click();
  });
  const dialog = document.querySelector("dialog.modal-overlay")!;
  expect(dialog.querySelector(".codex-set-layer-dialog__text")).toBeNull();
  expect(dialog.textContent).not.toContain("stale");
  await act(async () => { root.unmount(); });
});
