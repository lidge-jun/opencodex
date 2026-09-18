import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { LanguageProvider } from "../src/i18n/provider";
import AddProviderModal from "../src/components/AddProviderModal";

/**
 * A few catalog notes are paragraphs — `opencode-free` is ~1100 characters — and an
 * unclamped one fills the entire 360px scroll viewport, so the row it belongs to becomes
 * the only row a user can see. The row is clamped to two lines and the rest moves into a
 * popup.
 *
 * These pin the two properties that make the reveal correct rather than merely present:
 * clicking it must NOT select the provider (the row is a button, and the reveal is its
 * sibling precisely so a nested button cannot be hoisted out), and the popup must carry
 * the whole note rather than the clamped text.
 */

const LONG_NOTE = "No key needed, but this provider gates the tier to its own client and refuses any request that arrives without a session header, so the proxy cannot present itself as that client. Use the keyed provider instead.";

const PRESETS = [
  { id: "cerebras", label: "Cerebras", adapter: "openai-completions", baseUrl: "https://api.cerebras.ai/v1", auth: "key", note: LONG_NOTE },
  { id: "together", label: "Together", adapter: "openai-completions", baseUrl: "https://api.together.xyz/v1", auth: "key", note: "Short note." },
];

const globals = ["document", "window", "navigator", "localStorage", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previous: Record<(typeof globals)[number], unknown>;
let win: Window;
let host: HTMLElement;
let root: Root | null = null;
let originalFetch: typeof globalThis.fetch;
let selected: string[] = [];

beforeEach(() => {
  previous = Object.fromEntries(globals.map(k => [k, Reflect.get(globalThis, k)])) as typeof previous;
  originalFetch = globalThis.fetch;
  selected = [];
  win = new Window({ url: "http://localhost/" });
  Object.defineProperty(win.navigator, "language", { configurable: true, value: "en-US" });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: win.document },
    window: { configurable: true, value: win },
    navigator: { configurable: true, value: win.navigator },
    localStorage: { configurable: true, value: win.localStorage },
  });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

  // happy-dom has no native <dialog> behaviour; the popup calls showModal() on mount.
  const proto = win.HTMLDialogElement?.prototype as unknown as { showModal?: () => void; close?: () => void } | undefined;
  if (proto && typeof proto.showModal !== "function") {
    proto.showModal = function showModal(this: HTMLElement) { this.setAttribute("open", ""); };
    proto.close = function close(this: HTMLElement) { this.removeAttribute("open"); };
  }

  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: async (input: RequestInfo | URL) => {
      const url = new URL(String(input), "http://localhost");
      if (url.pathname === "/api/provider-presets") return Response.json({ providers: PRESETS });
      if (url.pathname === "/api/oauth/providers") return Response.json({ providers: [] });
      if (url.pathname === "/api/usage") return Response.json({ providers: [] });
      return Response.json({});
    },
  });

  host = win.document.createElement("div") as unknown as HTMLElement;
  win.document.body.appendChild(host as never);
});

afterEach(async () => {
  if (root) {
    const current = root;
    await act(async () => { current.unmount(); });
    root = null;
  }
  for (const key of globals) {
    Object.defineProperty(globalThis, key, { configurable: true, value: previous[key] });
  }
  Object.defineProperty(globalThis, "fetch", { configurable: true, value: originalFetch });
  await win.happyDOM?.close?.();
});

async function mountCatalog() {
  const { createRoot } = await import("react-dom/client");
  await act(async () => {
    root = createRoot(host);
    root.render(
      <LanguageProvider>
        {/* `paid` is where an API-key preset buckets; the default tab would render an
            empty list and make these assertions vacuous. */}
        <AddProviderModal
          apiBase=""
          existingNames={[]}
          initialTier="paid"
          onClose={() => {}}
          onAdded={name => { selected.push(name); }}
        />
      </LanguageProvider>,
    );
  });
  await act(async () => { await new Promise(r => setTimeout(r, 60)); });
}

function reveals(): HTMLElement[] {
  return [...win.document.querySelectorAll<HTMLElement>(".provider-catalog-note-more")] as unknown as HTMLElement[];
}

test("every nonempty note has a reveal even when a narrow row clips short text", async () => {
  await mountCatalog();
  expect(reveals()).toHaveLength(2);
  // The control is a sibling of the row button, never a child of it: a button nested in
  // a button is invalid HTML the parser may hoist out of the row.
  const wrap = reveals()[0]!.parentElement!;
  expect(wrap.className).toContain("provider-catalog-row-wrap");
  expect(reveals()[0]!.closest(".list-row")).toBeNull();
});

test("the reveal opens the full note and does not select the provider", async () => {
  await mountCatalog();
  const heading = () => win.document.querySelector(".modal-head h3")?.textContent ?? "";
  expect(heading()).toBe("Add provider");

  await act(async () => { reveals()[0]!.click(); });

  // Still the catalog, not the per-provider add form: the row was not selected.
  expect(win.document.querySelector(".provider-catalog")).not.toBeNull();
  expect(selected).toEqual([]);

  const noteText = win.document.querySelector(".provider-note-text")?.textContent ?? "";
  expect(noteText).toBe(LONG_NOTE);
});

test("closing the popup returns keyboard focus to its reveal button", async () => {
  await mountCatalog();
  const trigger = reveals()[0]!;
  trigger.focus();
  await act(async () => { trigger.click(); });
  const close = win.document.querySelector(".provider-note-card .btn-icon") as unknown as HTMLElement;
  await act(async () => { close.click(); });
  expect(win.document.querySelector(".provider-note-card")).toBeNull();
  expect(win.document.activeElement).toBe(trigger);
});
