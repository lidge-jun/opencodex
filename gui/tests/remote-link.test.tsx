import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { Window } from "happy-dom";
import type { Root } from "react-dom/client";
import { act } from "react";
import RemoteLink from "../src/pages/RemoteLink";
import { RemoteLinkSheet } from "../src/pages/RemoteLinkSheet";
import { boundLinkHint, CHILD_RESTART_NOTICE_MS, CHILD_RESTART_POLL_MS, CHILD_RESTART_SLOW_POLL_MS, LINK_ERROR_CODES, LINK_JOIN_DENIALS, LinkApiError, parseRemoteLinkStatus, readLinkJson, waitForChildRuntime, type RemoteLinkStatusWire } from "../src/remote-link-api";
import { LanguageProvider } from "../src/i18n/provider";
import { LOCALES } from "../src/i18n/shared";

const baseStatus: RemoteLinkStatusWire = { role: "home", listener: { state: "listening", port: 44123 }, links: [], child: null, joinAvailable: false };
// A dashboard session on a standalone runtime that runs on its configured port may join as a Child.
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
  try {
    if (root) await act(async () => { root?.unmount(); });
  } finally {
    root = null;
    try { await win.happyDOM.close(); } finally {
      for (const key of globals) Object.defineProperty(globalThis, key, { configurable: true, value: previous[key] });
    }
  }
});

function response(body: unknown, status = 200): Response { return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }); }
async function flush(): Promise<void> { await act(async () => { await Promise.resolve(); await Promise.resolve(); }); }
/** Let real timers and fetch stubs run until `done` holds, bounded so a regression fails instead of hanging. */
async function settleUntil(done: () => boolean, limitMs = 2_000): Promise<void> {
  const deadline = Date.now() + limitMs;
  while (!done() && Date.now() < deadline) await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
}
function declareRuntimeRole(role: "standalone" | "hub" | "client"): void {
  const meta = win.document.createElement("meta");
  meta.name = "opencodex-runtime-role";
  meta.content = role;
  win.document.head.append(meta);
}
async function mount(props: Partial<React.ComponentProps<typeof RemoteLink>> = {}): Promise<HTMLDivElement> {
  const host = win.document.createElement("div");
  win.document.body.append(host);
  root = (await import("react-dom/client")).createRoot(host);
  await act(async () => { root?.render(<LanguageProvider><RemoteLink apiBase="http://fixture" sessionReady {...props} /></LanguageProvider>); });
  await flush();
  return host;
}

