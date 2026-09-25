import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
import RemoteLink from "../src/pages/RemoteLink";
import { LINK_ERROR_CODES, LinkApiError, parseRemoteLinkStatus, readLinkJson, type RemoteLinkStatusWire } from "../src/remote-link-api";
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
  expect(host.querySelector(".remote-link-error")?.textContent).toBe("Cleanup after linking failed.");
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

test("probe failure stays visible and Retry probes the failed alias", async () => {
  let probes = 0;
  globalThis.fetch = (async input => {
    const path = new URL(String(input)).pathname;
    if (path === "/api/link/probe") { probes += 1; return response({ error: { code: "probe_failed" } }, 502); }
    if (path === "/api/link/candidates") return response({ candidates: [{ alias: "child-one", source: "ssh config" }] });
    return response(baseStatus);
  }) as typeof fetch;
  const host = await mount();
  await act(async () => { (host.querySelector('[role="switch"]') as HTMLButtonElement).click(); });
  await act(async () => { (host.querySelector(".btn-primary") as HTMLButtonElement).click(); });
  await act(async () => { [...host.querySelectorAll("button")].find(button => button.textContent?.includes("Add child"))?.click(); });
  await flush();
  await act(async () => { (host.querySelector(".remote-link-candidate") as HTMLButtonElement).click(); });
  await act(async () => { [...host.querySelectorAll("button")].find(button => button.textContent?.includes("Test connection"))?.click(); });
  await flush();
  expect(host.textContent).toContain("Remote link request could not be completed.");
  expect(host.textContent).toContain("Retry");
  await act(async () => { [...host.querySelectorAll("button")].find(button => button.textContent?.includes("Retry"))?.click(); });
  await flush();
  expect(probes).toBe(2);
});

test("apply failure stays retryable and Retry reapplies the confirmed alias", async () => {
  let applies = 0;
  globalThis.fetch = (async input => {
    const path = new URL(String(input)).pathname;
    if (path === "/api/link/candidates") return response({ candidates: [{ alias: "child-one", source: "ssh config" }] });
    if (path === "/api/link/probe") return response({ alias: "child-one", fingerprint: "SHA256:test", keyType: "ed25519" });
    if (path === "/api/link/confirm-host") return response({ alias: "child-one", fingerprint: "SHA256:test", ocxVersion: "2.0.0" });
    if (path === "/api/link/apply") { applies += 1; return applies === 1 ? response({ error: { code: "link_apply_failed" } }, 502) : response({ linkId: "link-1" }, 202); }
    return response(baseStatus);
  }) as typeof fetch;
  const host = await mount();
  await act(async () => { (host.querySelector('[role="switch"]') as HTMLButtonElement).click(); });
  await act(async () => { (host.querySelector(".btn-primary") as HTMLButtonElement).click(); });
  await act(async () => { [...host.querySelectorAll("button")].find(button => button.textContent?.includes("Add child"))?.click(); });
  await flush();
  await act(async () => { (host.querySelector(".remote-link-candidate") as HTMLButtonElement).click(); });
  await act(async () => { [...host.querySelectorAll("button")].find(button => button.textContent?.includes("Test connection"))?.click(); });
  await flush();
  await act(async () => { (host.querySelector('input[type="checkbox"]') as HTMLInputElement).click(); });
  await act(async () => { [...host.querySelectorAll("button")].find(button => button.textContent?.includes("Confirm host"))?.click(); });
  await flush();
  await act(async () => { [...host.querySelectorAll("button")].find(button => button.textContent?.includes("Connect child"))?.click(); });
  await flush();
  expect(host.textContent).toContain("Retry");
  await act(async () => { [...host.querySelectorAll("button")].find(button => button.textContent?.includes("Retry"))?.click(); });
  await flush();
  expect(applies).toBe(2);
});

test("role radios use roving tabIndex and arrow, Home, and End keys", async () => {
  globalThis.fetch = (async () => response(baseStatus)) as typeof fetch;
  const host = await mount();
  await act(async () => { (host.querySelector('[role="switch"]') as HTMLButtonElement).click(); });
  const radios = () => [...host.querySelectorAll('[role="radio"]')] as HTMLButtonElement[];
  expect(radios()[0]?.tabIndex).toBe(0);
  expect(radios()[1]?.tabIndex).toBe(-1);
  await act(async () => { radios()[0]?.dispatchEvent(new win.KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })); });
  expect(radios()[1]?.tabIndex).toBe(0);
  expect(win.document.activeElement).toBe(radios()[1]);
  await act(async () => { radios()[1]?.dispatchEvent(new win.KeyboardEvent("keydown", { key: "Home", bubbles: true })); });
  expect(radios()[0]?.tabIndex).toBe(0);
  await act(async () => { radios()[0]?.dispatchEvent(new win.KeyboardEvent("keydown", { key: "End", bubbles: true })); });
  expect(radios()[1]?.tabIndex).toBe(0);
});

