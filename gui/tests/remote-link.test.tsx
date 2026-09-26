import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
import RemoteLink from "../src/pages/RemoteLink";
import { boundLinkHint, LINK_ERROR_CODES, LinkApiError, parseRemoteLinkStatus, readLinkJson, type RemoteLinkStatusWire } from "../src/remote-link-api";
import { LanguageProvider } from "../src/i18n/provider";
import { LOCALES } from "../src/i18n/shared";

const baseStatus: RemoteLinkStatusWire = { role: "home", listener: { state: "listening", port: 44123 }, links: [], child: null, joinAvailable: false };
// A paired session on a standalone runtime: the only status that lets the dashboard join as a Child.
const joinableStatus: RemoteLinkStatusWire = { ...baseStatus, role: "standalone", joinAvailable: true };
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
function declareRuntimeRole(role: "standalone" | "hub" | "client"): void {
  const meta = win.document.createElement("meta");
  meta.name = "opencodex-runtime-role";
  meta.content = role;
  win.document.head.append(meta);
}
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

test("joinAvailable is true only when the server says exactly true", () => {
  const withoutJoin: Record<string, unknown> = { ...baseStatus };
  delete withoutJoin.joinAvailable;
  expect(parseRemoteLinkStatus(withoutJoin).joinAvailable).toBe(false);
  expect(parseRemoteLinkStatus({ ...baseStatus, joinAvailable: "true" }).joinAvailable).toBe(false);
  expect(parseRemoteLinkStatus({ ...baseStatus, joinAvailable: 1 }).joinAvailable).toBe(false);
  expect(parseRemoteLinkStatus({ ...baseStatus, joinAvailable: true }).joinAvailable).toBe(true);
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
  expect(host.textContent).toContain("Child links can only be started from a standalone runtime.");
  expect(calls.every(call => call.method === "GET")).toBe(true);
});

test("Child role is disabled unless the served runtime is standalone", async () => {
  globalThis.fetch = (async () => response({ ...baseStatus, role: "home", joinAvailable: true })) as typeof fetch;
  const host = await mount();
  await act(async () => { (host.querySelector('[role="switch"]') as HTMLButtonElement).click(); });
  const child = [...host.querySelectorAll('[role="radio"]')][1] as HTMLButtonElement;
  expect(child.getAttribute("aria-disabled")).toBe("true");
  await act(async () => { child.click(); });
  expect((host.querySelector(".remote-link-sheet") as HTMLDialogElement | null)?.open ?? false).toBe(false);
  await act(async () => { root?.unmount(); });
  root = null;

  declareRuntimeRole("standalone");
  const standaloneHost = await mount();
  await act(async () => { (standaloneHost.querySelector('[role="switch"]') as HTMLButtonElement).click(); });
  const standaloneChild = [...standaloneHost.querySelectorAll('[role="radio"]')][1] as HTMLButtonElement;
  expect(standaloneChild.getAttribute("aria-disabled")).toBe("false");
});

