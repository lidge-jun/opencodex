import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { LanguageProvider } from "../src/i18n/provider";
import { LoginUrlBlock } from "../src/components/login-url-block";

/**
 * Contract for the shared OAuth login-URL block. It owns the copy state for
 * all three login surfaces, so it also owns invalidating that state when the
 * URL changes — the add-provider modal keeps this block mounted across a
 * provider switch and would otherwise show "copied" over a foreign URL.
 */

const URL_A = "https://auth.example.test/oauth/authorize?client_id=aaa&state=111";
const URL_B = "https://auth.example.test/oauth/authorize?client_id=bbb&state=222";

const globals = ["document", "window", "navigator", "localStorage", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previous: Record<(typeof globals)[number], unknown>;
let win: Window;
let host: HTMLElement;
let root: Root | null = null;
let clipboardWrites: string[] = [];

function installClipboard(available: boolean) {
  clipboardWrites = [];
  Object.defineProperty(win.navigator, "clipboard", {
    configurable: true,
    value: available
      ? { writeText: async (text: string) => { clipboardWrites.push(text); } }
      : undefined,
  });
}

beforeEach(() => {
  previous = Object.fromEntries(globals.map((k) => [k, Reflect.get(globalThis, k)])) as typeof previous;
  win = new Window({ url: "http://localhost/" });
  Object.defineProperty(win.navigator, "language", { configurable: true, value: "en-US" });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: win.document },
    window: { configurable: true, value: win },
    navigator: { configurable: true, value: win.navigator },
    localStorage: { configurable: true, value: win.localStorage },
  });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  installClipboard(true);
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

async function render(url: string) {
  const { createRoot } = await import("react-dom/client");
  await act(async () => {
    root ??= createRoot(host);
    root.render(
      <LanguageProvider>
        <LoginUrlBlock url={url} />
      </LanguageProvider>,
    );
  });
}

function copyButton(): HTMLButtonElement {
  const button = host.querySelector(".login-url-block-actions button");
  expect(button).toBeTruthy();
  return button as HTMLButtonElement;
}

async function clickCopy() {
  await act(async () => {
    copyButton().dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 0));
  });
}

test("renders the URL as selectable text and copies it", async () => {
  await render(URL_A);

  expect(host.textContent).toContain(URL_A);

  await clickCopy();

  expect(clipboardWrites).toEqual([URL_A]);
  expect(host.textContent).toContain("Copied");
});

test("reports an unusable clipboard instead of a false success", async () => {
  installClipboard(false);
  await render(URL_A);

  await clickCopy();

  expect(clipboardWrites).toEqual([]);
  expect(host.textContent).toContain("Clipboard unavailable");
});

test("keeps the latest feedback for its full window across repeated copies", async () => {
  await render(URL_A);

  await clickCopy();
  await act(async () => { await new Promise((r) => setTimeout(r, 200)); });
  await clickCopy();

  expect(clipboardWrites).toEqual([URL_A, URL_A]);

  // Past the first click's expiry but before the second's: an unguarded timer
  // would already have wiped the second click's label.
  await act(async () => { await new Promise((r) => setTimeout(r, 2400)); });
  expect(host.textContent).toContain("Copied");
});

test("a new URL resets stale copy feedback", async () => {
  await render(URL_A);
  await clickCopy();
  expect(host.textContent).toContain("Copied");

  await render(URL_B);

  expect(host.textContent).toContain(URL_B);
  expect(host.textContent).not.toContain(URL_A);
  expect(host.textContent).not.toContain("Copied");
  expect(host.textContent).toContain("Copy link");
});

test("offers a manual open fallback alongside the copy button", async () => {
  await render(URL_A);

  const anchor = Array.from(host.querySelectorAll("a")).find(
    (el) => el.getAttribute("href") === URL_A,
  );
  expect(anchor).toBeTruthy();
  expect(anchor?.getAttribute("target")).toBe("_blank");
  expect(anchor?.getAttribute("rel")).toBe("noreferrer");
  expect(host.textContent).toContain("Didn't open?");
});

// The block is shared by three surfaces, so its styles must not read as owned
// by any one of them. Without this the "ownership" claim is unenforceable.
test("carries component-scoped class names, not a host surface's prefix", async () => {
  await render(URL_A);

  expect(host.querySelector(".login-url-block")).toBeTruthy();
  expect(host.querySelector(".login-url-block-text")?.textContent).toBe(URL_A);
  expect(host.querySelector(".login-url-block-actions")).toBeTruthy();
  expect(host.querySelector(".login-url-block-open")).toBeTruthy();
  expect(host.innerHTML).not.toContain("pwi-");
});

test("renders nothing without a URL", async () => {
  await render("");

  expect(host.querySelector(".login-url-block")).toBeNull();
  expect(host.textContent).not.toContain("Copy link");
});
