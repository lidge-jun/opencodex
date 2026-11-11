import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { LanguageProvider } from "../src/i18n/provider";
import { OpenAiAccountModeBanner } from "../src/pages/codex-set-multiauth";

const globals = ["document", "window", "navigator", "localStorage", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previous: Record<(typeof globals)[number], unknown>;
let testWindow: Window;
let root: Root | undefined;

beforeEach(() => {
  previous = Object.fromEntries(globals.map(key => [key, Reflect.get(globalThis, key)])) as typeof previous;
  testWindow = new Window({ url: "http://localhost/#codex-set" });
  Object.defineProperty(testWindow.navigator, "language", { configurable: true, value: "en-US" });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: testWindow.document },
    window: { configurable: true, value: testWindow },
    navigator: { configurable: true, value: testWindow.navigator },
    localStorage: { configurable: true, value: testWindow.localStorage },
  });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  root = undefined;
  testWindow.close();
  for (const key of globals) Object.defineProperty(globalThis, key, { configurable: true, value: previous[key] });
});

async function mount(state: "pool" | "direct" | "invalid"): Promise<HTMLElement> {
  const host = document.createElement("div");
  document.body.append(host);
  const { createRoot } = await import("react-dom/client");
  await act(async () => {
    root = createRoot(host);
    root.render(<LanguageProvider><OpenAiAccountModeBanner state={state} busy={false} onEnable={() => {}} /></LanguageProvider>);
  });
  return host;
}

const modeButton = (host: HTMLElement, label: string) =>
  [...host.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent?.includes(label));

test("the Direct badge is a button that opens the Codex account mode control (#8501)", async () => {
  const host = await mount("direct");
  const button = modeButton(host, "Direct mode");
  expect(button).toBeTruthy();
  expect(button!.getAttribute("type")).toBe("button");
  expect(button!.getAttribute("aria-label")).toBe("Direct mode — Change account mode");
  await act(async () => { button!.click(); });
  expect(testWindow.location.hash).toBe("#providers?provider=openai&focus=account-mode");
});

test("the Pool badge offers the same way back to the control", async () => {
  const host = await mount("pool");
  const button = modeButton(host, "Pool mode");
  expect(button?.getAttribute("aria-label")).toBe("Pool mode — Change account mode");
  await act(async () => { button!.click(); });
  expect(testWindow.location.hash).toBe("#providers?provider=openai&focus=account-mode");
});

test("following the badge again re-announces an unchanged link", async () => {
  const host = await mount("direct");
  testWindow.location.hash = "#providers?provider=openai&focus=account-mode";
  let announced = 0;
  testWindow.addEventListener("hashchange", () => { announced += 1; });
  await act(async () => { modeButton(host, "Direct mode")!.click(); await new Promise(resolve => setTimeout(resolve, 0)); });
  expect(announced).toBeGreaterThan(0);
});

test("a non-canonical OpenAI row links to its provider settings, which have no mode control", async () => {
  const host = await mount("invalid");
  const link = modeButton(host, "Open Providers");
  await act(async () => { link!.click(); });
  expect(testWindow.location.hash).toBe("#providers?provider=openai");
});