test("local dashboard without join keeps Child disabled, explains why, and never sends a join", async () => {
  declareRuntimeRole("standalone");
  const calls: Array<{ path: string; method: string }> = [];
  globalThis.fetch = (async (input, init) => {
    const path = new URL(String(input)).pathname;
    calls.push({ path, method: init?.method ?? "GET" });
    if (path === "/api/link/candidates") return response({ candidates: [{ alias: "home-one", source: "ssh_config" }] });
    if (path === "/api/link/probe") return response({ alias: "home-one", fingerprint: "SHA256:test", keyType: "ed25519" });
    if (path === "/api/link/confirm-host") return response({ alias: "home-one", fingerprint: "SHA256:test", ocxVersion: "2.66.0" });
    if (path === "/api/link/join") return response({ linkId: "lnk_1234567890abcdef", alias: "home-one", restarting: true }, 202);
    if (path === "/api/link/apply") return response({ linkId: "lnk_1234567890abcdef" }, 202);
    return response({ ...baseStatus, role: "standalone", joinAvailable: false });
  }) as typeof fetch;
  const host = await mount();
  await act(async () => { (host.querySelector('[role="switch"]') as HTMLButtonElement).click(); });
  const radios = () => [...host.querySelectorAll('[role="radio"]')] as HTMLButtonElement[];
  expect(radios()[1]?.getAttribute("aria-disabled")).toBe("true");
  expect(radios()[1]?.tabIndex).toBe(-1);
  expect(host.textContent).toContain("Connecting this computer as a Child from the dashboard is not available in this release");
  expect(host.textContent).toContain("would drop existing Codex connections");
  expect(host.textContent).toContain("choose Home and add the other computer as a Child");
  expect(host.textContent).not.toContain("paired");
  expect(host.textContent).not.toContain("Child links can only be started from a standalone runtime.");

  await act(async () => { radios()[1]?.click(); });
  await act(async () => { radios()[1]?.dispatchEvent(new win.KeyboardEvent("keydown", { key: "Home", bubbles: true })); });
  for (const key of ["ArrowRight", "ArrowDown", "End"]) {
    await act(async () => { radios()[0]?.dispatchEvent(new win.KeyboardEvent("keydown", { key, bubbles: true })); });
  }
  await flush();
  expect(radios()[1]?.getAttribute("aria-checked")).toBe("false");
  expect(radios()[1]?.tabIndex).toBe(-1);
  expect((host.querySelector(".remote-link-sheet") as HTMLDialogElement).open).toBe(false);
  expect(calls.some(call => call.path === "/api/link/candidates")).toBe(false);

  // The Home side still works from this dashboard: Continue opens the host sheet and applies.
  await act(async () => { [...host.querySelectorAll("button")].find(button => button.textContent === "Continue")?.click(); });
  await flush();
  expect((host.querySelector(".remote-link-sheet") as HTMLDialogElement).open).toBe(true);
  await act(async () => { (host.querySelector(".remote-link-candidate") as HTMLButtonElement).click(); });
  await act(async () => { [...host.querySelectorAll("button")].find(button => button.textContent?.includes("Test connection"))?.click(); });
  await flush();
  await act(async () => { (host.querySelector('input[type="checkbox"]') as HTMLInputElement).click(); });
  await act(async () => { [...host.querySelectorAll("button")].find(button => button.textContent?.includes("Confirm host"))?.click(); });
  await flush();
  expect([...host.querySelectorAll("button")].some(button => button.textContent?.includes("Connect as Child"))).toBe(false);
  await act(async () => { [...host.querySelectorAll("button")].find(button => button.textContent?.includes("Connect child"))?.click(); });
  await flush();
  expect(calls.some(call => call.path === "/api/link/apply" && call.method === "POST")).toBe(true);
  expect(calls.some(call => call.path === "/api/link/join")).toBe(false);
});

test("standalone Child flow joins with exactly the confirmed alias and shows restart waiting", async () => {
  declareRuntimeRole("standalone");
  const calls: Array<{ path: string; method: string; body?: string }> = [];
  globalThis.fetch = (async (input, init) => {
    const path = new URL(String(input)).pathname;
    calls.push({ path, method: init?.method ?? "GET", body: typeof init?.body === "string" ? init.body : undefined });
    if (path === "/api/link/candidates") return response({ candidates: [{ alias: "home-one", source: "ssh_config" }] });
    if (path === "/api/link/probe") return response({ alias: "home-one", fingerprint: "SHA256:test", keyType: "ed25519" });
    if (path === "/api/link/confirm-host") return response({ alias: "home-one", fingerprint: "SHA256:test", ocxVersion: "2.0.0" });
    if (path === "/api/link/join") return response({ linkId: "lnk_1234567890abcdef", alias: "home-one", restarting: true }, 202);
    return response(joinableStatus);
  }) as typeof fetch;
  const host = await mount();
  await act(async () => { (host.querySelector('[role="switch"]') as HTMLButtonElement).click(); });
  await act(async () => { ([...host.querySelectorAll('[role="radio"]')][1] as HTMLButtonElement).click(); });
  await flush();
  await act(async () => { (host.querySelector(".remote-link-candidate") as HTMLButtonElement).click(); });
  await act(async () => { [...host.querySelectorAll("button")].find(button => button.textContent?.includes("Test connection"))?.click(); });
  await flush();
  await act(async () => { (host.querySelector('input[type="checkbox"]') as HTMLInputElement).click(); });
  await act(async () => { [...host.querySelectorAll("button")].find(button => button.textContent?.includes("Confirm host"))?.click(); });
  await flush();
  expect(calls.some(call => call.path === "/api/link/join")).toBe(false);
  await act(async () => { [...host.querySelectorAll("button")].find(button => button.textContent?.includes("Connect as Child"))?.click(); });
  await flush();
  expect(calls.find(call => call.path === "/api/link/join")?.body).toBe(JSON.stringify({ alias: "home-one" }));
  expect(calls.some(call => call.path === "/api/link/apply")).toBe(false);
  expect(host.textContent).toContain("This computer will restart to connect as a Child.");
  expect(host.textContent).toContain("Waiting for this computer to reconnect as Child");
});