test("current translated link errors remain implemented across route and enrollment owners", async () => {
  // Child operations answer their own refusals through a `switch (code) { case "x": return fail(code, ...) }`
  // block instead of `fail("x", ...)` calls, so the second pattern counts that switch.
  const source = (await Promise.all(["link-routes", "link-enrollment", "link-route-state", "link-child-ops-routes"].map(name =>
    Bun.file(`../src/server/management/${name}.ts`).text()))).join("\n");
  // DELETE --purge forwards the code purgeDisconnectRemote chose, so its literals count as route codes.
  const purgeSource = await Bun.file("../src/link/remote-plant.ts").text();
  const fromRoutes = [
    ...[...source.matchAll(/(?:fail\(|remoteFailure\([^,\n]+,\s*)"([a-z_]+)"/g)].map(match => match[1]),
    ...[...source.matchAll(/case "([a-z_]+)": return fail\(code/g)].map(match => match[1]),
    ...[...purgeSource.matchAll(/\bcode: "([a-z_]+)"/g)].map(match => match[1]),
  ].filter((value, index, all) => all.indexOf(value) === index).sort();
  // New phase errors use generic text. These two old-server translations remain compatible
  // although enrollment now reports child_relay_timeout and phase-specific failures instead.
  const legacyOnly = new Set(["admission_timeout", "link_apply_failed"]);
  expect(fromRoutes.filter(code => (LINK_ERROR_CODES as readonly string[]).includes(code))).toEqual(
    LINK_ERROR_CODES.filter(code => !legacyOnly.has(code)).sort());
});

test("parses every wire state without changing the DTO", () => {
  for (const state of ["connecting", "connected", "reconnecting", "failed", "idle"] as const) {
    const parsed = parseRemoteLinkStatus({ ...baseStatus, links: [{ id: "lnk_0000000000000001", alias: "child", direction: "hub-initiated", state, since: "now", reason: state === "failed" ? "compensation_failed" : null, tunnelPort: 43110 }] });
    expect(parsed.links[0]?.state).toBe(state);
  }
  expect(parseRemoteLinkStatus({ ...baseStatus, role: "standalone", listener: { state: "off", port: null }, child: { alias: "child", state: "idle", since: "now", reason: null } }).child?.state).toBe("idle");
});

test("a status row whose id is not a link id is refused, so the dashboard never builds a command from it", () => {
  // The force-remove dialog copies the id into a shell command (ocx link recover --link-id <id>).
  const row = { alias: "child", direction: "hub-initiated", state: "connected", since: "now", reason: null, tunnelPort: 43110 };
  for (const id of ["lnk_0000000000000001; touch /tmp/x", "$(id)", "link-1", "lnk_000000000000000G", "lnk_00000000000000011"]) {
    expect(() => parseRemoteLinkStatus({ ...baseStatus, links: [{ ...row, id }] }), id).toThrow("invalid link");
  }
  expect(parseRemoteLinkStatus({ ...baseStatus, links: [{ ...row, id: "lnk_0123456789abcdef" }] }).links[0]?.id).toBe("lnk_0123456789abcdef");
});

test("joinAvailable is true only when the server says exactly true", () => {
  const withoutJoin: Record<string, unknown> = { ...baseStatus };
  delete withoutJoin.joinAvailable;
  expect(parseRemoteLinkStatus(withoutJoin).joinAvailable).toBe(false);
  expect(parseRemoteLinkStatus({ ...baseStatus, joinAvailable: "true" }).joinAvailable).toBe(false);
  expect(parseRemoteLinkStatus({ ...baseStatus, joinAvailable: 1 }).joinAvailable).toBe(false);
  expect(parseRemoteLinkStatus({ ...baseStatus, joinAvailable: true }).joinAvailable).toBe(true);
});

test("joinDenied accepts only known causes and tolerates legacy or future status responses", () => {
  for (const joinDenied of LINK_JOIN_DENIALS) {
    expect(parseRemoteLinkStatus({ ...baseStatus, joinDenied }).joinDenied).toBe(joinDenied);
  }
  for (const joinDenied of [undefined, null, "future_gate", true, 1, {}, []]) {
    const parsed = parseRemoteLinkStatus({ ...baseStatus, joinDenied });
    expect(parsed.joinDenied).toBeNull();
    expect(parsed.joinAvailable).toBe(false);
  }
  expect(parseRemoteLinkStatus(joinableStatus).joinAvailable).toBe(true);
});

test.each([
  ["pairing_required", "Pair this machine first to join as a Child.", true],
  ["standalone_required", "Child links can only be started from a standalone runtime.", false],
  ["join_port_mismatch", "OpenCodex is not running on its configured port", false],
  [undefined, "Joining as a Child is unavailable for this dashboard session.", false],
  ["future_gate", "Joining as a Child is unavailable for this dashboard session.", false],
] as const)("disabled Child explains %s without issuing a mutation", async (joinDenied, message, showPairing) => {
  win.happyDOM.setURL("http://127.0.0.1:10100/#remote");
  declareRuntimeRole("standalone");
  const calls: Array<{ path: string; method: string }> = [];
  globalThis.fetch = (async (input, init) => {
    calls.push({ path: new URL(String(input)).pathname, method: init?.method ?? "GET" });
    return response({ ...baseStatus, role: "standalone", joinAvailable: false, joinDenied });
  }) as typeof fetch;
  const host = await mount({ apiBase: win.location.origin });
  await act(async () => { (host.querySelector('[role="switch"]') as HTMLButtonElement).click(); });
  const radios = [...host.querySelectorAll('[role="radio"]')] as HTMLButtonElement[];
  expect(radios[1]?.getAttribute("aria-disabled")).toBe("true");
  expect(host.textContent).toContain(message);
  if (joinDenied !== "join_port_mismatch") expect(host.textContent).not.toContain("OpenCodex is not running on its configured port");
  expect(host.querySelector(".connect-pairing") !== null).toBe(showPairing);
  await act(async () => { radios[1]?.click(); });
  for (const key of ["ArrowRight", "ArrowDown", "End"]) {
    await act(async () => { radios[0]?.dispatchEvent(new win.KeyboardEvent("keydown", { key, bubbles: true })); });
  }
  expect(radios[1]?.getAttribute("aria-checked")).toBe("false");
  expect(radios[1]?.tabIndex).toBe(-1);
  expect(calls.every(call => call.path === "/api/link/status" && call.method === "GET")).toBe(true);
});

test("refreshing a now-paired status removes pairing guidance without automatically joining", async () => {
  win.happyDOM.setURL("http://127.0.0.1:10100/#remote");
  declareRuntimeRole("standalone");
  let current: RemoteLinkStatusWire = { ...baseStatus, role: "standalone", joinDenied: "pairing_required" };
  const calls: Array<{ path: string; method: string }> = [];
  globalThis.fetch = (async (input, init) => {
    calls.push({ path: new URL(String(input)).pathname, method: init?.method ?? "GET" });
    return response(current);
  }) as typeof fetch;
  const host = await mount({ apiBase: win.location.origin });
  await act(async () => { (host.querySelector('[role="switch"]') as HTMLButtonElement).click(); });
  expect(host.querySelector(".connect-pairing")).not.toBeNull();
  current = { ...joinableStatus, joinDenied: null };
  await act(async () => { [...host.querySelectorAll("button")].find(button => button.textContent === "Refresh")?.click(); });
  await flush();
  expect(host.textContent).not.toContain("Pair this machine first");
  expect(host.querySelector(".connect-pairing")).toBeNull();
  expect(host.querySelectorAll('[role="radio"]')[1]?.getAttribute("aria-disabled")).toBe("false");
  expect(calls.every(call => call.path === "/api/link/status" && call.method === "GET")).toBe(true);
});

test("diagnostics read the page's diagnostics base, not the shared Home relay", async () => {
  const urls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    urls.push(url);
    if (url.includes("/api/link/diagnostics")) return response({ schema: "ocx.link.diagnostics/1", files: [], matched: 0, skipped: 0, records: [] });
    return response(baseStatus);
  }) as typeof fetch;
  const host = await mount({ apiBase: "http://child/api/machine/hub-relay", diagnosticsApiBase: "http://child" });
  await act(async () => { host.querySelector<HTMLButtonElement>("[data-action='link-diagnostics-toggle']")!.click(); });
  await settleUntil(() => urls.some(url => url.includes("/api/link/diagnostics")));
  expect(urls.filter(url => url.includes("/api/link/diagnostics"))).toEqual(["http://child/api/link/diagnostics?limit=100"]);
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

test("a standalone off its configured port keeps Child disabled, explains why, and never sends a join", async () => {
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
    return response({ ...baseStatus, role: "standalone", joinAvailable: false, joinDenied: "join_port_mismatch" });
  }) as typeof fetch;
  const host = await mount();
  await act(async () => { (host.querySelector('[role="switch"]') as HTMLButtonElement).click(); });
  const radios = () => [...host.querySelectorAll('[role="radio"]')] as HTMLButtonElement[];
  expect(radios()[1]?.getAttribute("aria-disabled")).toBe("true");
  expect(radios()[1]?.tabIndex).toBe(-1);
  expect(host.textContent).toContain("OpenCodex is not running on its configured port, so it cannot restart as a Child.");
  expect(host.textContent).not.toContain("not available in this release");
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

test("standalone Child flow warns first, joins the confirmed alias, and reloads only onto the new Child runtime", async () => {
  declareRuntimeRole("standalone");
  const calls: Array<{ path: string; method: string; body?: string }> = [];
  let joined = false;
  let healthReads = 0;
  let reloads = 0;
  globalThis.fetch = (async (input, init) => {
    const path = new URL(String(input)).pathname;
    calls.push({ path, method: init?.method ?? "GET", body: typeof init?.body === "string" ? init.body : undefined });
    if (path === "/healthz") {
      healthReads += 1;
      // The draining standalone keeps answering until it exits; only then does the Child answer.
      if (!joined || healthReads < 3) return response({ service: "opencodex", pid: 100, port: 10100 });
      return response({ service: "opencodex", role: "client", pid: 200, port: 10100 });
    }
    if (path === "/api/link/candidates") return response({ candidates: [{ alias: "home-one", source: "ssh_config" }] });
    if (path === "/api/link/probe") return response({ alias: "home-one", fingerprint: "SHA256:test", keyType: "ed25519" });
    if (path === "/api/link/confirm-host") return response({ alias: "home-one", fingerprint: "SHA256:test", ocxVersion: "2.0.0" });
    if (path === "/api/link/join") { joined = true; return response({ linkId: "lnk_1234567890abcdef", alias: "home-one", restarting: true }, 202); }
    return response(joinableStatus);
  }) as typeof fetch;
  // The poll interval is a gate the test opens, so it waits on the stub's answers, not on a wall-clock second.
  const pollGate: { open: (() => void) | null } = { open: null };
  const restartWait = { sleep: (_ms: number, signal: AbortSignal) => new Promise<void>(resolve => { pollGate.open = resolve; signal.addEventListener("abort", () => resolve(), { once: true }); }) };
  const host = await mount({ onChildReady: () => { reloads += 1; }, restartWait });
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
  // The pre-join notice says what the restart costs before the button is pressed.
  expect(host.textContent).toContain("Connecting restarts OpenCodex on this computer.");
  expect(host.textContent).toContain("Codex keeps the same local address");
  await act(async () => { [...host.querySelectorAll("button")].find(button => button.textContent?.includes("Connect as Child"))?.click(); });
  await flush();
  expect(calls.find(call => call.path === "/api/link/join")?.body).toBe(JSON.stringify({ alias: "home-one" }));
  expect(calls.findIndex(call => call.path === "/healthz")).toBeLessThan(calls.findIndex(call => call.path === "/api/link/join"));
  expect(calls.some(call => call.path === "/api/link/apply")).toBe(false);
  expect(host.textContent).toContain("This computer will restart to connect as a Child.");
  expect(host.textContent).toContain("This page reloads by itself when the Child is ready.");
  expect(host.textContent).toContain("Waiting for this computer to reconnect as Child");
  // The draining standalone's answer is ignored; the wait sleeps before the next read.
  await settleUntil(() => pollGate.open !== null);
  expect(reloads).toBe(0);
  // The next read finds the Child under a new pid, and the page reloads once.
  await act(async () => { pollGate.open?.(); });
  await settleUntil(() => reloads > 0);
  expect(reloads).toBe(1);
  expect(healthReads).toBe(3);
  const statusReadsAfterJoin = calls.slice(calls.findIndex(call => call.path === "/api/link/join")).filter(call => call.path === "/api/link/status");
  expect(statusReadsAfterJoin).toEqual([]);
});

test("the restart wait reloads only for a client runtime with a new pid and keeps checking past the slow notice", async () => {
  let clock = 0;
  const sleeps: number[] = [];
  const answers = [
    { service: "opencodex", pid: 100 },
    { service: "opencodex", role: "client", pid: 100 },
    { error: "not opencodex" },
    { service: "opencodex", role: "client", pid: 200 },
  ];
  const ready = await waitForChildRuntime("http://fixture", 100, new AbortController().signal, {
    now: () => clock,
    sleep: async ms => { sleeps.push(ms); clock += ms; },
    fetchImpl: (async () => response(answers.shift())) as typeof fetch,
  });
  expect(ready).toBe("ready");
  expect(sleeps).toEqual([CHILD_RESTART_POLL_MS, CHILD_RESTART_POLL_MS, CHILD_RESTART_POLL_MS]);

  // Nothing answers through the server's whole handoff budget; the Child comes up later anyway.
  // The notice fires once, the wait slows to one read every 5 seconds, and it still returns ready.
  clock = 0;
  sleeps.length = 0;
  const noticedAt: number[] = [];
  const late = await waitForChildRuntime("http://fixture", 100, new AbortController().signal, {
    now: () => clock,
    sleep: async ms => { sleeps.push(ms); clock += ms; },
    onSlow: () => { noticedAt.push(clock); },
    fetchImpl: (async () => {
      if (clock < CHILD_RESTART_NOTICE_MS + 60_000) throw new TypeError("connection refused");
      return response({ service: "opencodex", role: "client", pid: 200 });
    }) as typeof fetch,
  });
  expect(late).toBe("ready");
  expect(noticedAt).toEqual([CHILD_RESTART_NOTICE_MS]);
  expect(sleeps.filter(ms => ms === CHILD_RESTART_POLL_MS)).toHaveLength(CHILD_RESTART_NOTICE_MS / CHILD_RESTART_POLL_MS);
  expect(sleeps.filter(ms => ms === CHILD_RESTART_SLOW_POLL_MS)).toHaveLength(60_000 / CHILD_RESTART_SLOW_POLL_MS);

  const controller = new AbortController();
  controller.abort();
  expect(await waitForChildRuntime("http://fixture", 100, controller.signal)).toBe("aborted");
});

test("the slow-restart notice waits out the server's drain and replacement budgets", async () => {
  const { MEMORY_DRAIN_RESTART_MS, REPLACEMENT_READY_TIMEOUT_MS } = await import("../../src/lib/system-restart-contract");
  expect(CHILD_RESTART_NOTICE_MS).toBeGreaterThan(MEMORY_DRAIN_RESTART_MS + REPLACEMENT_READY_TIMEOUT_MS);
});

test("a Child that answers after the slow notice still reloads the page", async () => {
  declareRuntimeRole("standalone");
  let joined = false;
  let clock = 0;
  let reloads = 0;
  const child: { release: (() => void) | null } = { release: null };
  const childGate = new Promise<void>(resolve => { child.release = resolve; });
  const calls: string[] = [];
  globalThis.fetch = (async input => {
    const path = new URL(String(input)).pathname;
    calls.push(path);
    if (path === "/healthz") {
      if (!joined) return response({ service: "opencodex", role: "standalone", pid: 100, port: 10100 });
      // Nothing answers through the notice; after it the Child is still starting and answers
      // once the test lets it.
      if (clock <= CHILD_RESTART_NOTICE_MS) throw new TypeError("connection refused");
      await childGate;
      return response({ service: "opencodex", role: "client", pid: 200, port: 10100 });
    }
    if (path === "/api/link/candidates") return response({ candidates: [{ alias: "home-one", source: "ssh_config" }] });
    if (path === "/api/link/probe") return response({ alias: "home-one", fingerprint: "SHA256:test", keyType: "ed25519" });
    if (path === "/api/link/confirm-host") return response({ alias: "home-one", fingerprint: "SHA256:test", ocxVersion: "2.0.0" });
    if (path === "/api/link/join") { joined = true; return response({ linkId: "lnk_1234567890abcdef", alias: "home-one", restarting: true }, 202); }
    return response(joinableStatus);
  }) as typeof fetch;
  const restartWait = { now: () => clock, sleep: async (ms: number) => { clock += ms; } };
  const host = await mount({ onChildReady: () => { reloads += 1; }, restartWait });
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
  await settleUntil(() => host.textContent?.includes("Restarting is taking longer than usual.") ?? false);
  expect(host.textContent).toContain("Restarting is taking longer than usual.");
  expect(host.textContent).toContain("This page keeps checking and reloads by itself once the Child answers.");
  expect(reloads).toBe(0);
  await act(async () => { child.release?.(); });
  await settleUntil(() => reloads > 0);
  expect(reloads).toBe(1);
  expect(calls.slice(calls.indexOf("/api/link/join")).filter(path => path === "/api/link/status")).toEqual([]);
});

test("after the reload a Child shows its own link row instead of the off switch", async () => {
  declareRuntimeRole("client");
  globalThis.fetch = (async () => response({ ...baseStatus, role: "child", listener: { state: "off", port: null }, child: { alias: "home-one", state: "connected", since: "now", reason: null } })) as typeof fetch;
  const host = await mount();
  expect(host.querySelector('[role="switch"]')).toBeNull();
  expect(host.textContent).toContain("home-one");
  expect(host.textContent).toContain("Connected");
});

test("join maps join_port_mismatch to guidance about the configured port", async () => {
  declareRuntimeRole("standalone");
  globalThis.fetch = (async input => {
    const path = new URL(String(input)).pathname;
    if (path === "/api/link/candidates") return response({ candidates: [{ alias: "home-one", source: "ssh_config" }] });
    if (path === "/api/link/probe") return response({ alias: "home-one", fingerprint: "SHA256:test", keyType: "ed25519" });
    if (path === "/api/link/confirm-host") return response({ alias: "home-one", fingerprint: "SHA256:test", ocxVersion: "2.0.0" });
    if (path === "/api/link/join") return response({ error: { code: "join_port_mismatch" } }, 409);
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
  expect(host.textContent).toContain("Restart OpenCodex on its configured port, then try again.");
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
  const status = { ...baseStatus, links: [{ id: "lnk_0000000000000001", alias: "child", direction: "hub-initiated" as const, state: "failed" as const, since: "now", reason: "compensation_failed", tunnelPort: 43110 }] };
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
    if (path === "/api/link/status") return response({ ...baseStatus, links: [{ id: "lnk_0000000000000001", alias: "child", direction: "hub-initiated", state: "connected", since: "now", reason: null, tunnelPort: 43110, childKind: "full" }] });
    if (path === "/api/link/lnk_0000000000000001" && init?.method === "DELETE" && init.body === undefined) return response({ error: { code: "remote_disconnect_failed" } }, 502);
    return response({ linkId: "lnk_0000000000000001" });
  }) as typeof fetch;
  const host = await mount();
  const disconnectButton = [...host.querySelectorAll("button")].find(button => button.textContent?.includes("Disconnect")) as HTMLButtonElement;
  await act(async () => { disconnectButton.click(); });
  await flush();
  const dialogs = [...host.querySelectorAll("dialog")];
  const confirm = dialogs.at(-1) as HTMLDialogElement;
  expect(confirm.textContent).toContain("Disconnect");
  await act(async () => { (confirm.querySelector('[data-action="confirm"]') as HTMLButtonElement).click(); });
  await flush();
  expect(confirm.textContent).toContain("Remove here only");
  // No hint names a Child refusal, so the Home could not reach it.
  expect(confirm.textContent).toContain("This machine could not reach child");
  // The disconnect on the Child is link-bound: it acts only while the machine is connected to this link.
  expect(confirm.textContent).toContain("disconnects only while child is connected to this link");
  expect(confirm.querySelector("code.chip")?.textContent).toBe("ocx disconnect --expect-link lnk_0000000000000001");
  await act(async () => { (confirm.querySelector('[data-action="confirm"]') as HTMLButtonElement).click(); });
  await flush();
  expect(calls.some(call => call.method === "DELETE" && call.body === JSON.stringify({ force: true }))).toBe(true);
});

test("Retry on a failed Home link restarts its tunnel instead of only re-reading status", async () => {
  const calls: Array<{ method: string; path: string }> = [];
  let state: "failed" | "connecting" = "failed";
  globalThis.fetch = (async (input, init) => {
    const path = new URL(String(input)).pathname;
    calls.push({ method: init?.method ?? "GET", path });
    if (path === "/api/link/status") return response({ ...baseStatus, links: [
      { id: "lnk_0000000000000001", alias: "child", direction: "hub-initiated", state, since: "now", reason: state === "failed" ? "timeout" : null, tunnelPort: 43110 },
      { id: "lnk_0000000000000002", alias: "home", direction: "client-initiated", state: "failed", since: "now", reason: "timeout", tunnelPort: 43111 },
    ] });
    if (path === "/api/link/lnk_0000000000000001/reconnect" && init?.method === "POST") { state = "connecting"; return response({ linkId: "lnk_0000000000000001" }); }
    return response({ error: { code: "link_not_home_initiated" } }, 409);
  }) as typeof fetch;
  const host = await mount();
  const retry = [...host.querySelectorAll("button")].find(button => button.textContent === "Retry") as HTMLButtonElement;
  await act(async () => { retry.click(); });
  await settleUntil(() => host.querySelector(".remote-link-status[data-state='connecting']") !== null);
  expect(calls.filter(call => call.method === "POST").map(call => call.path)).toEqual(["/api/link/lnk_0000000000000001/reconnect"]);
  // The page also hosts the per-device fallback panel, whose own GET /api/fallback may land
  // after the refresh; the link flow's last request is still the status re-read.
  expect(calls.filter(call => call.path.startsWith("/api/link")).at(-1)).toEqual({ method: "GET", path: "/api/link/status" });
  expect(host.querySelector(".remote-link-status[data-state='connecting']")).not.toBeNull();
});

test.each([false, true])("Retry stays disabled through the deferred refresh (POST fails: %s)", async postFails => {
  const failed = { ...baseStatus, links: [{ id: "lnk_0000000000000001", alias: "child", direction: "hub-initiated", state: "failed", since: "now", reason: "timeout", tunnelPort: 43110 }] };
  let release!: (value: Response) => void;
  const refreshed = new Promise<Response>(resolve => { release = resolve; });
  let posts = 0;
  let gets = 0;
  globalThis.fetch = (async (input, init) => {
    if (init?.method === "POST") {
      posts += 1;
      return postFails ? response({ error: { code: "link_unavailable" } }, 503) : response({ linkId: "lnk_0000000000000001" });
    }
    // Count only the link status reads; the fallback panel's GET is a separate resource.
    if (new URL(String(input)).pathname !== "/api/link/status") return response({ error: "not_found" }, 404);
    gets += 1;
    return gets === 1 ? response(failed) : refreshed;
  }) as typeof fetch;
  const host = await mount();
  const retry = [...host.querySelectorAll("button")].find(button => button.textContent === "Retry") as HTMLButtonElement;
  await act(async () => { retry.click(); });
  await settleUntil(() => gets === 2);
  try {
    expect(retry.disabled).toBe(true);
    await act(async () => { retry.click(); });
    expect(posts).toBe(1);
  } finally {
    release(response(failed));
    await flush();
  }
  expect(retry.disabled).toBe(false);
});

test("readLinkJson preserves unknown server codes and status", async () => {
  let caught: unknown;
  try { await readLinkJson(new Response(JSON.stringify({ error: { code: "future_code" } }), { status: 418 })); } catch (error) { caught = error; }
  expect(caught).toBeInstanceOf(LinkApiError);
  expect((caught as LinkApiError).code).toBe("future_code");
  expect((caught as LinkApiError).status).toBe(418);
  expect((caught as LinkApiError).hint).toBeNull();
  expect(LOCALES.some(locale => locale.code === "pt")).toBe(true);
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

test("a computer that is already a Child cannot start another link", async () => {
  globalThis.fetch = (async () => response({ ...baseStatus, role: "child", child: { alias: "home-one", state: "connected", since: "now", reason: null } })) as typeof fetch;
  const host = await mount();
  expect(host.querySelector('[role="switch"]')).toBeNull();
  expect([...host.querySelectorAll("button")].some(button => button.textContent === "Continue")).toBe(false);
  expect(([...host.querySelectorAll("button")].find(button => button.textContent?.includes("Add child")) as HTMLButtonElement).disabled).toBe(true);
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
  await act(async () => { (host.querySelector('[data-action="continue"]') as HTMLButtonElement).click(); });
  await flush();
  await act(async () => { (host.querySelector(".remote-link-candidate") as HTMLButtonElement).click(); });
  await act(async () => { [...host.querySelectorAll("button")].find(button => button.textContent?.includes("Test connection"))?.click(); });
  await flush();
  expect(host.textContent).toContain("Could not connect to the SSH host. Check that it accepts your SSH key");
  expect(host.querySelector(".remote-link-hint code")?.textContent).toBe("child-one: Permission denied (publickey).");
  const sheet = host.querySelector(".remote-link-sheet")!;
  expect(host.querySelectorAll(".remote-link-hint")).toHaveLength(1);
  expect(sheet.querySelector(".remote-link-hint")).not.toBeNull();
  expect(sheet.textContent).toContain("ssh -o BatchMode=yes <alias> true");
  const retry = [...sheet.querySelectorAll("button")].find(button => button.textContent === "Retry")!;
  retry.focus();
  expect(win.document.activeElement).toBe(retry);
  expect(retry.tabIndex).toBe(0);
  await act(async () => { retry.click(); });
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
    if (path === "/api/link/apply") { applies += 1; return applies === 1 ? response({ error: { code: "link_apply_failed" } }, 502) : response({ linkId: "lnk_0000000000000001" }, 202); }
    return response(baseStatus);
  }) as typeof fetch;
  const host = await mount();
  await act(async () => { (host.querySelector('[role="switch"]') as HTMLButtonElement).click(); });
  await act(async () => { (host.querySelector('[data-action="continue"]') as HTMLButtonElement).click(); });
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
    return statusCalls === 1 ? old : response({ ...baseStatus, links: [{ id: "lnk_0000000000000001", alias: "newer", direction: "hub-initiated", state: "connected", since: "now", reason: null, tunnelPort: 43110 }] });
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
    if (path === "/api/link/status") return response({ ...baseStatus, links: [{ id: "lnk_0000000000000001", alias: "child", direction: "hub-initiated", state: "connected", since: "now", reason: null, tunnelPort: 43110 }] });
    if (init?.method === "DELETE") return response({ linkId: "lnk_0000000000000001" });
    return response(baseStatus);
  }) as typeof fetch;
  const host = await mount();
  const disconnect = [...host.querySelectorAll("button")].find(button => button.textContent?.includes("Disconnect")) as HTMLButtonElement;
  await act(async () => { disconnect.click(); });
  await act(async () => { (host.querySelector('.remote-link-confirm-dialog [data-action="cancel"]') as HTMLButtonElement).click(); });
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(win.document.activeElement).toBe(disconnect);
  await act(async () => { disconnect.click(); });
  await act(async () => { host.querySelector(".remote-link-confirm-dialog")?.dispatchEvent(new win.Event("cancel", { bubbles: true, cancelable: true })); });
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(win.document.activeElement).toBe(disconnect);
  await act(async () => { disconnect.click(); });
  await act(async () => { (host.querySelector('.remote-link-confirm-dialog [data-action="confirm"]') as HTMLButtonElement).click(); });
  await flush();
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(win.document.activeElement).toBe(disconnect);
});

test("known and unknown status reasons remain understandable", async () => {
  const status = { ...baseStatus, links: [
    { id: "lnk_00000000000000c1", alias: "known", direction: "hub-initiated" as const, state: "failed" as const, since: "now", reason: "timeout", tunnelPort: 43110 },
    { id: "lnk_00000000000000c2", alias: "unknown", direction: "hub-initiated" as const, state: "failed" as const, since: "now", reason: "future reason", tunnelPort: 43111 },
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
  await act(async () => { (host.querySelector('[data-action="continue"]') as HTMLButtonElement).click(); });
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
  await act(async () => { (host.querySelector('[data-action="continue"]') as HTMLButtonElement).click(); });
  await act(async () => { [...host.querySelectorAll("button")].find(button => button.textContent === "Cancel")?.click(); });
  await act(async () => { [...host.querySelectorAll("button")].find(button => button.textContent?.includes("Add child"))?.click(); });
  await flush();
  releaseFirst(response({ candidates: [{ alias: "stale-home", source: "ssh_config" }] }));
  await flush();
  expect(host.textContent).toContain("new-home");
  expect(host.textContent).not.toContain("stale-home");
});

async function openHomeSheet(host: HTMLElement): Promise<HTMLDialogElement> {
  await act(async () => { (host.querySelector('[role="switch"]') as HTMLButtonElement).click(); });
  await act(async () => { (host.querySelector('[data-action="continue"]') as HTMLButtonElement).click(); });
  return host.querySelector(".remote-link-sheet") as HTMLDialogElement;
}

function sheetButton(sheet: HTMLElement, label: string): HTMLButtonElement {
  const button = [...sheet.querySelectorAll("button")].find(item => item.textContent === label);
  expect(button).toBeDefined();
  return button!;
}

async function enterAlias(sheet: HTMLElement, value: string): Promise<void> {
  const input = sheet.querySelector("#remote-link-alias") as HTMLInputElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new win.Event("input", { bubbles: true }));
  });
}

