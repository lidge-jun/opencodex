import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import type { Root } from "react-dom/client";
import { pane, splitPane } from "../src/components/remote-workspace/split-layout";
import type { RemoteSession } from "../src/components/remote-workspace/types";

let win: Window, root: Root | null = null, previous: Record<string, unknown>;
const globals = ["window", "document", "navigator", "localStorage", "fetch", "IS_REACT_ACT_ENVIRONMENT"] as const;
beforeEach(() => {
  previous = Object.fromEntries(globals.map(key => [key, Reflect.get(globalThis, key)]));
  win = new Window({ url: "http://localhost/#remote-workspace" });
  for (const [key, value] of Object.entries({ window: win, document: win.document, navigator: win.navigator, localStorage: win.localStorage, IS_REACT_ACT_ENVIRONMENT: true })) Object.defineProperty(globalThis, key, { configurable: true, value });
});
afterEach(async () => {
  if (root) { const { act } = await import("react"); await act(async () => root?.unmount()); root = null; }
  for (const key of globals) Object.defineProperty(globalThis, key, { configurable: true, value: previous[key] });
});
const session = (id: string): RemoteSession => ({ id, profile: "codex", accessMode: "read-only", deviceId: "device", deviceName: "Computer", rootId: "root", rootLabel: `Project ${id}`, capabilities: ["workspace.read"], tools: ["read_file"], threadId: id, resumable: true, status: "ready", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", events: [] });
const response = (value: unknown) => Response.json(value);
async function mount(sessions = [session("a"), session("b"), session("c")]) {
  const [{ act }, { createRoot }, { LanguageProvider }, { RemoteWorkspaceChats }] = await Promise.all([import("react"), import("react-dom/client"), import("../src/i18n/provider"), import("../src/components/remote-workspace/RemoteWorkspaceChats")]);
  const host = win.document.createElement("div") as unknown as HTMLElement;
  win.document.body.appendChild(host as never);
  await act(async () => { root = createRoot(host); root.render(<LanguageProvider><RemoteWorkspaceChats apiBase="/split" sessions={sessions} devices={[]} selectedSessionId="" stale={false} refresh={() => {}} /></LanguageProvider>); });
  const row = (id: string) => host.querySelector(`[data-session-open="${id}"]`)!.parentElement!;
  const paneFor = (id: string) => host.querySelector<HTMLElement>(`.remote-chat-pane[data-session-id="${id}"]`)!;
  const button = (element: Element, text: string) => [...element.querySelectorAll<HTMLButtonElement>("button")].find(value => value.textContent?.includes(text) || value.getAttribute("aria-label") === text)!;
  const click = async (element: HTMLElement) => act(async () => element.click());
  const type = async (id: string, value: string) => act(async () => {
    const textarea = paneFor(id).querySelector("textarea")!;
    Object.getOwnPropertyDescriptor(win.HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, value);
    textarea.dispatchEvent(new win.Event("input", { bubbles: true }) as never);
  });
  return { host, row, paneFor, button, click, type, act };
}

test("split controls, keyboard resize, close and reopen retain drafts without stopping a session", async () => {
  let writes = 0;
  Reflect.set(globalThis, "fetch", async () => { writes++; return response({ ok: true }); });
  const { host, row, paneFor, button, click, type, act } = await mount();
  await click(button(row("a"), "Split right"));
  expect(host.querySelectorAll(".remote-chat-pane").length).toBe(2);
  await type("a", "keep this draft");
  const divider = host.querySelector('[role="separator"]')!;
  await act(async () => divider.dispatchEvent(new win.KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }) as never));
  expect(divider.getAttribute("aria-valuenow")).toBe("55");
  await click(button(paneFor("a"), "Close pane"));
  expect(host.querySelectorAll(".remote-chat-pane").length).toBe(1);
  await click(row("a").querySelector("button")!);
  expect(paneFor("a").querySelector("textarea")!.value).toBe("keep this draft");
  expect(writes).toBe(0);
  expect(win.localStorage.getItem("ocx-remote-workspace-layout:/split")).not.toContain("keep this draft");
});

