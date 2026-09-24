import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { LanguageProvider } from "../src/i18n/provider";
import { DesktopStarOnboarding, STAR_ONBOARDING_KEY } from "../src/components/desktop-star-onboarding";

/**
 * The first dashboard the desktop app opens asks once for a GitHub star. Starring spends the
 * user's identity, so nothing is written without a click, an already-starred install is never
 * asked, and the prompt is not shown outside the desktop shell.
 */

const DESKTOP_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) OpenCodexDesktop/2.64.0";
const globals = ["document", "window", "navigator", "localStorage", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previous: Record<(typeof globals)[number], unknown>;
let win: Window;
let host: HTMLElement;
let root: Root | null = null;
let originalFetch: typeof globalThis.fetch;
let starState: string;
let postOk: boolean;
let calls: string[];

function setup(userAgent: string) {
  win = new Window({ url: "http://127.0.0.1:10100/", settings: { navigator: { userAgent } } });
  Object.defineProperty(win.navigator, "language", { configurable: true, value: "en-US" });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: win.document },
    window: { configurable: true, value: win },
    navigator: { configurable: true, value: win.navigator },
    localStorage: { configurable: true, value: win.localStorage },
  });
  host = win.document.createElement("div") as unknown as HTMLElement;
  win.document.body.appendChild(host as never);
}

beforeEach(() => {
  previous = Object.fromEntries(globals.map((k) => [k, Reflect.get(globalThis, k)])) as typeof previous;
  originalFetch = globalThis.fetch;
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  starState = "not-starred";
  postOk = true;
  calls = [];
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: async (input: RequestInfo | URL, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      calls.push(`${method} ${new URL(String(input), "http://127.0.0.1").pathname}`);
      if (method === "POST") return postOk ? Response.json({ ok: true, state: "starred" }) : Response.json({ ok: false, state: "not-starred" });
      return Response.json({ state: starState, url: "https://github.com/lidge-jun/opencodex" });
    },
  });
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

async function mount(enabled = true) {
  const { createRoot } = await import("react-dom/client");
  await act(async () => {
    root = createRoot(host);
    root.render(
      <LanguageProvider>
        <DesktopStarOnboarding apiBase="" enabled={enabled} />
      </LanguageProvider>,
    );
  });
  await act(async () => { await new Promise((r) => setTimeout(r, 1400)); });
}

function click(target: Element) {
  target.dispatchEvent(new win.MouseEvent("click", { bubbles: true }) as unknown as Event);
}

test("a first desktop launch asks once and stars only on the click", async () => {
  setup(DESKTOP_UA);
  await mount();
  expect(host.querySelector(".star-onboarding")).toBeTruthy();
  expect(calls).toEqual(["GET /api/github/star"]);

  const primary = host.querySelector(".star-onboarding .btn-primary");
  expect(primary).toBeTruthy();
  await act(async () => { click(primary!); await new Promise((r) => setTimeout(r, 20)); });
  expect(calls).toEqual(["GET /api/github/star", "POST /api/github/star"]);
  expect(host.querySelector(".star-onboarding-mark--done")).toBeTruthy();

  await act(async () => { click(host.querySelector(".star-onboarding .btn-primary")!); });
  expect(host.querySelector(".star-onboarding")).toBeNull();
  expect(win.localStorage.getItem(STAR_ONBOARDING_KEY)).toBe("seen");
});

test("dismissing is remembered, so the prompt does not return", async () => {
  setup(DESKTOP_UA);
  await mount();
  await act(async () => { click(host.querySelector(".star-onboarding .btn-ghost")!); });
  expect(host.querySelector(".star-onboarding")).toBeNull();
  expect(win.localStorage.getItem(STAR_ONBOARDING_KEY)).toBe("seen");
  expect(calls).not.toContain("POST /api/github/star");
});

test("an installation that already starred is never asked", async () => {
  setup(DESKTOP_UA);
  starState = "starred";
  await mount();
  expect(host.querySelector(".star-onboarding")).toBeNull();
  expect(win.localStorage.getItem(STAR_ONBOARDING_KEY)).toBe("seen");
});

test("a signed-out gh offers the repository page instead of a write", async () => {
  setup(DESKTOP_UA);
  starState = "unauthenticated";
  await mount();
  expect(host.querySelector(".star-onboarding")).toBeTruthy();
  expect(host.querySelector(".star-onboarding-link")).toBeNull();
  expect(host.querySelector(".star-onboarding-hint")?.textContent).toContain("github.com");
});

test("a plain browser tab is never asked", async () => {
  setup("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)");
  await mount();
  expect(host.querySelector(".star-onboarding")).toBeNull();
  expect(calls).toEqual([]);
});

test("a failed gh star says so and keeps the repository page one click away", async () => {
  setup(DESKTOP_UA);
  postOk = false;
  await mount();
  await act(async () => { click(host.querySelector(".star-onboarding .btn-primary")!); await new Promise((r) => setTimeout(r, 20)); });
  expect(calls).toEqual(["GET /api/github/star", "POST /api/github/star"]);
  expect(host.querySelector(".star-onboarding")).toBeTruthy();
  expect(host.querySelector(".star-onboarding-mark--done")).toBeNull();
  expect(win.localStorage.getItem(STAR_ONBOARDING_KEY)).toBeNull();
});

test("a disabled prompt is not shown and not marked seen", async () => {
  setup(DESKTOP_UA);
  await mount(false);
  expect(host.querySelector(".star-onboarding")).toBeNull();
  expect(win.localStorage.getItem(STAR_ONBOARDING_KEY)).toBeNull();
});