test.each(["close", "unmount"] as const)("pending sheet focus is cancelled on %s", async transition => {
  type Timer = ReturnType<Window["setTimeout"]>;
  const pending = new Map<Timer, () => void>();
  const schedule = win.setTimeout.bind(win);
  const cancel = win.clearTimeout.bind(win);
  const timers = spyOn(win, "setTimeout").mockImplementation((callback, delay = 0, ...args) => {
    if (delay !== 0) return schedule(callback, delay, ...args);
    const timer = {} as Timer;
    pending.set(timer, () => callback(...args));
    return timer;
  });
  const cancellations = spyOn(win, "clearTimeout").mockImplementation(timer => {
    if (!pending.delete(timer)) cancel(timer);
  });
  globalThis.fetch = (async input => response(String(input).endsWith("/candidates") ? { candidates: [] } : baseStatus)) as typeof fetch;
  try {
    const host = await mount();
    const sheet = await openHomeSheet(host);
    const trigger = [...host.querySelectorAll("button")].find(button => button.textContent?.includes("Add child"))!;
    expect(pending.size).toBe(1);
    // Prove the held callback is live and still gives an open sheet its initial focus.
    for (const [timer, callback] of pending) { pending.delete(timer); callback(); }
    expect(win.document.activeElement).toBe(sheet.querySelector("input, button"));
    await act(async () => { sheet.dispatchEvent(new win.Event("cancel", { cancelable: true })); });
    expect(win.document.activeElement).toBe(trigger);
    await act(async () => { trigger.click(); });
    expect(pending.size).toBe(1);
    if (transition === "close") {
      await act(async () => { sheet.dispatchEvent(new win.Event("cancel", { cancelable: true })); });
    } else {
      await act(async () => { root?.unmount(); });
      root = null;
    }
    // Check cancellation before draining; executing an uncancelled timer cannot make this pass.
    expect(pending.size).toBe(0);
    for (const callback of pending.values()) callback();
    if (transition === "close") expect(win.document.activeElement).toBe(trigger);
  } finally {
    if (root) await act(async () => { root?.unmount(); });
    root = null;
    timers.mockRestore();
    cancellations.mockRestore();
  }
});