test("join failure maps actionable errors and Retry re-joins the confirmed alias", async () => {
  declareRuntimeRole("standalone");
  let joins = 0;
  globalThis.fetch = (async input => {
    const path = new URL(String(input)).pathname;
    if (path === "/api/link/candidates") return response({ candidates: [{ alias: "home-one", source: "ssh_config" }] });
    if (path === "/api/link/probe") return response({ alias: "home-one", fingerprint: "SHA256:test", keyType: "ed25519" });
    if (path === "/api/link/confirm-host") return response({ alias: "home-one", fingerprint: "SHA256:test", ocxVersion: "2.0.0" });
    if (path === "/api/link/join") {
      joins += 1;
      return joins === 1 ? response({ error: { code: "join_tunnel_failed" } }, 502) : response({ linkId: "lnk_1234567890abcdef", alias: "home-one", restarting: true }, 202);
    }
    return response(joinableStatus);
  }) as typeof fetch;
  const host = await mount();
  await act(async () => { (host.querySelector('[role="switch"]') as HTMLButtonElement).click(); });
  await act(async () => { ([...host.querySelectorAll('[role="radio"]')][1] as HTMLButtonElement).click(); });
  await flush();
  await act(async () => { (host.querySelector(".remote-link-candidate") as HTMLButtonElement).click(); });
  await act(async () => { [...host.querySelectorAll("button")].find(button => button.textContent?.includes("Test connection"))?.click(); });
  await flush();
  await act(async () => { (host.querySelector('input[type="checkbox"]') as HTMLInputElement).click(); });
  await act(async () => { [...host.querySelectorAll("button")].find(button => button.textContent?.includes("Confirm host"))?.click(); });
  await flush();
  await act(async () => { [...host.querySelectorAll("button")].find(button => button.textContent?.includes("Connect as Child"))?.click(); });
  await flush();
  expect(host.textContent).toContain("The tunnel to Home could not be started.");
  await act(async () => { [...host.querySelectorAll("button")].find(button => button.textContent?.includes("Retry"))?.click(); });
  await flush();
  expect(joins).toBe(2);
  expect(host.textContent).toContain("This computer will restart to connect as a Child.");
});

test("join maps standalone_required to an actionable message", async () => {
  declareRuntimeRole("standalone");
  globalThis.fetch = (async input => {
    const path = new URL(String(input)).pathname;
    if (path === "/api/link/candidates") return response({ candidates: [{ alias: "home-one", source: "ssh_config" }] });
    if (path === "/api/link/probe") return response({ alias: "home-one", fingerprint: "SHA256:test", keyType: "ed25519" });
    if (path === "/api/link/confirm-host") return response({ alias: "home-one", fingerprint: "SHA256:test", ocxVersion: "2.0.0" });
    if (path === "/api/link/join") return response({ error: { code: "standalone_required" } }, 409);
    return response(joinableStatus);
  }) as typeof fetch;
  const host = await mount();
  await act(async () => { (host.querySelector('[role="switch"]') as HTMLButtonElement).click(); });
  await act(async () => { ([...host.querySelectorAll('[role="radio"]')][1] as HTMLButtonElement).click(); });
  await flush();
  await act(async () => { (host.querySelector(".remote-link-candidate") as HTMLButtonElement).click(); });
  await act(async () => { [...host.querySelectorAll("button")].find(button => button.textContent?.includes("Test connection"))?.click(); });
  await flush();
  await act(async () => { (host.querySelector('input[type="checkbox"]') as HTMLInputElement).click(); });
  await act(async () => { [...host.querySelectorAll("button")].find(button => button.textContent?.includes("Confirm host"))?.click(); });
  await flush();
  await act(async () => { [...host.querySelectorAll("button")].find(button => button.textContent?.includes("Connect as Child"))?.click(); });
  await flush();
  expect(host.textContent).toContain("Child links can only be started from a standalone runtime.");
});