test("status polling ignores a delayed older response", async () => {
  let releaseOld: (() => void) | null = null;
  let oldSignal: AbortSignal | undefined;
  const old = new Promise<Response>(resolve => { releaseOld = () => resolve(response(baseStatus)); });
  let statusCalls = 0;
  globalThis.fetch = (async (input, init) => {
    if (new URL(String(input)).pathname !== "/api/link/status") return response(baseStatus);
    statusCalls += 1;
    if (statusCalls === 1) oldSignal = init?.signal;
    return statusCalls === 1 ? old : response({ ...baseStatus, links: [{ id: "link-1", alias: "newer", direction: "hub-initiated", state: "connected", since: "now", reason: null, tunnelPort: 43110 }] });
  }) as typeof fetch;
  const host = await mount();
  await act(async () => { [...host.querySelectorAll("button")].find(button => button.textContent?.includes("Refresh"))?.click(); });
  await flush();
  expect(oldSignal?.aborted).toBe(true);
  expect(host.textContent).toContain("newer");
  releaseOld?.();
  await flush();
  expect(host.textContent).toContain("newer");
});

test("disconnect confirmation restores focus on cancel, Escape, and completion", async () => {
  globalThis.fetch = (async (input, init) => {
    const path = new URL(String(input)).pathname;
    if (path === "/api/link/status") return response({ ...baseStatus, links: [{ id: "link-1", alias: "child", direction: "hub-initiated", state: "connected", since: "now", reason: null, tunnelPort: 43110 }] });
    if (init?.method === "DELETE") return response({ linkId: "link-1" });
    return response(baseStatus);
  }) as typeof fetch;
  const host = await mount();
  const disconnect = [...host.querySelectorAll("button")].find(button => button.textContent?.includes("Disconnect")) as HTMLButtonElement;
  await act(async () => { disconnect.click(); });
  await act(async () => { (host.querySelector(".remote-link-confirm-dialog .btn-ghost") as HTMLButtonElement).click(); });
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(win.document.activeElement).toBe(disconnect);
  await act(async () => { disconnect.click(); });
  await act(async () => { host.querySelector(".remote-link-confirm-dialog")?.dispatchEvent(new win.Event("cancel", { bubbles: true, cancelable: true })); });
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(win.document.activeElement).toBe(disconnect);
  await act(async () => { disconnect.click(); });
  await act(async () => { (host.querySelector(".remote-link-confirm-dialog .btn-danger") as HTMLButtonElement).click(); });
  await flush();
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(win.document.activeElement).toBe(disconnect);
});

test("known and unknown status reasons remain understandable", async () => {
  const status = { ...baseStatus, links: [
    { id: "known", alias: "known", direction: "hub-initiated" as const, state: "failed" as const, since: "now", reason: "timeout", tunnelPort: 43110 },
    { id: "unknown", alias: "unknown", direction: "hub-initiated" as const, state: "failed" as const, since: "now", reason: "future reason", tunnelPort: 43111 },
  ] };
  globalThis.fetch = (async () => response(status)) as typeof fetch;
  const host = await mount();
  expect(host.textContent).toContain("The connection timed out.");
  expect(host.querySelector("code")?.textContent).toBe("future reason");
});

test("cancelling a failed apply leaves no dead Retry behind", async () => {
  globalThis.fetch = (async (input) => {
    const path = new URL(String(input)).pathname;
    if (path === "/api/link/candidates") return response({ candidates: [{ alias: "child-one", source: "ssh config" }] });
    if (path === "/api/link/probe") return response({ alias: "child-one", fingerprint: "SHA256:test", keyType: "ed25519" });
    if (path === "/api/link/confirm-host") return response({ alias: "child-one", fingerprint: "SHA256:test", ocxVersion: "2.0.0" });
    if (path === "/api/link/apply") return response({ error: { code: "link_apply_failed" } }, 502);
    return response(baseStatus);
  }) as typeof fetch;
  const host = await mount();
  await act(async () => { (host.querySelector('[role="switch"]') as HTMLButtonElement).click(); });
  await act(async () => { (host.querySelector(".btn-primary") as HTMLButtonElement).click(); });
  await act(async () => { [...host.querySelectorAll("button")].find(button => button.textContent?.includes("Add child"))?.click(); });
  await flush();
  await act(async () => { (host.querySelector(".remote-link-candidate") as HTMLButtonElement).click(); });
  await act(async () => { [...host.querySelectorAll("button")].find(button => button.textContent?.includes("Test connection"))?.click(); });
  await flush();
  await act(async () => { (host.querySelector('input[type="checkbox"]') as HTMLInputElement).click(); });
  await act(async () => { [...host.querySelectorAll("button")].find(button => button.textContent?.includes("Confirm host"))?.click(); });
  await flush();
  await act(async () => { [...host.querySelectorAll("button")].find(button => button.textContent?.includes("Connect child"))?.click(); });
  await flush();
  expect(host.textContent).toContain("Retry");
  await act(async () => { [...host.querySelectorAll("button")].find(button => button.textContent === "Cancel")?.click(); });
  await flush();
  expect([...host.querySelectorAll("button")].some(button => button.textContent === "Retry")).toBe(false);
  expect([...host.querySelectorAll("button")].some(button => button.textContent?.includes("Add child"))).toBe(true);
});