test("discovery loading, empty setup and rescan retain keyboard-accessible manual entry", async () => {
  let complete!: (value: Response) => void;
  let calls = 0;
  globalThis.fetch = (async input => {
    if (String(input).endsWith("/candidates")) {
      calls++;
      return new Promise<Response>(resolve => { complete = resolve; });
    }
    return response(baseStatus);
  }) as typeof fetch;
  const host = await mount();
  const sheet = await openHomeSheet(host);
  expect(sheet.querySelector('[role="status"]')?.textContent).toContain("Loading");
  expect(sheet.textContent).not.toContain("No SSH host candidates");
  expect(sheetButton(sheet, "Rescan hosts").disabled).toBe(true);
  complete(response({ candidates: [] }));
  await flush();
  expect(sheet.textContent).toContain("this Home's ~/.ssh/config");
  expect(sheet.textContent).toContain("OpenCodex 2.66.0+");
  expect(sheet.textContent).toContain("macOS or Linux");
  expect(sheet.querySelector("pre code")?.textContent).toContain("Host devbox");
  const guide = sheet.querySelector("a")!;
  expect(guide.getAttribute("href")).toBe("https://opencodex.me/guides/remote-link/");
  const input = sheet.querySelector("input")!;
  expect(input.getAttribute("aria-describedby")).toBe("remote-link-alias-help");
  expect(sheetButton(sheet, "Test connection").disabled).toBe(true);
  for (const control of [guide, sheetButton(sheet, "Rescan hosts"), input, sheetButton(sheet, "Cancel")]) {
    expect(control.tabIndex).toBe(0);
    control.focus();
    expect(win.document.activeElement).toBe(control);
  }
  await enterAlias(sheet, "manual-child");
  expect(sheetButton(sheet, "Test connection").disabled).toBe(false);
  sheetButton(sheet, "Test connection").focus();
  expect(win.document.activeElement).toBe(sheetButton(sheet, "Test connection"));
  await act(async () => { sheetButton(sheet, "Rescan hosts").click(); });
  expect(input.value).toBe("manual-child");
  expect(sheet.textContent).not.toContain("No SSH host candidates");
  complete(response({ candidates: [{ alias: "found-child", source: "ssh_config" }] }));
  await flush();
  expect(calls).toBe(2);
  expect(sheet.textContent).toContain("found-child");
  expect(input.value).toBe("manual-child");
  await act(async () => { sheet.dispatchEvent(new win.Event("cancel", { cancelable: true })); });
  expect(sheet.open).toBe(false);
  expect(win.document.activeElement?.textContent).toContain("Add child");
});

test("rescan after host confirmation preserves alias and requires fresh fingerprint confirmation", async () => {
  const posts: Array<{ path: string; body: unknown }> = [];
  let candidateRequests = 0;
  let probes = 0;
  let completeRescan!: (value: Response) => void;
  globalThis.fetch = (async (input, init) => {
    const path = new URL(String(input)).pathname;
    if (path.endsWith("/candidates")) {
      if (++candidateRequests === 1) return response({ candidates: [] });
      return new Promise<Response>(resolve => { completeRescan = resolve; });
    }
    if (init?.method === "POST") posts.push({ path, body: JSON.parse(String(init.body)) });
    if (path.endsWith("/probe")) return response({ alias: "manual-child", fingerprint: ++probes === 1 ? "SHA256:old" : "SHA256:fresh", keyType: "ed25519" });
    if (path.endsWith("/confirm-host")) return response({ alias: "manual-child", fingerprint: probes === 1 ? "SHA256:old" : "SHA256:fresh", ocxVersion: "2.66.0" });
    if (path.endsWith("/apply")) return response({ linkId: "fresh-link" });
    return response(baseStatus);
  }) as typeof fetch;
  const host = await mount();
  const sheet = await openHomeSheet(host);
  await flush();
  await enterAlias(sheet, "manual-child");
  await act(async () => { sheetButton(sheet, "Test connection").click(); });
  await flush();
  expect(sheet.querySelector(".remote-link-fingerprint code")?.textContent).toBe("SHA256:old");
  await act(async () => { (sheet.querySelector('[type="checkbox"]') as HTMLInputElement).click(); });
  await act(async () => { sheetButton(sheet, "Confirm host").click(); });
  await flush();
  expect(sheetButton(sheet, "Connect child").disabled).toBe(false);

  await act(async () => { sheetButton(sheet, "Rescan hosts").click(); });
  expect(sheet.querySelector('[role="status"]')?.textContent).toContain("Loading");
  expect((sheet.querySelector("#remote-link-alias") as HTMLInputElement).value).toBe("manual-child");
  expect(sheet.querySelector(".remote-link-fingerprint")).toBeNull();
  expect(sheet.querySelector('[type="checkbox"]')).toBeNull();
  expect([...sheet.querySelectorAll("button")].some(button => button.textContent === "Connect child")).toBe(false);
  expect(sheetButton(sheet, "Test connection").disabled).toBe(true);
  completeRescan(response({ candidates: [{ alias: "other-child", source: "ssh_config" }] }));
  await flush();
  expect(candidateRequests).toBe(2);
  expect((sheet.querySelector("#remote-link-alias") as HTMLInputElement).value).toBe("manual-child");
  expect([...sheet.querySelectorAll("button")].some(button => button.textContent === "Connect child")).toBe(false);
  expect(posts).toEqual([
    { path: "/api/link/probe", body: { alias: "manual-child" } },
    { path: "/api/link/confirm-host", body: { alias: "manual-child", fingerprint: "SHA256:old", allowMissing: true } },
  ]);

  await act(async () => { sheetButton(sheet, "Test connection").click(); });
  await flush();
  expect(sheet.querySelector(".remote-link-fingerprint code")?.textContent).toBe("SHA256:fresh");
  expect((sheet.querySelector('[type="checkbox"]') as HTMLInputElement).checked).toBe(false);
  expect(sheetButton(sheet, "Confirm host").disabled).toBe(true);
  expect([...sheet.querySelectorAll("button")].some(button => button.textContent === "Connect child")).toBe(false);
  await act(async () => { sheetButton(sheet, "Confirm host").click(); });
  expect(posts).toHaveLength(3);
  await act(async () => { (sheet.querySelector('[type="checkbox"]') as HTMLInputElement).click(); });
  await act(async () => { sheetButton(sheet, "Confirm host").click(); });
  await flush();
  expect(sheetButton(sheet, "Connect child").disabled).toBe(false);
  await act(async () => { sheetButton(sheet, "Connect child").click(); });
  await flush();
  expect(posts).toEqual([
    { path: "/api/link/probe", body: { alias: "manual-child" } },
    { path: "/api/link/confirm-host", body: { alias: "manual-child", fingerprint: "SHA256:old", allowMissing: true } },
    { path: "/api/link/probe", body: { alias: "manual-child" } },
    { path: "/api/link/confirm-host", body: { alias: "manual-child", fingerprint: "SHA256:fresh", allowMissing: true } },
    { path: "/api/link/apply", body: { alias: "manual-child" } },
  ]);
  expect(sheet.open).toBe(false);
});