test("join_restart_failed shows restart guidance without Retry", async () => {
  declareRuntimeRole("standalone");
  globalThis.fetch = (async input => {
    const path = new URL(String(input)).pathname;
    if (path === "/api/link/candidates") return response({ candidates: [{ alias: "home-one", source: "ssh_config" }] });
    if (path === "/api/link/probe") return response({ alias: "home-one", fingerprint: "SHA256:test", keyType: "ed25519" });
    if (path === "/api/link/confirm-host") return response({ alias: "home-one", fingerprint: "SHA256:test", ocxVersion: "2.0.0" });
    if (path === "/api/link/join") return response({ error: { code: "join_restart_failed" } }, 500);
    return response(joinableStatus);
  }) as typeof fetch;
  const host = await mount();
  await act(async () => { (host.querySelector('[role="switch"]') as HTMLButtonElement).click(); });
  await act(async () => { ([...host.querySelectorAll('[role="radio"]')][1] as HTMLButtonElement).click(); });
  await flush();
  await act(async () => { (host.querySelector(".remote-link-candidate") as HTMLButtonElement).click(); });
  await act(async () => { [...host.querySelectorAll("button")].find(button => button.textContent?.includes("Test connection"))?.click(); });
  await flush();
  await act(async () => { (host.querySelector('input[type="checkbox"]') as HTMLInputElement).click(); });
  await act(async () => { [...host.querySelectorAll("button")].find(button => button.textContent?.includes("Confirm host"))?.click(); });
  await flush();
  await act(async () => { [...host.querySelectorAll("button")].find(button => button.textContent?.includes("Connect as Child"))?.click(); });
  await flush();
  expect(host.textContent).toContain("The link is ready. Restart OpenCodex on this computer to finish connecting as a Child.");
  expect(host.textContent).not.toContain("Retry");
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
  expect((caught as LinkApiError).hint).toBeNull();
  expect(LOCALES).toHaveLength(10);
  let hinted: unknown;
  try { await readLinkJson(new Response(JSON.stringify({ error: { code: "probe_failed", hint: `bad\u202e\u0007 line ${"x".repeat(300)}` } }), { status: 502 })); } catch (error) { hinted = error; }
  const hint = (hinted as LinkApiError).hint ?? "";
  expect(hint.startsWith("bad line x")).toBe(true);
  expect(hint).toHaveLength(160);
  expect(hint.endsWith("…")).toBe(true);
  expect(boundLinkHint(42)).toBeNull();
  expect(boundLinkHint(" \n ")).toBeNull();
});

test("boundLinkHint caps astral hints by code point and never leaves a lone surrogate", () => {
  const astral = String.fromCodePoint(0x1f511);
  // 200 astral characters are 400 UTF-16 units; a unit-based cut at 159 would split a pair.
  const points = Array.from(boundLinkHint(astral.repeat(200)) ?? "");
  expect(points).toHaveLength(160);
  expect(points.at(-1)).toBe(String.fromCodePoint(0x2026));
  expect(points.slice(0, -1).every(point => point === astral)).toBe(true);
  expect(points.every(point => { const code = point.codePointAt(0)!; return code < 0xd800 || code > 0xdfff; })).toBe(true);
  expect(boundLinkHint(astral.repeat(160))).toBe(astral.repeat(160));
});

test("choosing Home then Continue opens the SSH host sheet with candidates", async () => {
  const calls: string[] = [];
  globalThis.fetch = (async input => {
    const path = new URL(String(input)).pathname;
    calls.push(path);
    if (path === "/api/link/candidates") return response({ candidates: [{ alias: "child-one", source: "ssh_config" }] });
    return response({ ...baseStatus, role: "standalone" });
  }) as typeof fetch;
  const host = await mount();
  await act(async () => { (host.querySelector('[role="switch"]') as HTMLButtonElement).click(); });
  expect(host.querySelector('[role="radio"][aria-checked="true"]')?.textContent).toContain("Home");
  await act(async () => { [...host.querySelectorAll("button")].find(button => button.textContent === "Continue")?.click(); });
  await flush();
  expect((host.querySelector(".remote-link-sheet") as HTMLDialogElement).open).toBe(true);
  expect(calls).toContain("/api/link/candidates");
  expect(host.querySelector(".remote-link-candidate")?.textContent).toContain("child-one");
});

test("Continue stays disabled while this computer is already a Child", async () => {
  globalThis.fetch = (async () => response({ ...baseStatus, role: "child", child: { alias: "home-one", state: "connected", since: "now", reason: null } })) as typeof fetch;
  const host = await mount();
  await act(async () => { (host.querySelector('[role="switch"]') as HTMLButtonElement).click(); });
  expect(([...host.querySelectorAll("button")].find(button => button.textContent === "Continue") as HTMLButtonElement).disabled).toBe(true);
});