test("concurrent prompts are session scoped and late replies cannot reopen a stopped pane", async () => {
  const held = new Map<string, (response: Response) => void>();
  const calls: string[] = [];
  Reflect.set(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input); calls.push(`${init?.method} ${path}`);
    if (path.endsWith("/prompt")) return new Promise<Response>(resolve => held.set(path.includes("/a/") ? "a" : "c", resolve));
    return response({ ok: true });
  });
  const { host, row, paneFor, button, click, type, act } = await mount();
  await click(button(row("a"), "Split right"));
  await type("a", "first a"); await type("c", "first c");
  await click(button(paneFor("a"), "Send")); await click(button(paneFor("c"), "Send"));
  expect(held.size).toBe(2);
  expect(button(paneFor("a"), "Send").disabled).toBe(true);
  expect(button(paneFor("c"), "Send").disabled).toBe(true);
  expect(button(paneFor("a"), "Stop").disabled).toBe(false);
  await type("c", "new c draft");
  await click(button(paneFor("a"), "Stop"));
  await act(async () => {
    held.get("a")!(response({ ...session("a"), events: [{ sequence: 2, type: "assistant", text: "late a", at: "2026-01-01T00:00:01Z" }] }));
    held.get("c")!(response({ ...session("c"), status: "running", events: [{ sequence: 2, type: "status", text: "accepted c", at: "2026-01-01T00:00:01Z" }] }));
  });
  expect(paneFor("a").textContent).toContain("Stopped");
  expect(paneFor("a").textContent).not.toContain("late a");
  expect(paneFor("a").querySelector("textarea")!.disabled).toBe(true);
  expect(paneFor("c").querySelector("textarea")!.value).toBe("new c draft");
  expect(button(paneFor("c"), "Send").disabled).toBe(true);
  expect(calls.filter(value => value.startsWith("DELETE"))).toEqual(["DELETE /split/api/remote-workspace/sessions/a"]);
  expect(host.textContent).toContain("accepted c");
});

test("dragging a listed session to a pane edge splits, and moving a pane never duplicates it", async () => {
  const { host, row, paneFor, act } = await mount();
  const drag = async (source: Element, id: string, target: string, edge: string) => {
    const data: Record<string, string> = {};
    const transfer = { setData: (type: string, value: string) => { data[type] = value; }, getData: (type: string) => data[type], effectAllowed: "", dropEffect: "" };
    const event = (type: string) => { const value = new win.Event(type, { bubbles: true, cancelable: true }); Object.defineProperty(value, "dataTransfer", { value: transfer }); return value; };
    await act(async () => source.dispatchEvent(event("dragstart") as never));
    expect(data["application/x-opencodex-session"]).toBe(id);
    const zone = paneFor(target).querySelector(`.remote-pane-drop--${edge}`)!;
    await act(async () => { zone.dispatchEvent(event("dragover") as never); zone.dispatchEvent(event("drop") as never); });
  };
  await drag(row("a"), "a", "c", "left");
  expect(host.querySelectorAll(".remote-chat-pane").length).toBe(2);
  await drag(paneFor("a").querySelector("[data-pane-heading]")!, "a", "c", "down");
  expect(host.querySelectorAll('.remote-chat-pane[data-session-id="a"]').length).toBe(1);
  expect(host.querySelector('.remote-split-branch--column')).not.toBeNull();
});

test("a cold page mount preserves saved panes until its first network snapshot arrives", async () => {
  const key = "ocx-remote-workspace-layout:/cold-split-fixture";
  const saved = splitPane(pane("a"), "b", "a", "right")!;
  win.localStorage.setItem(key, JSON.stringify(saved));
  let finish!: (value: Response) => void;
  Reflect.set(globalThis, "fetch", () => new Promise<Response>(resolve => { finish = resolve; }));
  const [{ act }, { createRoot }, { LanguageProvider }, { default: RemoteWorkspace }] = await Promise.all([import("react"), import("react-dom/client"), import("../src/i18n/provider"), import("../src/pages/RemoteWorkspace")]);
  const host = win.document.createElement("div") as unknown as HTMLElement;
  await act(async () => { root = createRoot(host); root.render(<LanguageProvider><RemoteWorkspace apiBase="/cold-split-fixture" hubOrigin="http://localhost" /></LanguageProvider>); });
  expect(JSON.parse(win.localStorage.getItem(key)!)).toEqual(saved);
  await act(async () => { finish(response({ available: true, sessions: [session("a"), session("b")], devices: [], runtimes: {} })); });
  expect(host.querySelectorAll(".remote-chat-pane").length).toBe(2);
});
