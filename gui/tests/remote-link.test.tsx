import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
import RemoteLink, { parseRemoteLinkStatus, type RemoteLinkStatusWire } from "../src/pages/RemoteLink";
import { LINK_ERROR_CODES, LinkApiError, readLinkJson } from "../src/remote-link-api";
import { LanguageProvider } from "../src/i18n/provider";
import { LOCALES } from "../src/i18n/shared";

const baseStatus: RemoteLinkStatusWire = { role: "home", listener: { state: "listening", port: 44123 }, links: [], child: null };
let win: Window;
let root: Root | null = null;
let previous: Record<string, unknown>;
const globals = ["window", "document", "navigator", "localStorage", "fetch", "IS_REACT_ACT_ENVIRONMENT"] as const;

beforeEach(() => {
  previous = Object.fromEntries(globals.map(key => [key, Reflect.get(globalThis, key)]));
  win = new Window({ url: "http://localhost/#remote" });
  Object.defineProperties(globalThis, {
    window: { configurable: true, value: win }, document: { configurable: true, value: win.document }, navigator: { configurable: true, value: win.navigator }, localStorage: { configurable: true, value: win.localStorage }, IS_REACT_ACT_ENVIRONMENT: { configurable: true, value: true },
  });
});

afterEach(async () => {
  if (root) await act(async () => { root?.unmount(); });
  root = null;
  for (const key of globals) Object.defineProperty(globalThis, key, { configurable: true, value: previous[key] });
});

function response(body: unknown, status = 200): Response { return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }); }
async function flush(): Promise<void> { await act(async () => { await Promise.resolve(); await Promise.resolve(); }); }
async function mount(props: Partial<React.ComponentProps<typeof RemoteLink>> = {}): Promise<HTMLDivElement> {
  const host = win.document.createElement("div");
  win.document.body.append(host);
  root = createRoot(host);
  await act(async () => { root?.render(<LanguageProvider><RemoteLink apiBase="http://fixture" sessionReady {...props} /></LanguageProvider>); });
  await flush();
  return host;
}

test("LINK_ERROR_CODES stays in exact parity with link-routes.ts", async () => {
  const source = await Bun.file("../src/server/management/link-routes.ts").text();
  const fromRoutes = [...source.matchAll(/fail\("([a-z_]+)"/g)].map(match => match[1]).filter((value, index, all) => all.indexOf(value) === index).sort();
  expect([...LINK_ERROR_CODES].sort()).toEqual(fromRoutes);
});

test("parses every wire state without changing the DTO", () => {
  for (const state of ["connecting", "connected", "reconnecting", "failed", "idle"] as const) {
    const parsed = parseRemoteLinkStatus({ ...baseStatus, links: [{ id: state, alias: "child", direction: "hub-initiated", state, since: "now", reason: state === "failed" ? "compensation_failed" : null, tunnelPort: 43110 }] });
    expect(parsed.links[0]?.state).toBe(state);
  }
  expect(parseRemoteLinkStatus({ ...baseStatus, role: "standalone", listener: { state: "off", port: null }, child: { alias: "child", state: "idle", since: "now", reason: null } }).child?.state).toBe("idle");
});

test("session gate makes no link request", async () => {
  const calls: string[] = [];
  globalThis.fetch = (async input => { calls.push(String(input)); return response(baseStatus); }) as typeof fetch;
  const host = await mount({ sessionReady: false });
  expect(host.textContent).toContain("Sign in to the local dashboard session");
  expect(calls).toEqual([]);
});

test("off state and role choice issue no mutation request", async () => {
  const calls: Array<{ path: string; method: string }> = [];
  globalThis.fetch = (async (input, init) => { calls.push({ path: new URL(String(input)).pathname, method: init?.method ?? "GET" }); return response(baseStatus); }) as typeof fetch;
  const host = await mount();
  expect(host.querySelector('[role="switch"]')).not.toBeNull();
  await act(async () => { (host.querySelector('[role="switch"]') as HTMLButtonElement).click(); });
  await flush();
  expect(host.textContent).toContain("Choose this computer's role");
  await act(async () => { (host.querySelector('[role="radio"][aria-checked="false"]') as HTMLButtonElement).click(); });
  await flush();
  expect(host.textContent).toContain("Child setup is available");
  expect(calls.every(call => call.method === "GET")).toBe(true);
});

test("workspace card is available only through the availability prop", async () => {
  globalThis.fetch = (async () => response(baseStatus)) as typeof fetch;
  const host = await mount({ workspaceAvailable: true });
  expect(host.textContent).toContain("Remote Workspace has its own page now");
  expect(host.textContent).toContain("Open Remote Workspace");
});

test("compensation failure is rendered with a removal action", async () => {
  const status = { ...baseStatus, links: [{ id: "link-1", alias: "child", direction: "hub-initiated" as const, state: "failed" as const, since: "now", reason: "compensation_failed", tunnelPort: 43110 }] };
  globalThis.fetch = (async () => response(status)) as typeof fetch;
  const host = await mount();
  expect(host.querySelector(".remote-link-error")?.textContent).toBe("Remote link request could not be completed.");
  expect(host.textContent).toContain("Disconnect");
});

test("disconnect failure opens force confirmation and sends force body", async () => {
  const calls: Array<{ method: string; body?: string }> = [];
  globalThis.fetch = (async (input, init) => {
    const path = new URL(String(input)).pathname;
    calls.push({ method: init?.method ?? "GET", body: typeof init?.body === "string" ? init.body : undefined });
    if (path === "/api/link/status") return response({ ...baseStatus, links: [{ id: "link-1", alias: "child", direction: "hub-initiated", state: "connected", since: "now", reason: null, tunnelPort: 43110 }] });
    if (path === "/api/link/link-1" && init?.method === "DELETE" && init.body === undefined) return response({ error: { code: "remote_disconnect_failed" } }, 502);
    return response({ linkId: "link-1" });
  }) as typeof fetch;
  const host = await mount();
  const disconnectButton = [...host.querySelectorAll("button")].find(button => button.textContent?.includes("Disconnect")) as HTMLButtonElement;
  await act(async () => { disconnectButton.click(); });
  await flush();
  const dialogs = [...host.querySelectorAll("dialog")];
  const confirm = dialogs.at(-1) as HTMLDialogElement;
  expect(confirm.textContent).toContain("Disconnect");
  await act(async () => { (confirm.querySelector(".btn-danger") as HTMLButtonElement).click(); });
  await flush();
  expect(confirm.textContent).toContain("Remove here only");
  await act(async () => { (confirm.querySelector(".btn-danger") as HTMLButtonElement).click(); });
  await flush();
  expect(calls.some(call => call.method === "DELETE" && call.body === JSON.stringify({ force: true }))).toBe(true);
});

test("readLinkJson preserves unknown server codes and status", async () => {
  let caught: unknown;
  try { await readLinkJson(new Response(JSON.stringify({ error: { code: "future_code" } }), { status: 418 })); } catch (error) { caught = error; }
  expect(caught).toBeInstanceOf(LinkApiError);
  expect((caught as LinkApiError).code).toBe("future_code");
  expect((caught as LinkApiError).status).toBe(418);
  expect(LOCALES).toHaveLength(10);
});