test("probe failure stays visible and Retry probes the failed alias", async () => {
  let probes = 0;
  globalThis.fetch = (async input => {
    const path = new URL(String(input)).pathname;
    if (path === "/api/link/probe") { probes += 1; return response({ error: { code: "probe_failed", hint: "child-one: Permission denied (publickey)." } }, 502); }
    if (path === "/api/link/candidates") return response({ candidates: [{ alias: "child-one", source: "ssh config" }] });
    return response(baseStatus);
  }) as typeof fetch;
  const host = await mount();
  await act(async () => { (host.querySelector('[role="switch"]') as HTMLButtonElement).click(); });
  await act(async () => { (host.querySelector(".btn-primary") as HTMLButtonElement).click(); });
  await flush();
  await act(async () => { (host.querySelector(".remote-link-candidate") as HTMLButtonElement).click(); });
  await act(async () => { [...host.querySelectorAll("button")].find(button => button.textContent?.includes("Test connection"))?.click(); });
  await flush();
  expect(host.textContent).toContain("Could not connect to the SSH host. Check that it accepts your SSH key");
  expect(host.querySelector(".remote-link-hint code")?.textContent).toBe("child-one: Permission denied (publickey).");
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
  declareRuntimeRole("standalone");
  globalThis.fetch = (async () => response(joinableStatus)) as typeof fetch;
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

test("cancelling a join ignores a late failure", async () => {
  declareRuntimeRole("standalone");
  let releaseJoin!: (value: Response) => void;
  const joinResponse = new Promise<Response>(resolve => { releaseJoin = resolve; });
  globalThis.fetch = (async input => {
    const path = new URL(String(input)).pathname;
    if (path === "/api/link/candidates") return response({ candidates: [{ alias: "home-one", source: "ssh_config" }] });
    if (path === "/api/link/probe") return response({ alias: "home-one", fingerprint: "SHA256:test", keyType: "ed25519" });
    if (path === "/api/link/confirm-host") return response({ alias: "home-one", fingerprint: "SHA256:test", ocxVersion: "2.0.0" });
    if (path === "/api/link/join") return joinResponse;
    return response(joinableStatus);
  }) as typeof fetch;
  const host = await mount();
  await act(async () => { (host.querySelector('[role="switch"]') as HTMLButtonElement).click(); });
  await act(async () => { ([...host.querySelectorAll('[role="radio"]')][1] as HTMLButtonElement).click(); });
  await flush();
  await act(async () => { (host.querySelector(".remote-link-candidate") as HTMLButtonElement).click(); });
  await act(async () => { [...host.querySelectorAll("button")].find(button => button.textContent?.includes("Test connection"))?.click(); });
  await flush();
  await act(async () => { (host.querySelector('input[type="checkbox"]') as HTMLInputElement).click(); });
  await act(async () => { [...host.querySelectorAll("button")].find(button => button.textContent?.includes("Confirm host"))?.click(); });
  await flush();
  await act(async () => { [...host.querySelectorAll("button")].find(button => button.textContent?.includes("Connect as Child"))?.click(); });
  await act(async () => { [...host.querySelectorAll("button")].find(button => button.textContent === "Cancel")?.click(); });
  releaseJoin(response({ error: { code: "join_tunnel_failed" } }, 502));
  await flush();
  expect(host.textContent).not.toContain("Retry");
  expect(host.textContent).not.toContain("The tunnel to Home could not be started.");
});

test("cancelling candidates prevents a late response from appearing in a new attempt", async () => {
  let releaseFirst!: (value: Response) => void;
  let candidateCalls = 0;
  const firstCandidates = new Promise<Response>(resolve => { releaseFirst = resolve; });
  globalThis.fetch = (async input => {
    const path = new URL(String(input)).pathname;
    if (path === "/api/link/candidates") {
      candidateCalls += 1;
      return candidateCalls === 1 ? firstCandidates : response({ candidates: [{ alias: "new-home", source: "ssh_config" }] });
    }
    return response(baseStatus);
  }) as typeof fetch;
  const host = await mount();
  await act(async () => { (host.querySelector('[role="switch"]') as HTMLButtonElement).click(); });
  await act(async () => { (host.querySelector(".btn-primary") as HTMLButtonElement).click(); });
  await act(async () => { [...host.querySelectorAll("button")].find(button => button.textContent === "Cancel")?.click(); });
  await act(async () => { [...host.querySelectorAll("button")].find(button => button.textContent?.includes("Add child"))?.click(); });
  await flush();
  releaseFirst(response({ candidates: [{ alias: "stale-home", source: "ssh_config" }] }));
  await flush();
  expect(host.textContent).toContain("new-home");
  expect(host.textContent).not.toContain("stale-home");
});