for (const recoveredCandidates of [[], [{ alias: "recovered-child", source: "ssh_config" }]]) {
  test(`failed discovery retries to ${recoveredCandidates.length ? "candidates" : "empty success"} without duplicate errors`, async () => {
    let calls = 0;
    globalThis.fetch = (async input => {
      if (String(input).endsWith("/candidates")) return ++calls === 1
        ? response({ error: { code: "forbidden", hint: "Session expired" } }, 403)
        : response({ candidates: recoveredCandidates });
      return response(baseStatus);
    }) as typeof fetch;
    const host = await mount();
    const sheet = await openHomeSheet(host);
    await flush();
    expect(sheet.textContent).toContain("Could not load SSH hosts");
    expect(sheet.textContent).not.toContain("No SSH host candidates");
    expect(host.querySelectorAll(".remote-link-hint")).toHaveLength(1);
    expect(sheet.querySelector(".remote-link-hint")?.textContent).toContain("Session expired");
    const retry = sheetButton(sheet, "Retry");
    retry.focus();
    expect(win.document.activeElement).toBe(retry);
    expect(retry.tabIndex).toBe(0);
    await act(async () => { retry.click(); });
    await flush();
    expect(sheet.textContent).not.toContain("Could not load SSH hosts");
    expect(host.textContent).not.toContain("Session expired");
    expect(sheet.textContent).toContain(recoveredCandidates.length ? "recovered-child" : "No SSH host candidates");
  });
}

test("network discovery failure still permits a manual alias and explicit fingerprint confirmation", async () => {
  const posts: Array<{ path: string; body: unknown }> = [];
  globalThis.fetch = (async (input, init) => {
    const path = new URL(String(input)).pathname;
    if (path.endsWith("/candidates")) throw new TypeError("offline");
    if (init?.method === "POST") posts.push({ path, body: JSON.parse(String(init.body)) });
    if (path.endsWith("/probe")) return response({ alias: "manual-child", fingerprint: "SHA256:manual", keyType: "ed25519" });
    if (path.endsWith("/confirm-host")) return response({ alias: "manual-child", fingerprint: "SHA256:manual", ocxVersion: "2.66.0" });
    if (path.endsWith("/apply")) return response({ linkId: "manual-link" });
    return response(baseStatus);
  }) as typeof fetch;
  const host = await mount();
  const sheet = await openHomeSheet(host);
  await flush();
  expect(sheet.textContent).toContain("Could not load SSH hosts");
  expect(sheet.textContent).not.toContain("No SSH host candidates");
  expect(host.querySelectorAll(".remote-link-error")).toHaveLength(1);
  expect(sheet.textContent).toContain("Remote link request could not be completed.");
  await enterAlias(sheet, "manual-child");
  await act(async () => { sheetButton(sheet, "Test connection").click(); });
  await flush();
  expect(sheet.textContent).not.toContain("Could not load SSH hosts");
  expect(sheet.textContent).not.toContain("Remote link request could not be completed.");
  expect(sheet.textContent).toContain("SHA256:manual");
  expect(sheetButton(sheet, "Confirm host").disabled).toBe(true);
  expect(posts).toEqual([{ path: "/api/link/probe", body: { alias: "manual-child" } }]);
  await act(async () => { (sheet.querySelector('[type="checkbox"]') as HTMLInputElement).click(); });
  await act(async () => { sheetButton(sheet, "Confirm host").click(); });
  await flush();
  expect(posts[1]).toEqual({ path: "/api/link/confirm-host", body: { alias: "manual-child", fingerprint: "SHA256:manual", allowMissing: true } });
  await act(async () => { sheetButton(sheet, "Connect child").click(); });
  await flush();
  expect(posts[2]).toEqual({ path: "/api/link/apply", body: { alias: "manual-child" } });
  expect(sheet.open).toBe(false);
});

test("Find Home empty guidance names this computer rather than claiming it is Home", async () => {
  declareRuntimeRole("standalone");
  globalThis.fetch = (async input => response(String(input).endsWith("/candidates") ? { candidates: [] } : joinableStatus)) as typeof fetch;
  const host = await mount();
  await act(async () => { (host.querySelector('[role="switch"]') as HTMLButtonElement).click(); });
  const radios = host.querySelectorAll('[role="radio"]');
  await act(async () => { radios[0]?.dispatchEvent(new win.KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })); });
  expect(win.document.activeElement).toBe(radios[1]);
  await act(async () => { (radios[1] as HTMLButtonElement).click(); });
  await flush();
  const sheet = host.querySelector(".remote-link-sheet")!;
  expect(sheet.textContent).toContain("this computer's ~/.ssh/config");
  expect(sheet.textContent).not.toContain("this Home's");
});

test("Ready-to-Plant, cached ephemeral, connected badges, conflict notices, and ephemeral disconnect --purge flows", async () => {
  const calls: Array<{ method: string; path: string; body: unknown }> = [];
  let mode: "bare" | "unplantable" | "ephemeral" | "conflict" = "bare";
  let disconnectFailOnce = false;
  const digestA = "a".repeat(64);
  const digestB = "b".repeat(64);
  let currentStatus: RemoteLinkStatusWire = {
    ...baseStatus,
    homeCodexSettingsDigest: digestA,
    links: [
      { id: "lnk_00000000000000e1", alias: "devbox-eph", direction: "hub-initiated", state: "connected", since: "2026-11-07T00:00:00Z", reason: null, tunnelPort: 24500, childKind: "ephemeral", appliedCodexSettingsDigest: digestA },
      { id: "lnk_00000000000000f1", alias: "devbox-full", direction: "hub-initiated", state: "connected", since: "2026-11-07T00:00:00Z", reason: null, tunnelPort: 24501, childKind: "full", appliedCodexSettingsDigest: digestB },
    ],
  };
  globalThis.fetch = (async (input, init) => {
    const path = new URL(String(input)).pathname;
    const method = init?.method ?? "GET";
    const parsedBody = init?.body ? JSON.parse(String(init.body)) : undefined;
    if (method !== "GET") calls.push({ method, path, body: parsedBody });
    if (path.endsWith("/candidates")) return response({ candidates: [{ alias: "barebox", source: "ssh_config" }] });
    if (path.endsWith("/probe")) return response({ alias: "barebox", fingerprint: "SHA256:barefp", keyType: "ed25519" });
    if (path.endsWith("/confirm-host")) {
      if (mode === "bare") return response({ alias: "barebox", fingerprint: "SHA256:barefp", ocxVersion: null, runtimeKind: "missing", targetTriple: "linux-x64", plantable: true, binarySizeBytes: 952_000 });
      if (mode === "unplantable") return response({ alias: "barebox", fingerprint: "SHA256:barefp", ocxVersion: null, runtimeKind: "missing", targetTriple: null, plantable: false, plantUnavailableReason: "unsupported_target" });
      return response({ alias: "barebox", fingerprint: "SHA256:barefp", ocxVersion: "2.98.0", runtimeKind: "ephemeral", targetTriple: "linux-x64", plantable: false });
    }
    if (path.endsWith("/apply")) {
      if (mode === "conflict") return response({ error: { code: "child_port_busy" } }, 409);
      return response({ linkId: "lnk_planted" }, 202);
    }
    if (method === "DELETE" && path.endsWith("/lnk_00000000000000e1")) {
      if (disconnectFailOnce) {
        disconnectFailOnce = false;
        return response({ error: { code: "remote_disconnect_failed" } }, 502);
      }
      return response({ linkId: "lnk_00000000000000e1" });
    }
    return response(currentStatus);
  }) as typeof fetch;

  const host = await mount();
  // 1. Connected list badges: Lightweight + Home settings synced on devbox-eph, Full install + Sync needed on devbox-full
  expect(host.textContent).toContain("Lightweight");
  expect(host.textContent).toContain("Home settings synced");
  expect(host.textContent).toContain("Full install");
  expect(host.textContent).toContain("Sync needed");

  // 2. Open Add Child sheet -> Ready-to-Plant card -> sends { alias: 'barebox', plant: true }
  const addBtn = [...host.querySelectorAll("button")].find(b => b.textContent?.includes("Add child")) as HTMLButtonElement;
  await act(async () => { addBtn.click(); });
  await flush();
  const sheet = host.querySelector(".remote-link-sheet") as HTMLDialogElement;
  const candBtn = [...sheet.querySelectorAll(".remote-link-candidate")][0] as HTMLButtonElement;
  await act(async () => { candBtn.click(); });
  const probeBtn = [...sheet.querySelectorAll("button")].find(b => b.textContent?.includes("Test connection")) as HTMLButtonElement;
  await act(async () => { probeBtn.click(); });
  await flush();
  await act(async () => { (sheet.querySelector('[type="checkbox"]') as HTMLInputElement).click(); });
  const confirmBtn = [...sheet.querySelectorAll("button")].find(b => b.textContent?.includes("Confirm host")) as HTMLButtonElement;
  await act(async () => { confirmBtn.click(); });
  await flush();
  expect(sheet.textContent).toContain("Ready to plant lightweight agent");
  expect(sheet.textContent).toContain("linux-x64");
  expect(sheet.textContent).toContain("~0.9 MB");
  const plantBtn = [...sheet.querySelectorAll("button")].find(b => b.textContent?.includes("Plant lightweight agent & connect")) as HTMLButtonElement;
  await act(async () => { plantBtn.click(); });
  await flush();
  expect(calls).toContainEqual({ method: "POST", path: "/api/link/apply", body: { alias: "barebox", plant: true } });

  // 3. Cached ephemeral & child_port_busy conflict notice
  mode = "conflict";
  await act(async () => { addBtn.click(); });
  await flush();
  await act(async () => { ([...sheet.querySelectorAll(".remote-link-candidate")][0] as HTMLButtonElement).click(); });
  await act(async () => { ([...sheet.querySelectorAll("button")].find(b => b.textContent?.includes("Test connection")) as HTMLButtonElement).click(); });
  await flush();
  await act(async () => { (sheet.querySelector('[type="checkbox"]') as HTMLInputElement).click(); });
  await act(async () => { ([...sheet.querySelectorAll("button")].find(b => b.textContent?.includes("Confirm host")) as HTMLButtonElement).click(); });
  await flush();
  expect(sheet.textContent).toContain("Lightweight agent ready (ocx-child 2.98.0)");
  await act(async () => { ([...sheet.querySelectorAll("button")].find(b => b.textContent?.includes("Connect child")) as HTMLButtonElement).click(); });
  await flush();
  expect(sheet.textContent).toContain("already in use by another process");
  await act(async () => { ([...sheet.querySelectorAll("button")].find(b => b.textContent === "Cancel") as HTMLButtonElement).click(); });

  // 4. Ephemeral Disconnect --purge checkbox -> sends { purge: true }, and on remote_disconnect_failed shows ocx-child detach force modal
  const disconnectBtns = [...host.querySelectorAll(".remote-link-row button")];
  await act(async () => { (disconnectBtns[0] as HTMLButtonElement).click(); });
  await flush();
  const confirmDialog = host.querySelector(".remote-link-confirm-dialog") as HTMLDialogElement;
  expect(confirmDialog.textContent).toContain("0 background processes");
  const purgeCheckbox = confirmDialog.querySelector('input[type="checkbox"]') as HTMLInputElement;
  expect(purgeCheckbox.checked).toBe(false);
  await act(async () => { purgeCheckbox.click(); });
  const delBtn = [...confirmDialog.querySelectorAll("button")].find(b => b.textContent?.includes("Delete & disconnect")) as HTMLButtonElement;
  disconnectFailOnce = true;
  await act(async () => { delBtn.click(); });
  await flush();
  expect(calls).toContainEqual({ method: "DELETE", path: "/api/link/lnk_00000000000000e1", body: { purge: true } });
  // Force remove modal now points at the link-bound recover, which cleans the machine only while it still belongs to this link,
  // never at a bare ocx-child detach; the body stays the exclusive { force: true }.
  expect(confirmDialog.textContent).toContain("ocx link recover --link-id lnk_00000000000000e1");
  expect(confirmDialog.textContent).toContain("it acts only when devbox-eph's records name this link or nothing at all");
  expect(confirmDialog.textContent).not.toContain("ocx-child detach");
  // A lightweight Child's forced removal leaves a tombstone that records the id, so the dialog does not ask to note it.
  expect(confirmDialog.textContent).not.toContain("Note the link id");
  const forceBtn = [...confirmDialog.querySelectorAll("button")].find(b => b.textContent?.includes("Remove here only")) as HTMLButtonElement;
  await act(async () => { forceBtn.click(); });
  await flush();
  expect(calls.at(-1)).toEqual({ method: "DELETE", path: "/api/link/lnk_00000000000000e1", body: { force: true } });
  // The dialog closes, but the link id and its recover command stay on the page until the operator dismisses them.
  const notice = host.querySelector(".remote-link-force-removed");
  expect(notice?.textContent).toContain("lnk_00000000000000e1");
  expect([...notice!.querySelectorAll("code.chip")].map(chip => chip.textContent)).toEqual(["ocx link recover --link-id lnk_00000000000000e1"]);
});

