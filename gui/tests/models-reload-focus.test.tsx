import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { clearClientResourceStoresForTests } from "../src/client-resource";
import { LanguageProvider } from "../src/i18n/provider";
import Models from "../src/pages/Models";
import { actionDialogOpen, dismissActionDialog } from "./helpers/action-dialog";

const keys = ["document", "window", "navigator", "localStorage", "sessionStorage", "fetch", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previous: Record<(typeof keys)[number], PropertyDescriptor | undefined>;
let win: Window;
let root: Root;
let host: HTMLElement;
let reads: Array<(response: Response) => void>;

beforeEach(() => {
  previous = Object.fromEntries(keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)])) as typeof previous;
  win = new Window({ url: "http://localhost/#models" });
  Object.defineProperty(win.navigator, "language", { configurable: true, value: "en-US" });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: win.document }, window: { configurable: true, value: win },
    navigator: { configurable: true, value: win.navigator }, localStorage: { configurable: true, value: win.localStorage },
    sessionStorage: { configurable: true, value: win.sessionStorage }, IS_REACT_ACT_ENVIRONMENT: { configurable: true, value: true },
  });
  reads = [];
  globalThis.fetch = (async input => String(input).endsWith("/api/system/codex-app-server")
    ? new Promise<Response>(resolve => { reads.push(resolve); }) : new Response(null, { status: 404 })) as typeof fetch;
  host = win.document.createElement("div") as unknown as HTMLElement;
  win.document.body.appendChild(host as never);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  clearClientResourceStoresForTests();
  win.close();
  for (const key of keys) {
    const value = previous[key];
    if (value) Object.defineProperty(globalThis, key, value); else Reflect.deleteProperty(globalThis, key);
  }
});

async function render(epoch: number) {
  await act(async () => { root.render(<LanguageProvider><Models apiBase="http://localhost" restartEpoch={epoch} reportRestart={() => {}} /></LanguageProvider>); });
}
async function resolveRead(index: number, state: "fresh" | "stale") {
  expect(reads[index]).toBeDefined();
  await act(async () => { reads[index]!(Response.json({ state, runningCount: 1 })); await Promise.resolve(); });
}
function header() {
  return [...host.querySelectorAll<HTMLButtonElement>(".page-head-actions button")]
    .find(button => button.textContent?.includes("Reload Codex models"))!;
}

test("reload action preserves focus across stale and fresh transitions without stealing unrelated focus", async () => {
  await render(0);
  const original = header();
  original.focus();
  expect(win.document.activeElement === original as never).toBe(true);
  await resolveRead(0, "stale");
  const banner = host.querySelector<HTMLButtonElement>(".codex-stale-banner button")!;
  expect(banner).toBeTruthy();
  expect(win.document.activeElement === banner as never).toBe(true);

  await render(1);
  expect(win.document.activeElement === header() as never).toBe(true);
  await resolveRead(1, "fresh");
  expect(win.document.activeElement === header() as never).toBe(true);

  await render(2);
  const other = host.querySelector<HTMLButtonElement>(".page-head-actions button")!;
  other.focus();
  expect(other === header()).toBe(false);
  await resolveRead(2, "stale");
  expect(win.document.activeElement === other as never).toBe(true);
});

test("a deliberate blur before the stale update commits is not reversed", async () => {
  await render(0);
  const original = header();
  original.focus();
  await act(async () => {
    reads[0]!(Response.json({ state: "stale", runningCount: 1 }));
    for (let i = 0; i < 12; i++) await Promise.resolve();
    original.blur();
    expect(win.document.activeElement === win.document.body).toBe(true);
  });
  expect(host.querySelector(".codex-stale-banner button")).toBeTruthy();
  expect(win.document.activeElement === win.document.body).toBe(true);
});

test("a deliberate blur before the banner is replaced is not reversed", async () => {
  await render(0);
  await resolveRead(0, "stale");
  const banner = host.querySelector<HTMLButtonElement>(".codex-stale-banner button")!;
  banner.focus();
  await act(async () => {
    root.render(<LanguageProvider><Models apiBase="http://localhost" restartEpoch={1} reportRestart={() => {}} /></LanguageProvider>);
    banner.blur();
    expect(win.document.activeElement === win.document.body).toBe(true);
  });
  expect(header()).toBeTruthy();
  expect(win.document.activeElement === win.document.body).toBe(true);
});

test("canceling reload restores focus to the replacement after a stale status arrives", async () => {
  await render(0);
  const original = header();
  original.focus();
  await act(async () => { original.click(); await Promise.resolve(); });
  expect(actionDialogOpen(win.document as unknown as Document)).toBe(true);
  await resolveRead(0, "stale");
  const banner = host.querySelector<HTMLButtonElement>(".codex-stale-banner button")!;
  expect(original.isConnected).toBe(false);
  await act(async () => { dismissActionDialog(win.document as unknown as Document); await Promise.resolve(); });
  expect(win.document.activeElement === banner as never).toBe(true);
});

test("a disconnected reload trigger does not steal focus moved outside the dialog", async () => {
  await render(0);
  const original = header();
  original.focus();
  await act(async () => { original.click(); await Promise.resolve(); });
  await resolveRead(0, "stale");
  const other = host.querySelector<HTMLButtonElement>(".page-head-actions button")!;
  other.focus();
  await act(async () => { dismissActionDialog(win.document as unknown as Document); await Promise.resolve(); });
  expect(win.document.activeElement === other as never).toBe(true);
});

test("a removed unrelated pre-dialog focus target does not activate the reload fallback", async () => {
  await render(0);
  const outside = win.document.createElement("button");
  win.document.body.append(outside);
  outside.focus();
  await act(async () => { header().click(); await Promise.resolve(); });
  outside.remove();
  await resolveRead(0, "stale");
  await act(async () => { dismissActionDialog(win.document as unknown as Document); await Promise.resolve(); });
  expect(win.document.activeElement === win.document.body).toBe(true);
});

test("canceling reload returns focus to the header when the stale banner disappears", async () => {
  await render(0);
  await resolveRead(0, "stale");
  const banner = host.querySelector<HTMLButtonElement>(".codex-stale-banner button")!;
  banner.focus();
  await act(async () => { banner.click(); await Promise.resolve(); });
  expect(actionDialogOpen(win.document as unknown as Document)).toBe(true);
  await render(1);
  expect(banner.isConnected).toBe(false);
  await act(async () => { dismissActionDialog(win.document as unknown as Document); await Promise.resolve(); });
  expect(win.document.activeElement === header() as never).toBe(true);
});

test("reload action is unique after each controlled classifier outcome", async () => {
  for (const state of ["stale", "fresh", "not_running", "unknown", "error"] as const) {
    await render(reads.length);
    const index = reads.length - 1;
    await act(async () => { reads[index]!(state === "error" ? new Response(null, { status: 500 }) : Response.json({ state, runningCount: state === "not_running" ? 0 : 1 })); await Promise.resolve(); });
    const buttons = [...host.querySelectorAll<HTMLButtonElement>("button")].filter(button => button.textContent?.includes("Reload Codex models"));
    expect(buttons).toHaveLength(1);
    expect(!!host.querySelector(".codex-stale-banner")).toBe(state === "stale");
    expect(!!buttons[0]!.closest(".codex-stale-banner")).toBe(state === "stale");
  }
});
