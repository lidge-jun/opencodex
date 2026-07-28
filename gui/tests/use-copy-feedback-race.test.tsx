import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { LanguageProvider } from "../src/i18n/provider";
import { useCopyFeedback } from "../src/components/use-copy-feedback";

/**
 * Clipboard writes settle out of order — a permission prompt can hold the first
 * attempt past a second one. Without a request generation the older completion
 * overwrites the newer click's result and expires the wrong feedback.
 */

const globals = ["document", "window", "navigator", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previous: Record<(typeof globals)[number], unknown>;
let win: Window;
let host: HTMLElement;
let root: Root | null = null;

/** Each write parks until the test releases it, so ordering is explicit. */
let pending: Array<{ text: string; settle: (ok: boolean) => void }> = [];

function installDeferredClipboard() {
  pending = [];
  Object.defineProperty(win.navigator, "clipboard", {
    configurable: true,
    value: {
      writeText: (text: string) => new Promise<void>((resolve, reject) => {
        pending.push({ text, settle: (ok) => { if (ok) resolve(); else reject(new Error("denied")); } });
      }),
    },
  });
}

function Probe() {
  const { outcomeFor, copy } = useCopyFeedback<string>();
  return (
    <div>
      <span data-testid="a">{outcomeFor("a") ?? "idle"}</span>
      <span data-testid="b">{outcomeFor("b") ?? "idle"}</span>
      <button type="button" data-testid="copy-a" onClick={() => copy("a", "a")} />
      <button type="button" data-testid="copy-b" onClick={() => copy("b", "b")} />
    </div>
  );
}

beforeEach(() => {
  previous = Object.fromEntries(globals.map((k) => [k, Reflect.get(globalThis, k)])) as typeof previous;
  win = new Window({ url: "http://localhost/" });
  Object.defineProperty(win.navigator, "language", { configurable: true, value: "en-US" });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: win.document },
    window: { configurable: true, value: win },
    navigator: { configurable: true, value: win.navigator },
  });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  installDeferredClipboard();
  // No legacy path: a rejected write must not silently succeed through execCommand.
  Object.defineProperty(win.document, "execCommand", { configurable: true, value: undefined });
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
  await win.happyDOM?.close?.();
});

async function mount() {
  const { createRoot } = await import("react-dom/client");
  await act(async () => {
    root = createRoot(host);
    root.render(<LanguageProvider><Probe /></LanguageProvider>);
  });
}

function text(id: string): string {
  return host.querySelector(`[data-testid="${id}"]`)?.textContent ?? "";
}

async function click(id: string) {
  await act(async () => {
    host.querySelector<HTMLButtonElement>(`[data-testid="${id}"]`)
      ?.dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 0));
  });
}

async function settle(index: number, ok: boolean) {
  await act(async () => {
    pending[index]?.settle(ok);
    await new Promise((r) => setTimeout(r, 0));
  });
}

test("a stale completion never overwrites the newer click", async () => {
  await mount();

  await click("copy-a");
  await click("copy-b");
  expect(pending.map((p) => p.text)).toEqual(["a", "b"]);

  await settle(1, true);   // the newer click lands first
  expect(text("b")).toBe("copied");

  await settle(0, true);   // the older one arrives late
  expect(text("b")).toBe("copied");
  expect(text("a")).toBe("idle");
});

test("a late failure does not downgrade a newer success", async () => {
  await mount();

  await click("copy-a");
  await click("copy-b");

  await settle(1, true);
  await settle(0, false);  // A was denied, but B already succeeded

  expect(text("b")).toBe("copied");
  expect(text("a")).toBe("idle");
});

test("a stale timer cannot expire the newer feedback", async () => {
  await mount();

  await click("copy-a");
  await click("copy-b");

  await settle(1, true);
  await settle(0, true);

  // Past the stale attempt's would-be expiry, inside the current one's window.
  await act(async () => { await new Promise((r) => setTimeout(r, 2400)); });
  expect(text("b")).toBe("copied");
});

test("sequential copies still report the latest result", async () => {
  await mount();

  await click("copy-a");
  await settle(0, true);
  expect(text("a")).toBe("copied");

  await click("copy-b");
  await settle(1, false);
  expect(text("b")).toBe("unavailable");
  expect(text("a")).toBe("idle");
});