test("a forced removal of a full Child leaves a notice that checks the Child's link before ocx disconnect", async () => {
  const id = "lnk_00000000000000f2";
  let listed = true;
  globalThis.fetch = (async (_input, init) => {
    if (init?.method === "DELETE") {
      const body = init.body ? JSON.parse(String(init.body)) as { force?: boolean } : undefined;
      if (body?.force !== true) return response({ error: { code: "remote_disconnect_failed" } }, 502);
      listed = false;
      return response({ linkId: id });
    }
    return response({ ...baseStatus, links: listed ? [{ id, alias: "devbox-full", direction: "hub-initiated", state: "connected", since: "now", reason: null, tunnelPort: 24503, childKind: "full" }] : [] });
  }) as typeof fetch;
  const host = await mount();
  await act(async () => { ([...host.querySelectorAll(".remote-link-row button")].find(item => item.textContent === "Disconnect") as HTMLButtonElement).click(); });
  await flush();
  const dialog = host.querySelector(".remote-link-confirm-dialog") as HTMLDialogElement;
  await act(async () => { (dialog.querySelector('[data-action="confirm"]') as HTMLButtonElement).click(); });
  await flush();
  // Nothing on the Home records a full Child's link id after the removal, so the dialog asks the operator to note it.
  expect(dialog.textContent).toContain("Note the link id " + id);
  await act(async () => { (dialog.querySelector('[data-action="confirm"]') as HTMLButtonElement).click(); });
  await flush();
  expect(host.querySelector(".remote-link-row")).toBeNull();
  // The row is gone, so the notice carries the id the Child must still show before anyone disconnects it there.
  const notice = host.querySelector(".remote-link-force-removed");
  // The link-bound disconnect first; the check-then-disconnect order only for an OpenCodex older than the flag.
  expect(notice?.textContent).toContain("disconnects only while devbox-full is connected to this link");
  expect(notice?.textContent).toContain("An OpenCodex older than that flag refuses it before it acts on the link");
  expect(notice?.textContent).toContain("Link: " + id);
  expect(notice?.textContent).toContain("or its state cannot be read, leave it as it is");
  // The check and the disconnect are two commands: the notice names the window and keeps the machine of another link untouched.
  expect(notice?.textContent).toContain("an enrollment that lands between them would be removed");
  expect(notice?.textContent).toContain("do not disconnect a machine that shows another link");
  expect([...notice!.querySelectorAll("code.chip")].map(chip => chip.textContent)).toEqual(["ocx disconnect --expect-link " + id, "ocx connect status", "ocx disconnect"]);
  await act(async () => { ([...notice!.querySelectorAll("button")].find(item => item.textContent === "Dismiss") as HTMLButtonElement).click(); });
  expect(host.querySelector(".remote-link-force-removed")).toBeNull();
});

test("a Child that refuses the bound disconnect opens the force dialog with its own title and reason", async () => {
  // A link-bound refusal (#8662) comes from a Child that answered; the dialog says so instead of "could not reach", and names
  // the reason from a closed set. A hint outside that set keeps the unreachable title.
  for (const [hint, title, reason] of [
    ["child_link_mismatch", "child refused to disconnect from this link", "It belongs to another link, a hub or another Home"],
    ["child_residual", "child refused to disconnect from this link", "It keeps records it cannot restore"],
    ["child_disconnect_pending", "child refused to disconnect from this link", "It has an unfinished disconnect it could not tie to this link"],
    ["expect_link_unsupported", "child refused to disconnect from this link", "It runs a version older than the link check"],
    ["ssh_failed", "This machine could not reach child", null],
  ] as const) {
    if (root) await act(async () => { root?.unmount(); });
    globalThis.fetch = (async (input, init) => {
      const path = new URL(String(input)).pathname;
      if (path === "/api/link/status") return response({ ...baseStatus, links: [{ id: "lnk_0000000000000001", alias: "child", direction: "hub-initiated", state: "connected", since: "now", reason: null, tunnelPort: 43110, childKind: "full" }] });
      if (init?.method === "DELETE") return response({ error: { code: "remote_disconnect_failed", hint } }, 502);
      return response(baseStatus);
    }) as typeof fetch;
    const host = await mount();
    await act(async () => { ([...host.querySelectorAll(".remote-link-row button")].find(item => item.textContent === "Disconnect") as HTMLButtonElement).click(); });
    await flush();
    const dialog = host.querySelector(".remote-link-confirm-dialog") as HTMLDialogElement;
    await act(async () => { (dialog.querySelector('[data-action="confirm"]') as HTMLButtonElement).click(); });
    await flush();
    expect(dialog.querySelector("#remote-link-confirm-title")?.textContent, hint).toBe(title);
    if (reason) expect(dialog.querySelector(".remote-link-refusal")?.textContent, hint).toContain(reason);
    else expect(dialog.querySelector(".remote-link-refusal"), hint).toBeNull();
    expect(dialog.textContent, hint).not.toContain(hint === "ssh_failed" ? "refused to disconnect" : "could not reach");
  }
});

test("every locale translates the forced-removal notice and keeps its command and link id slots", async () => {
  const { DICTS } = await import("../src/i18n/catalogs");
  for (const [locale, dict] of Object.entries(DICTS)) {
    for (const key of ["remoteLink.forceRemoved.ephemeral", "remoteLink.forceRemoved.fullBound", "remoteLink.forceRemoved.fullDisconnect", "remoteLink.forceRemoved.unknownCheck", "remoteLink.forceRemoved.unknownDisconnect"]) {
      const text = (dict as Record<string, string>)[key];
      expect(typeof text, locale + " " + key).toBe("string");
      if (locale !== "en") expect(text, locale + " " + key).not.toBe((DICTS.en as Record<string, string>)[key]);
      expect(text.includes("{cmd}") && text.includes("{linkId}"), locale + " " + key).toBe(true);
    }
    for (const key of ["remoteLink.forceRemoved.unknownLightweight", "remoteLink.forceRemoved.unknownLocate", "remoteLink.forceRemoved.fullCheck", "remoteLink.forceRemoved.unknownFallback", "remoteLink.forceRemove.unknownBody",
      "remoteLink.forceRemove.refusedTitle", "remoteLink.forceRemove.refusal.child_link_mismatch", "remoteLink.forceRemove.refusal.child_residual",
      "remoteLink.forceRemove.refusal.child_disconnect_pending", "remoteLink.forceRemove.refusal.expect_link_unsupported"]) {
      const text = (dict as Record<string, string>)[key];
      expect(typeof text, locale + " " + key).toBe("string");
      if (locale !== "en") expect(text, locale + " " + key).not.toBe((DICTS.en as Record<string, string>)[key]);
      expect(text.includes("{cmd}"), locale + " " + key).toBe(!key.endsWith("unknownBody") && !key.includes("refus"));
    }
  }
});

test("every locale keeps the force-remove and ownership texts' paths, commands and placeholders byte for byte", async () => {
  // An operator copies these literals: a translation may move them but never change or drop one.
  const { DICTS } = await import("../src/i18n/catalogs");
  const keys = ["remoteLink.forceRemove.body", "remoteLink.forceRemove.ephemeralBody", "remoteLink.forceRemove.unknownBody", "remoteLink.forceRemove.noteId",
    "remoteLink.forceRemoved.ephemeral", "remoteLink.forceRemoved.fullCheck", "remoteLink.forceRemoved.fullDisconnect", "remoteLink.forceRemoved.unknownCheck",
    "remoteLink.forceRemoved.unknownLocate", "remoteLink.forceRemoved.unknownLightweight", "remoteLink.forceRemoved.unknownDisconnect",
    "remoteLink.forceRemoved.fullBound", "remoteLink.forceRemoved.unknownFallback", "remoteLink.forceRemove.refusedTitle"];
  const literals = ["{cmd}", "{alias}", "{linkId}", "Link: {linkId}", "~/.cache/opencodex/bin/ocx-child", "~/.local/bin", "PATH", "LOCALAPPDATA",
    "%LOCALAPPDATA%\\opencodex\\bin\\ocx-child.exe", "%USERPROFILE%\\.cache\\opencodex\\bin\\ocx-child.exe", "where.exe ocx-child", "ocx-child connect status --json"];
  const en = DICTS.en as Record<string, string>;
  for (const [locale, dict] of Object.entries(DICTS)) {
    for (const key of keys) {
      const text = (dict as Record<string, string>)[key];
      expect(typeof text, locale + " " + key).toBe("string");
      for (const literal of literals) expect(text.includes(literal), locale + " " + key + " " + literal).toBe(en[key]!.includes(literal));
    }
  }
});


