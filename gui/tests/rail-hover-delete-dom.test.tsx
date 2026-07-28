import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import ProviderWorkspaceShell from "../src/components/provider-workspace/ProviderWorkspaceShell";
import { LanguageProvider } from "../src/i18n/provider";

/**
 * WP4 rendered-DOM contract. The sibling .ts file pins source invariants; this file
 * proves the structural claims the reviewer flagged as unprovable by substring checks:
 * the delete control is a real SIBLING of the option, the listbox still sees only rows,
 * and clicking trash asks for confirmation instead of deleting.
 */

const globals = ["document", "window", "navigator", "localStorage", "IS_REACT_ACT_ENVIRONMENT"] as const;
/** Survives afterEach restore so a late React 19 dispatchSetState can read window.event. */
const WINDOW_EVENT_STUB: { event: undefined } = { event: undefined };
let previous: Record<(typeof globals)[number], unknown>;
let win: Window;
let host: HTMLElement;
let root: Root | null = null;
let originalFetch: typeof globalThis.fetch;
let requests: string[] = [];
let removed: string[] = [];
let selected: (string | null)[] = [];

const providers = {
  alpha: { adapter: "openai-chat", baseUrl: "https://a.invalid/v1", hasApiKey: true },
  beta: { adapter: "openai-chat", baseUrl: "https://b.invalid/v1", hasApiKey: true },
} as unknown as Parameters<typeof ProviderWorkspaceShell>[0]["providers"];

beforeEach(() => {
  previous = Object.fromEntries(globals.map((k) => [k, Reflect.get(globalThis, k)])) as typeof previous;
  originalFetch = globalThis.fetch;
  win = new Window({ url: "http://localhost/" });
  Object.defineProperty(win.navigator, "language", { configurable: true, value: "en-US" });
  // React 19 resolveUpdatePriority reads window.event; happy-dom omits the IE legacy field.
  Object.defineProperty(win, "event", { configurable: true, writable: true, value: undefined });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: win.document },
    window: { configurable: true, value: win },
    navigator: { configurable: true, value: win.navigator },
    localStorage: { configurable: true, value: win.localStorage },
  });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

  requests = []; removed = []; selected = [];
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: async (url: string, init?: RequestInit) => {
      requests.push(`${init?.method ?? "GET"} ${String(url)}`);
      return { ok: true, json: async () => ({}) } as unknown as Response;
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
  // Drain React 19 scheduler work (setImmediate/MessageChannel) while happy-dom is
  // still installed. ProviderWorkspaceShell defers setState via window.setTimeout(0)
  // + fetch; on slow macOS CI one tick is not enough and a late dispatchSetState
  // then evaluates window.event after globals were restored to undefined.
  await act(async () => {
    for (let i = 0; i < 5; i++) {
      await new Promise<void>((r) => setTimeout(r, 0));
      await Promise.resolve();
    }
  });
  for (const key of globals) {
    let value = previous[key];
    if (key === "window") {
      if (value == null || typeof value !== "object") {
        value = WINDOW_EVENT_STUB;
      } else if (!Object.prototype.hasOwnProperty.call(value, "event")) {
        try {
          Object.defineProperty(value, "event", {
            configurable: true,
            writable: true,
            value: undefined,
          });
        } catch {
          value = WINDOW_EVENT_STUB;
        }
      }
    }
    Object.defineProperty(globalThis, key, { configurable: true, value });
  }
  Object.defineProperty(globalThis, "fetch", { configurable: true, value: originalFetch });
});

async function mountShell() {
  // Lazy import: a static react-dom/client import binds to the document that existed
  // when the module graph loaded and corrupts sibling suites in the same process.
  const { createRoot } = await import("react-dom/client");
  await act(async () => {
    root = createRoot(host);
    root.render(
      <LanguageProvider>
        <ProviderWorkspaceShell
          providers={providers}
          apiBase=""
          defaultProvider="alpha"
          selectedName={null}
          onSelect={(name) => selected.push(name)}
          onRemoveProvider={(name) => removed.push(name)}
          onAddProvider={() => {}}
          modelsLoadFailed={false}
          detail={() => null}
        />
      </LanguageProvider>,
    );
  });
  await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
}

test("the delete control is a sibling of the option, never a descendant", async () => {
  await mountShell();

  const options = Array.from(host.querySelectorAll('[role="option"]'));
  expect(options.length).toBe(2);

  for (const option of options) {
    const wrapper = option.parentElement!;
    const trash = wrapper.querySelector(".pws-rail-row-remove");
    expect(trash).not.toBeNull();
    // Sibling, not child: nesting would be invalid HTML inside role="option".
    expect(trash!.parentElement).toBe(wrapper);
    expect(option.contains(trash)).toBe(false);
  }
});

test("the listbox still sees only the rows", async () => {
  await mountShell();

  const list = host.querySelector('[role="listbox"]')!;
  const options = Array.from(list.querySelectorAll('[role="option"]'));
  const trashes = Array.from(list.querySelectorAll(".pws-rail-row-remove"));

  // The keyboard handler does options.findIndex(el => el === active || el.contains(active)).
  // A trash button must never satisfy either branch.
  expect(options.length).toBe(2);
  expect(trashes.length).toBe(2);
  for (const trash of trashes) {
    expect(options.some((o) => o === trash || o.contains(trash))).toBe(false);
  }
});

test("clicking trash requests removal without selecting the row", async () => {
  await mountShell();

  const trash = host.querySelector(".pws-rail-row-remove") as HTMLButtonElement;
  await act(async () => { trash.click(); });

  expect(removed.length).toBe(1);
  // Selection must not fire from the same click.
  expect(selected).toEqual([]);
});

test("clicking trash issues no DELETE before confirmation", async () => {
  await mountShell();

  const trash = host.querySelector(".pws-rail-row-remove") as HTMLButtonElement;
  await act(async () => { trash.click(); });
  await act(async () => { await new Promise((r) => setTimeout(r, 20)); });

  // The rail only asks its caller to open the dialog. If it ever deleted directly, this
  // would catch it — which the source-substring test could not.
  expect(requests.filter((r) => r.startsWith("DELETE"))).toEqual([]);
  expect(removed).toEqual(["alpha"]);
});

test("the trash control stays out of the tab order", async () => {
  await mountShell();

  const trash = host.querySelector(".pws-rail-row-remove") as HTMLButtonElement;
  expect(trash.tabIndex).toBe(-1);
  expect(trash.getAttribute("aria-hidden")).toBe("true");
});