test("a forced removal of a Child of unknown type names no command up front and checks either install's link afterwards", async () => {
  // A link saved before the Home recorded the Child type has no childKind: it may run a full install or ocx-child, and its
  // forced removal leaves no tombstone, so neither ocx disconnect alone nor ocx link recover can be the answer.
  const id = "lnk_00000000000000d3";
  let listed = true;
  globalThis.fetch = (async (_input, init) => {
    if (init?.method === "DELETE") {
      const body = init.body ? JSON.parse(String(init.body)) as { force?: boolean } : undefined;
      if (body?.force !== true) return response({ error: { code: "remote_disconnect_failed" } }, 502);
      listed = false;
      return response({ linkId: id });
    }
    return response({ ...baseStatus, links: listed ? [{ id, alias: "devbox-old", direction: "hub-initiated", state: "connected", since: "now", reason: null, tunnelPort: 24504 }] : [] });
  }) as typeof fetch;
  const host = await mount();
  await act(async () => { ([...host.querySelectorAll(".remote-link-row button")].find(item => item.textContent === "Disconnect") as HTMLButtonElement).click(); });
  await flush();
  const dialog = host.querySelector(".remote-link-confirm-dialog") as HTMLDialogElement;
  await act(async () => { (dialog.querySelector('[data-action="confirm"]') as HTMLButtonElement).click(); });
  await flush();
  expect(dialog.textContent).toContain("did not record whether devbox-old runs a full install or the lightweight agent");
  // The notice is component state: it lasts until it is dismissed or the page is left, and the id is noted before removal.
  expect(dialog.textContent).toContain("until you dismiss them or leave the page");
  expect(dialog.textContent).toContain("Note the link id " + id);
  expect(dialog.querySelector("code.chip")).toBeNull();
  await act(async () => { (dialog.querySelector('[data-action="confirm"]') as HTMLButtonElement).click(); });
  await flush();
  const notice = host.querySelector(".remote-link-force-removed");
  expect(notice?.textContent).toContain("keeps nothing to recover it from");
  expect(notice?.textContent).toContain("names link " + id);
  expect(notice?.textContent).toContain("or its state cannot be read, leave it as it is");
  // Both installs' link-bound commands first (every released ocx-child parses them strictly); the check only for older builds.
  expect(notice?.textContent).toContain("Each acts only while the machine still belongs to this link");
  expect(notice?.textContent).toContain("an enrollment that lands between them would be removed");
  expect(notice?.textContent).toContain("do not disconnect a machine that shows another link");
  // Every location the product plants or finds an ocx-child, with the planted copy kept as the example path.
  for (const where of ["~/.local/bin", "PATH", "%LOCALAPPDATA%\\opencodex\\bin\\ocx-child.exe", "%USERPROFILE%\\.cache\\opencodex\\bin\\ocx-child.exe", "where.exe ocx-child"]) {
    expect(notice?.textContent, where).toContain(where);
  }
  // No unbound ocx-child detach: its status cannot show an interrupted attach of another link, which a plain detach would
  // restore and then remove, so an older lightweight Child is left as it is (#8691 review).
  expect(notice?.textContent).toContain("On a lightweight Child, leave it as it is");
  // The Windows paths are Command Prompt paths, and the bound detach chip shows the POSIX planted path (#8691 final review).
  expect(notice?.textContent).toContain("in Command Prompt on Windows %LOCALAPPDATA%");
  expect(notice?.textContent).toContain("on Windows, the ocx-child.exe path above");
  expect([...notice!.querySelectorAll("code.chip")].map(chip => chip.textContent)).toEqual(UNKNOWN_CHIPS(id));
  expect(notice?.textContent).not.toContain("ocx link recover");
});

const UNKNOWN_CHIPS = (id: string) => [
  "ocx disconnect --expect-link " + id, "command -v ocx-child", "~/.cache/opencodex/bin/ocx-child detach --expect-link " + id,
  "ocx connect status --json", "ocx disconnect",
];

test("in every locale the unknown-type notice offers no unbound ocx-child detach", async () => {
  const id = "lnk_00000000000000d4";
  for (const { code } of LOCALES) {
    if (root) await act(async () => { root?.unmount(); });
    root = null;
    win.document.body.innerHTML = "";
    win.localStorage.setItem("ocx-lang", code);
    let listed = true;
    globalThis.fetch = (async (_input, init) => {
      if (init?.method === "DELETE") {
        const body = init.body ? JSON.parse(String(init.body)) as { force?: boolean } : undefined;
        if (body?.force !== true) return response({ error: { code: "remote_disconnect_failed" } }, 502);
        listed = false;
        return response({ linkId: id });
      }
      return response({ ...baseStatus, links: listed ? [{ id, alias: "devbox-old", direction: "hub-initiated", state: "connected", since: "now", reason: null, tunnelPort: 24504 }] : [] });
    }) as typeof fetch;
    const host = await mount();
    await act(async () => { (host.querySelector(".remote-link-row button:last-of-type") as HTMLButtonElement).click(); });
    await flush();
    const dialog = host.querySelector(".remote-link-confirm-dialog") as HTMLDialogElement;
    await act(async () => { (dialog.querySelector('[data-action="confirm"]') as HTMLButtonElement).click(); });
    await flush();
    await act(async () => { (dialog.querySelector('[data-action="confirm"]') as HTMLButtonElement).click(); });
    await flush();
    const notice = host.querySelector(".remote-link-force-removed");
    expect([...notice!.querySelectorAll("code.chip")].map(chip => chip.textContent), code).toEqual(UNKNOWN_CHIPS(id));
  }
});

test("a refused --purge on a full install explains why instead of a generic failure", async () => {
  globalThis.fetch = (async (_input, init) => {
    if (init?.method === "DELETE") return response({ error: { code: "purge_unsupported", message: "full install" } }, 409);
    return response({ ...baseStatus, links: [{ id: "lnk_0000000000000005", alias: "devbox-stale", direction: "hub-initiated", state: "connected", since: "2026-11-07T00:00:00Z", reason: null, tunnelPort: 24502, childKind: "ephemeral" }] });
  }) as typeof fetch;
  const host = await mount();
  await act(async () => { ([...host.querySelectorAll(".remote-link-row button")][0] as HTMLButtonElement).click(); });
  await flush();
  const dialog = host.querySelector(".remote-link-confirm-dialog") as HTMLDialogElement;
  await act(async () => { (dialog.querySelector('input[type="checkbox"]') as HTMLInputElement).click(); });
  await act(async () => { ([...dialog.querySelectorAll("button")].find(b => b.textContent?.includes("Delete & disconnect")) as HTMLButtonElement).click(); });
  await flush();
  expect(dialog.textContent).toContain("full OpenCodex install");
  expect(dialog.textContent).toContain("without deleting");
});

test("a bare host Home cannot plant names the verified build Home needs and where it looks", async () => {
  const host = win.document.createElement("div");
  win.document.body.append(host);
  root = (await import("react-dom/client")).createRoot(host);
  const noop = () => {};
  const sheet = (reason: string | null) => (
    <LanguageProvider>
      <RemoteLinkSheet sheetRef={{ current: null }} role="home" standaloneRuntime childSelectable={false} discovery="ready" candidates={[]} alias="barebox" onAliasChange={noop}
        probe={null} checkedFingerprint={false} onCheckedFingerprintChange={noop}
        confirmation={{ alias: "barebox", fingerprint: "SHA256:barefp", ocxVersion: null, runtimeKind: "missing", targetTriple: "linux-arm64", plantable: false, binarySizeBytes: null, plantUnavailableReason: reason }}
        busy={null} sheetOpen actionError={null} failedAction={null} onClose={noop} onRescan={noop} onProbe={noop} onConfirmHost={noop} onApplyLink={noop} onJoinLink={noop} onRetryFailedAction={noop} />
    </LanguageProvider>
  );
  await act(async () => { root?.render(sheet("artifact_not_found")); });
  const text = host.textContent ?? "";
  expect(text).toContain("no verified ocx-child binary");
  expect(text).toContain("OPENCODEX_CHILD_BIN_DIR");
  expect(text).toContain("ocx-child-linux-arm64");
  expect(text).toContain("SHA256SUMS");
  await act(async () => { root?.render(sheet("unsupported_target")); });
  expect(host.textContent ?? "").not.toContain("OPENCODEX_CHILD_BIN_DIR");
});

const ENROLLMENT_CLEANUP_ERRORS = [
  ["link_pin_conflict", "already pins another host key"],
  ["host_key_changed", "no longer the one trusted"],
  ["trust_file_unexpected", "known_hosts file"],
  ["key_cleanup_failed", "revoke the leftover link key"],
  ["link_cleanup_uncertain", "revoke the leftover link key"],
] as const;

/** Walk the sheet up to the step that sends `until`, answering it with `refusal` (status `status`). */
async function refusedAt(until: "confirm-host" | "apply", refusal: Record<string, unknown>, status: number): Promise<HTMLDivElement> {
  globalThis.fetch = (async input => {
    const path = new URL(String(input)).pathname;
    if (path === "/api/link/candidates") return response({ candidates: [{ alias: "child-one", source: "ssh config" }] });
    if (path === "/api/link/probe") return response({ alias: "child-one", fingerprint: "SHA256:test", keyType: "ed25519" });
    if (path === "/api/link/confirm-host") return until === "confirm-host" ? response(refusal, status) : response({ alias: "child-one", fingerprint: "SHA256:test", ocxVersion: "2.0.0" });
    if (path === "/api/link/apply") return response(refusal, status);
    return response(baseStatus);
  }) as typeof fetch;
  const host = await mount();
  await act(async () => { (host.querySelector('[role="switch"]') as HTMLButtonElement).click(); });
  await act(async () => { (host.querySelector('[data-action="continue"]') as HTMLButtonElement).click(); });
  await flush();
  await act(async () => { (host.querySelector(".remote-link-candidate") as HTMLButtonElement).click(); });
  await act(async () => { [...host.querySelectorAll("button")].find(button => button.textContent?.includes("Test connection"))?.click(); });
  await flush();
  await act(async () => { (host.querySelector('input[type="checkbox"]') as HTMLInputElement).click(); });
  await act(async () => { [...host.querySelectorAll("button")].find(button => button.textContent?.includes("Confirm host"))?.click(); });
  await flush();
  if (until === "apply") {
    await act(async () => { [...host.querySelectorAll("button")].find(button => button.textContent?.includes("Connect child"))?.click(); });
    await flush();
  }
  return host;
}

const applyRefusal = (body: Record<string, unknown>, status = 500) => refusedAt("apply", body, status);

test("link_pin_conflict, which confirm-host answers, names the pinned key instead of a generic failure", async () => {
  const host = await refusedAt("confirm-host", { error: { code: "link_pin_conflict", message: "server text" } }, 409);
  expect(host.textContent).toContain("already pins another host key");
  expect(host.textContent).not.toContain("Remote link request could not be completed.");
  expect(host.textContent).not.toContain("server text");
});

test.each(ENROLLMENT_CLEANUP_ERRORS.filter(([code]) => code !== "link_pin_conflict"))("apply refusal %s names what to do instead of a generic failure", async (code, expected) => {
  const host = await applyRefusal({ error: { code, message: "server text" } }, code === "key_cleanup_failed" || code === "link_cleanup_uncertain" ? 500 : 409);
  expect(host.textContent).toContain(expected);
  expect(host.textContent).not.toContain("Remote link request could not be completed.");
});

const RESIDUAL_STEPS = ["purge", "purgeWindows", "purgeWindowsFallback", "purgeAny", "purgeAnyWindows", "ephemeral", "full", "unknown", "unknownLightweight", "lightweightPlaced", "lightweightPlacedWindows", "bound", "olderFull", "olderLightweight", "noLink"] as const;
// Lines that carry no command chip; bound and olderFull name the attempt's link id.
const RESIDUAL_PROSE: readonly string[] = ["bound", "olderLightweight", "noLink"];

test("every locale translates the enrollment refusals and the Child steps instead of reusing English", async () => {
  const { DICTS } = await import("../src/i18n/catalogs");
  for (const [locale, dict] of Object.entries(DICTS)) {
    for (const [code] of ENROLLMENT_CLEANUP_ERRORS) {
      const text = (dict as Record<string, string>)["remoteLink.error." + code];
      expect(typeof text, locale + " " + code).toBe("string");
      expect(text, locale + " " + code).not.toBe((dict as Record<string, string>)["remoteLink.error.generic"]);
      if (locale !== "en") expect(text, locale + " " + code).not.toBe((DICTS.en as Record<string, string>)["remoteLink.error." + code]);
    }
    for (const step of RESIDUAL_STEPS) {
      const text = (dict as Record<string, string>)["remoteLink.residual." + step];
      expect(typeof text, locale + " " + step).toBe("string");
      if (locale !== "en") expect(text, locale + " " + step).not.toBe((DICTS.en as Record<string, string>)["remoteLink.residual." + step]);
      // A single command is a chip in the {cmd} slot, never written into the translated prose.
      expect(text.includes("{cmd}"), locale + " " + step).toBe(!RESIDUAL_PROSE.includes(step));
      if (step === "bound" || step === "olderFull") expect(text.includes("{linkId}"), locale + " " + step).toBe(true);
    }
    // The ownership check without the attempt's id is gone: every step is bound to that id (#8691 final review).
    expect((dict as Record<string, string>)["remoteLink.residual.ownership"], locale).toBeUndefined();
  }
});

const RESIDUAL_ID = "lnk_00000000000000c1";
const WINDOWS_PURGE_BOUND = '"%LOCALAPPDATA%\\opencodex\\bin\\ocx-child.exe" detach --purge --expect-link ' + RESIDUAL_ID;
const WINDOWS_FALLBACK_BOUND = '"%USERPROFILE%\\.cache\\opencodex\\bin\\ocx-child.exe" detach --purge --expect-link ' + RESIDUAL_ID;
// The lightweight agent by its managed paths (not necessarily on PATH), then the copy placed by hand (#8694 review).
const POSIX_DETACH = "~/.cache/opencodex/bin/ocx-child detach --expect-link " + RESIDUAL_ID;
const WINDOWS_DETACH = '"%LOCALAPPDATA%\\opencodex\\bin\\ocx-child.exe" detach --expect-link ' + RESIDUAL_ID;
const WINDOWS_FALLBACK_DETACH = '"%USERPROFILE%\\.cache\\opencodex\\bin\\ocx-child.exe" detach --expect-link ' + RESIDUAL_ID;
test.each([
  ["a posix plant", { residualKind: "plant", remotePlatform: "posix" }, ["~/.cache/opencodex/bin/ocx-child detach --purge --expect-link " + RESIDUAL_ID], "Run ~/.cache"],
  ["a windows plant", { residualKind: "plant", remotePlatform: "windows" }, [WINDOWS_PURGE_BOUND, WINDOWS_FALLBACK_BOUND], "Command Prompt"],
  ["a lightweight Child", { residualKind: "enrollment", residualInstall: "ephemeral", remotePlatform: "posix" }, [POSIX_DETACH, "command -v ocx-child"], "An ocx-child older than that flag refuses it before it acts; then leave the Child as it is"],
  ["a lightweight Windows Child", { residualKind: "enrollment", residualInstall: "ephemeral", remotePlatform: "windows" }, [WINDOWS_DETACH, WINDOWS_FALLBACK_DETACH, "where.exe ocx-child"], "Command Prompt"],
  ["a lightweight Child of unknown platform", { residualKind: "enrollment", residualInstall: "ephemeral" }, [POSIX_DETACH, WINDOWS_DETACH, WINDOWS_FALLBACK_DETACH, "command -v ocx-child"], "On macOS or Linux"],
  ["a full install", { residualKind: "enrollment", residualInstall: "full" }, ["ocx disconnect --expect-link " + RESIDUAL_ID, "ocx connect status --json"], "if it disconnected, ocx restart"],
  ["an install not recorded", { residualKind: "enrollment" }, ["ocx disconnect --expect-link " + RESIDUAL_ID, POSIX_DETACH, WINDOWS_DETACH, WINDOWS_FALLBACK_DETACH, "command -v ocx-child", "ocx connect status --json"], "On a full install"],
] as const)("a residual on %s names its Child step bound to the attempt's link", async (_name, fields, chips, prose) => {
  const host = await applyRefusal({ error: { code: "key_cleanup_failed", message: "fixture" }, residual: true, linkId: RESIDUAL_ID, recovery: "whatever the server wrote", ...fields });
  const step = host.querySelector(".remote-link-child-step");
  expect(step?.textContent).toContain("The Child may still be connected.");
  // Every step is bound to the attempt's link id, so it leaves a Child that another link joined since: no check that cannot
  // tell this attempt's link from another's, and no plain disconnect or detach chip.
  expect([...step!.querySelectorAll("code.chip")].map(chip => chip.textContent)).toEqual([...chips]);
  expect(step?.textContent).toContain("this attempt's link (" + RESIDUAL_ID + ")");
  expect(step?.textContent).toContain(prose);
  expect(host.querySelector(".remote-link-child-ownership")).toBeNull();
  expect(host.textContent).not.toContain("whatever the server wrote");
});

test("a journalled plant residual, which names no platform, lists every managed location bound to the link", async () => {
  // The shape a replay of a residual ocx link add --operation-id answers (src/server/management/link-operation.ts).
  const host = await applyRefusal({ error: { code: "link_cleanup_uncertain", message: "fixture" }, operationId: "attach-1", outcome: "residual", residual: true, residualKind: "plant",
    linkId: RESIDUAL_ID, recovery: "The Child may still hold the planted ocx-child; server text the page must not echo" });
  const step = host.querySelector(".remote-link-child-step");
  expect([...step!.querySelectorAll("code.chip")].map(chip => chip.textContent)).toEqual([
    "~/.cache/opencodex/bin/ocx-child detach --purge --expect-link " + RESIDUAL_ID, WINDOWS_PURGE_BOUND, WINDOWS_FALLBACK_BOUND,
  ]);
  expect(step?.textContent).toContain("On macOS or Linux");
  expect(host.textContent).not.toContain("server text the page must not echo");
});

test("a residual without the attempt's link id leaves the Child as it is", async () => {
  const host = await applyRefusal({ error: { code: "link_cleanup_uncertain", message: "server text the page must not echo" }, residual: true, recovery: "Run ocx disconnect and ocx restart on the Child before retrying." });
  const text = host.textContent ?? "";
  expect(text).toContain("revoke the leftover link key");
  expect(text).toContain("The Child may still be connected.");
  expect(text).toContain("so no step on the Child can be bound to it: leave the Child as it is");
  expect(host.querySelector(".remote-link-child-step code.chip")).toBeNull();
  expect(text).not.toContain("was not connected");
  // Neither the server's message nor its recovery prose is shown.
  expect(text).not.toContain("server text the page must not echo");
  expect(text).not.toContain("Run ocx disconnect and ocx restart");
});

test("a cleanup refusal without residual names no Child step", async () => {
  const host = await applyRefusal({ error: { code: "key_cleanup_failed", message: "fixture" } });
  expect(host.textContent).toContain("revoke the leftover link key");
  expect(host.textContent).not.toContain("The Child may still be connected.");
});

test("readLinkJson keeps whether the Child may still be connected, as a fixed variant and a checked link id", async () => {
  const read = async (body: unknown) => {
    try { await readLinkJson(new Response(JSON.stringify(body), { status: 500 })); } catch (error) { return error as LinkApiError; }
    throw new Error("no error");
  };
  expect((await read({ error: { code: "x" } })).residual).toBeNull();
  expect((await read({ error: { code: "x" }, residual: true, residualKind: "enrollment", residualInstall: "full", linkId: RESIDUAL_ID })).residual).toEqual({ step: "full", linkId: RESIDUAL_ID });
  expect((await read({ error: { code: "x" }, residual: true, residualKind: "enrollment", residualInstall: "ephemeral", linkId: RESIDUAL_ID })).residual).toEqual({ step: "ephemeral", linkId: RESIDUAL_ID });
  expect((await read({ error: { code: "x" }, residual: true, residualKind: "plant", remotePlatform: "windows", linkId: RESIDUAL_ID })).residual).toEqual({ step: "purgeWindows", linkId: RESIDUAL_ID });
  expect((await read({ error: { code: "x" }, residual: true, residualKind: "plant", linkId: RESIDUAL_ID })).residual).toEqual({ step: "purgeAny", linkId: RESIDUAL_ID });
  expect((await read({ error: { code: "x" }, residual: true, residualKind: "enrollment", linkId: RESIDUAL_ID })).residual).toEqual({ step: "unknown", linkId: RESIDUAL_ID });
  // The server's recovery prose never picks a variant, and a link id is used only in its exact shape.
  expect((await read({ error: { code: "x" }, residual: true, recovery: "Run ocx disconnect and ocx restart on the Child before retrying." })).residual).toEqual({ step: "noLink", linkId: null });
  expect((await read({ error: { code: "x" }, residual: true, residualKind: "plant", linkId: "lnk_0; rm -rf ~" })).residual).toEqual({ step: "noLink", linkId: null });
  expect((await read({ error: { code: "x" }, residual: "yes" })).residual).toBeNull();
});
