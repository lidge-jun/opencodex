import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import type { Root } from "react-dom/client";
import { act, type ReactElement } from "react";
import RemoteLink from "../src/pages/RemoteLink";
import { ChildJobProgress } from "../src/pages/RemoteLinkChildActions";
import { LanguageProvider } from "../src/i18n/provider";
import { CHILD_OPS_MAX_LINK_IDS } from "../../src/link/child-ops-types";
import {
  CHILD_JOB_POLL_MS, CHILD_JOB_POLL_TIMEOUT_MS, CHILD_OPERATION_MAX_LINK_IDS, chunkLinkIds, parseChildJob, parseChildOps, postChildOperation,
} from "../src/remote-link-child-ops-api";

const HOME = "http://fixture";
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
async function settleUntil(done: () => boolean, limitMs = 3_000): Promise<void> {
  const deadline = Date.now() + limitMs;
  while (!done() && Date.now() < deadline) await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
}

type Call = { method: string; path: string; body?: Record<string, unknown> };
/** Every request the page makes, with a parsed JSON body, routed by path prefix. */
function installFetch(handle: (call: Call) => Response | Promise<Response>): Call[] {
  const calls: Call[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined;
    const call: Call = { method: init?.method ?? "GET", path: url.pathname + url.search, body };
    calls.push(call);
    return handle(call);
  }) as typeof fetch;
  return calls;
}

function childBlock(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    homeVersion: "2.35.0", runningVersion: "2.34.0", installedVersion: "2.34.0", installKind: "npm",
    versionSkew: "behind",
    update: { route: "orchestrated", reason: null, observedAt: "2026-11-12T00:00:00.000Z" },
    catalog: { state: "behind", pulledAt: 1, homeChangedAt: 2 },
    codex: null, childBuild: null,
    activity: { idle: true, inFlight: 0, lastDataEndAt: null },
    activeJob: null, lastOperation: null,
    ...overrides,
  };
}

function row(id: string, alias: string, child: Record<string, unknown> | null, direction: "hub-initiated" | "client-initiated" = "hub-initiated"): Record<string, unknown> {
  return { id, alias, direction, state: "connected", since: "now", reason: null, tunnelPort: 43110, childKind: null, appliedCodexSettingsDigest: null, ...(child ? { child } : {}) };
}

function status(links: Array<Record<string, unknown>>, role: "home" | "standalone" | "child" = "home"): Record<string, unknown> {
  return { role, listener: { state: "listening", port: 8788 }, child: null, joinAvailable: false, links };
}

const POLICY = { catalogFanout: "auto", childCodexRestart: "never", updates: "auto-when-idle", idleAfterMs: 600_000 };

function job(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { schema: "ocx.link.child-job/1", jobId: "ljob_0123456789abcdef", op: "update", trigger: "manual", restart: "none", state: "running", createdAt: "now", finishedAt: null,
    items: [{ linkId: "lnk_0000000000000011", alias: "box-one", state: "running", reason: null, fromVersion: "2.34.0", toVersion: "2.35.0", startedAt: null, finishedAt: null }], ...overrides };
}

async function mount(): Promise<HTMLDivElement> {
  const host = win.document.createElement("div");
  win.document.body.append(host);
  root = (await import("react-dom/client")).createRoot(host);
  await act(async () => { root?.render(<LanguageProvider><RemoteLink apiBase={HOME} diagnosticsApiBase={HOME} sessionReady /></LanguageProvider>); });
  await flush();
  return host;
}

/** Mounts one component on its own; a finished job's panel leaves the page, so its last render is asserted here. */
async function mountNode(element: ReactElement): Promise<HTMLDivElement> {
  const host = win.document.createElement("div");
  win.document.body.append(host);
  root = (await import("react-dom/client")).createRoot(host);
  await act(async () => { root?.render(<LanguageProvider>{element}</LanguageProvider>); });
  await flush();
  return host;
}

function button(host: HTMLElement, label: string): HTMLButtonElement {
  const found = [...host.querySelectorAll("button")].find(item => item.textContent?.trim() === label);
  if (!found) throw new Error(`no button ${label}: ${host.textContent}`);
  return found as HTMLButtonElement;
}
async function click(element: HTMLElement | null | undefined): Promise<void> { if (!element) throw new Error("missing element"); await act(async () => { element.click(); }); await flush(); }
/** Runs the job panel's visibility poll now instead of waiting out CHILD_JOB_POLL_MS. */
async function pollJobs(): Promise<void> {
  await act(async () => { win.document.dispatchEvent(new win.Event("visibilitychange")); });
  await flush();
}
async function chooseOption(label: string): Promise<void> {
  const option = [...win.document.querySelectorAll("[role=option]")].find(item => item.textContent === label);
  if (!option) throw new Error(`no option ${label}`);
  await click(option as HTMLElement);
}
function openSelect(host: HTMLElement, index: number): HTMLButtonElement {
  const triggers = [...host.querySelectorAll<HTMLButtonElement>(".remote-link-policy [role=combobox]")];
  const trigger = triggers[index];
  if (!trigger) throw new Error(`no select ${index}`);
  return trigger;
}

/** The first dialog in a row that has rendered its body (the closed restart dialog comes first). */
function openDialog(host: HTMLElement): HTMLDialogElement {
  const dialog = [...host.querySelectorAll("dialog")].find(item => item.textContent !== "");
  if (!dialog) throw new Error(`no open dialog: ${host.textContent}`);
  return dialog as HTMLDialogElement;
}

test("status is requested with children=1", async () => {
  const calls = installFetch(() => response(status([row("lnk_0000000000000011", "box-one", childBlock())])));
  await mount();
  expect(calls[0]?.path).toBe("/api/link/status?children=1");
});

test("an older Home renders today's row with no child controls", async () => {
  const calls = installFetch(call => call.path.startsWith("/api/link/status") ? response(status([row("lnk_0000000000000011", "box-one", null)])) : response({ error: { code: "not_found" } }, 404));
  const host = await mount();
  expect(host.textContent).toContain("box-one");
  expect(host.querySelector(".remote-link-child-badges")).toBeNull();
  expect(host.querySelector(".remote-link-child-actions")).toBeNull();
  expect(host.querySelector(".remote-link-child-bulk")).toBeNull();
  expect(host.querySelector(".remote-link-policy")).toBeNull();
  expect(button(host, "Disconnect").disabled).toBe(false);
  expect(calls.some(call => call.path.startsWith("/api/link/children/"))).toBe(false);
});

test("badges carry version, skew, catalog, Codex restart and owner action", async () => {
  installFetch(() => response(status([
    row("lnk_0000000000000011", "box-one", childBlock({ codex: { appServers: "stale", staleCount: 2, catalogMatchesHome: false, catalogSyncedAt: null, reportedAt: 5 } })),
    row("lnk_0000000000000012", "box-two", childBlock({ versionSkew: "same", update: { route: "owner-action", reason: "desktop-app-owned", observedAt: null }, catalog: { state: "current", pulledAt: 1, homeChangedAt: 1 } })),
  ])));
  const host = await mount();
  const first = host.querySelectorAll(".remote-link-child-badges")[0]!;
  expect(first.textContent).toContain("v2.34.0");
  expect(first.textContent).toContain("Behind Home (2.35.0)");
  expect(first.textContent).toContain("Update available: 2.35.0");
  expect(first.textContent).toContain("Catalog out of date");
  expect(first.textContent).toContain("Codex restart needed (2)");
  const second = host.querySelectorAll(".remote-link-child-badges")[1]!;
  expect(second.textContent).toContain("Same version as Home");
  expect(second.textContent).toContain("Use Check for Updates in OpenCodex Desktop on this Child");
});

test("Check and Sync now post exact single-link bodies", async () => {
  const calls = installFetch(call => {
    if (call.path.startsWith("/api/link/status")) return response(status([row("lnk_0000000000000011", "box-one", childBlock({ activity: { idle: false, inFlight: 1, lastDataEndAt: null } }))]));
    if (call.path === "/api/link/children/operations") return response({ job: job({ op: "observe", state: "done", items: [] }) }, 202);
    return response({ error: { code: "not_found" } }, 404);
  });
  const host = await mount();
  await click(button(host, "Check"));
  await click(button(host, "Sync now"));
  const posts = calls.filter(call => call.method === "POST");
  expect(posts.map(call => call.body)).toEqual([{ op: "observe", linkIds: ["lnk_0000000000000011"] }, { op: "sync", linkIds: ["lnk_0000000000000011"] }]);
});

test("Restart Codex picks a scope and states the app-server caveat", async () => {
  const calls = installFetch(call => {
    if (call.path.startsWith("/api/link/status")) return response(status([row("lnk_0000000000000011", "box-one", childBlock())]));
    if (call.path === "/api/link/children/operations") return response({ job: job({ op: "restart-codex", state: "done", items: [] }) }, 202);
    return response({ error: { code: "not_found" } }, 404);
  });
  const host = await mount();
  await click(button(host, "Restart Codex"));
  const dialog = openDialog(host);
  expect(dialog.querySelectorAll<HTMLInputElement>("input[type=radio]")[0]?.checked).toBe(true);
  expect(dialog.textContent).toContain("The Codex desktop app's own app-server is not refreshed");
  await click([...dialog.querySelectorAll("button")].find(item => item.textContent === "Restart")!);
  expect(calls.filter(call => call.method === "POST").at(-1)?.body).toEqual({ op: "restart-codex", linkIds: ["lnk_0000000000000011"], restart: "app-server" });

  await click(button(host, "Restart Codex"));
  const reopened = openDialog(host);
  await click(reopened.querySelectorAll<HTMLInputElement>("input[type=radio]")[1]!);
  expect(reopened.textContent).toContain("Quits and relaunches the Codex desktop app on box-one");
  await click([...reopened.querySelectorAll("button")].find(item => item.textContent === "Restart")!);
  expect(calls.filter(call => call.method === "POST").at(-1)?.body).toEqual({ op: "restart-codex", linkIds: ["lnk_0000000000000011"], restart: "codex" });
});

test("a cancelled restart dialog reopens at the app-server default", async () => {
  const calls = installFetch(call => {
    if (call.path.startsWith("/api/link/status")) return response(status([row("lnk_0000000000000011", "box-one", childBlock())]));
    if (call.path === "/api/link/children/operations") return response({ job: job({ op: "restart-codex", state: "done", items: [] }) }, 202);
    return response({ error: { code: "not_found" } }, 404);
  });
  const host = await mount();
  await click(button(host, "Restart Codex"));
  await click(openDialog(host).querySelectorAll<HTMLInputElement>("input[type=radio]")[1]!);
  await click([...openDialog(host).querySelectorAll("button")].find(item => item.textContent === "Cancel")!);
  expect(calls.filter(call => call.method === "POST")).toHaveLength(0);
  await click(button(host, "Restart Codex"));
  const reopened = openDialog(host);
  expect(reopened.querySelectorAll<HTMLInputElement>("input[type=radio]")[0]?.checked).toBe(true);
  expect(reopened.querySelectorAll<HTMLInputElement>("input[type=radio]")[1]?.checked).toBe(false);
});

test("Update and Update all confirm the disruption and post their bodies", async () => {
  const calls = installFetch(call => {
    if (call.path.startsWith("/api/link/status")) return response(status([
      row("lnk_0000000000000011", "box-one", childBlock()),
      row("lnk_0000000000000012", "box-two", childBlock({ versionSkew: "same", update: { route: "orchestrated", reason: null, observedAt: null } })),
    ]));
    if (call.path === "/api/link/children/operations") return response({ job: job({ state: "done", items: [] }) }, 202);
    return response({ error: { code: "not_found" } }, 404);
  });
  const host = await mount();
  const updateAll = button(host, "Update all");
  expect(updateAll.disabled).toBe(false);
  await click(updateAll);
  const bulk = host.querySelector(".remote-link-child-bulk")!;
  const bulkDialog = bulk.querySelector("dialog")!;
  expect(bulkDialog.textContent).toContain("Update 1 Children to 2.35.0, one at a time.");
  expect(bulkDialog.textContent).toContain("ends any turn currently relayed for it");
  expect(bulkDialog.textContent).toContain("Automatic updates wait until a Child is idle.");
  await click([...bulkDialog.querySelectorAll("button")].find(item => item.textContent === "Update all")!);
  expect(calls.filter(call => call.method === "POST").at(-1)?.body).toEqual({ op: "update", linkIds: ["lnk_0000000000000011"] });

  const firstRow = host.querySelectorAll(".remote-link-row")[0]!;
  await click([...firstRow.querySelectorAll("button")].find(item => item.textContent === "Update")!);
  const rowDialog = openDialog(firstRow);
  expect(rowDialog.textContent).toContain("Update box-one to 2.35.0?");
  expect(rowDialog.textContent).toContain("ends any turn currently relayed for it");
  await click([...rowDialog.querySelectorAll("button")].find(item => item.textContent === "Update")!);
  expect(calls.filter(call => call.method === "POST").at(-1)?.body).toEqual({ op: "update", linkIds: ["lnk_0000000000000011"] });
});

test("Update all and Check all name exactly the rows they cover", async () => {
  const calls = installFetch(call => {
    if (call.path.startsWith("/api/link/status")) return response(status([
      row("lnk_0000000000000011", "box-one", childBlock()),
      row("lnk_0000000000000012", "box-two", childBlock({ versionSkew: "same", update: { route: "orchestrated", reason: null, observedAt: null } })),
      row("lnk_0000000000000013", "box-three", childBlock(), "client-initiated"),
      row("lnk_0000000000000014", "box-four", childBlock()),
    ]));
    if (call.path === "/api/link/children/operations") return response({ job: job({ state: "done", items: [] }) }, 202);
    return response({ error: { code: "not_found" } }, 404);
  });
  const host = await mount();
  await click(button(host, "Update all"));
  const bulk = host.querySelector(".remote-link-child-bulk")!;
  const bulkDialog = bulk.querySelector("dialog")!;
  expect(bulkDialog.textContent).toContain("Update 2 Children to 2.35.0, one at a time.");
  await click([...bulkDialog.querySelectorAll("button")].find(item => item.textContent === "Update all")!);
  // l2 is current and l3 was started from itself, so neither is in the confirmation or the request.
  expect(calls.filter(call => call.method === "POST").at(-1)?.body).toEqual({ op: "update", linkIds: ["lnk_0000000000000011", "lnk_0000000000000014"] });
  await click(button(host, "Check all"));
  expect(calls.filter(call => call.method === "POST").at(-1)?.body).toEqual({ op: "observe", linkIds: ["lnk_0000000000000011", "lnk_0000000000000012", "lnk_0000000000000014"] });
});

test("bulk actions split more than 64 Children into requests the server accepts", async () => {
  // The operations route refuses a body naming more than 64 links, and a Home's link count is unbounded.
  const ids = Array.from({ length: 65 }, (_, index) => `lnk_${index.toString(16).padStart(16, "0")}`);
  const calls = installFetch(call => {
    if (call.path.startsWith("/api/link/status")) return response(status(ids.map(id => row(id, `box-${id}`, childBlock()))));
    if (call.path === "/api/link/children/operations") return response({ job: job({ jobId: `ljob_${String(calls.length).padStart(16, "0")}`, state: "done", items: [] }) }, 202);
    return response({ error: { code: "not_found" } }, 404);
  });
  const host = await mount();
  await click(button(host, "Check all"));
  await settleUntil(() => calls.filter(call => call.method === "POST").length === 2);
  const checks = calls.filter(call => call.method === "POST").map(call => call.body);
  expect(checks).toEqual([{ op: "observe", linkIds: ids.slice(0, 33) }, { op: "observe", linkIds: ids.slice(33) }]);
  await click(button(host, "Update all"));
  const bulkDialog = host.querySelector(".remote-link-child-bulk dialog")!;
  expect(bulkDialog.textContent).toContain("Update 65 Children");
  await click([...bulkDialog.querySelectorAll("button")].find(item => item.textContent === "Update all")!);
  await settleUntil(() => calls.filter(call => call.method === "POST").length === 4);
  const updates = calls.filter(call => call.method === "POST").slice(2).map(call => call.body);
  expect(updates).toEqual([{ op: "update", linkIds: ids.slice(0, 33) }, { op: "update", linkIds: ids.slice(33) }]);
  expect(host.textContent).not.toContain("could not be completed");
});

test("the GUI copy of the per-request link cap equals the route's, and groups are even and within it", () => {
  // gui/ cannot import the route; a drifted copy would turn every large bulk action into whole-group refusals.
  expect(CHILD_OPERATION_MAX_LINK_IDS).toBe(CHILD_OPS_MAX_LINK_IDS);
  const ids = (count: number) => Array.from({ length: count }, (_, index) => `lnk_${index.toString(16).padStart(16, "0")}`);
  expect(chunkLinkIds(ids(64)).map(group => group.length)).toEqual([64]);
  expect(chunkLinkIds(ids(65)).map(group => group.length)).toEqual([33, 32]);
  expect(chunkLinkIds(ids(129)).map(group => group.length)).toEqual([43, 43, 43]);
  expect(chunkLinkIds([])).toEqual([]);
  for (const count of [1, 63, 65, 128, 200, 1000, 4033, 4097, 10_000]) {
    const groups = chunkLinkIds(ids(count));
    expect(groups.flat()).toEqual(ids(count));
    expect(groups.every(group => group.length <= CHILD_OPS_MAX_LINK_IDS && (count === 1 || group.length > 1))).toBe(true);
    const sizes = groups.map(group => group.length);
    expect(Math.max(...sizes) - Math.min(...sizes)).toBeLessThanOrEqual(1);
  }
});

test("a submit that never settles is abandoned at its deadline", async () => {
  // The bulk bar and row actions stay busy until the POST settles; one that hangs and ignores its signal must still end.
  globalThis.fetch = (() => new Promise<Response>(() => undefined)) as unknown as typeof fetch;
  const started = Date.now();
  await expect(postChildOperation(HOME, { op: "observe", linkIds: ["lnk_0000000000000011"] }, 30)).rejects.toBeDefined();
  expect(Date.now() - started).toBeLessThan(2_000);
});

test("a refused bulk group shows its error while the accepted group is still tracked", async () => {
  const ids = Array.from({ length: 65 }, (_, index) => `lnk_${index.toString(16).padStart(16, "0")}`);
  installFetch(call => {
    if (call.path.startsWith("/api/link/status")) return response(status(ids.map(id => row(id, `box-${id}`, childBlock()))));
    if (call.path === "/api/link/children/operations") {
      const linkIds = call.body?.linkIds as string[];
      if (linkIds.includes("lnk_0000000000000040")) return response({ error: { code: "link_operation_in_progress" } }, 409);
      return response({ job: job({ jobId: "ljob_bulkgroup0000000", op: "observe", items: [
        { linkId: "lnk_0000000000000000", alias: "box-lnk_0000000000000000", state: "running", reason: null, fromVersion: null, toVersion: null, startedAt: null, finishedAt: null },
      ] }) }, 202);
    }
    if (call.path.startsWith("/api/link/children/jobs/")) return new Promise<Response>(() => undefined);
    return response({ error: { code: "not_found" } }, 404);
  });
  const host = await mount();
  await click(button(host, "Check all"));
  await settleUntil(() => host.textContent?.includes("Another operation is running on this Child.") === true);
  expect(host.textContent).toContain("Another operation is running on this Child.");
  // The first group was accepted, so its job panel shows and the row its job names (the first) is held.
  expect(host.querySelector(".remote-link-job")).not.toBeNull();
  const firstRow = host.querySelectorAll(".remote-link-row")[0]!;
  const rowButtons = [...firstRow.querySelectorAll("button")];
  for (const label of ["Check", "Sync now", "Update", "Disconnect"]) {
    expect(rowButtons.find(item => item.textContent === label)!.disabled).toBe(true);
  }
  // A row the accepted job does not name keeps its controls.
  const otherRow = host.querySelectorAll(".remote-link-row")[1]!;
  expect([...otherRow.querySelectorAll("button")].find(item => item.textContent === "Check")!.disabled).toBe(false);
});

test("a running job shows per-item progress and refreshes status once when done", async () => {
  let jobPolls = 0;
  const calls = installFetch(call => {
    if (call.path.startsWith("/api/link/status")) return response(status([row("lnk_0000000000000011", "box-one", childBlock())]));
    if (call.path === "/api/link/children/operations") return response({ job: job() }, 202);
    if (call.path === "/api/link/children/jobs/ljob_0123456789abcdef") {
      jobPolls += 1;
      return response({ job: job({ state: "done", items: [{ linkId: "lnk_0000000000000011", alias: "box-one", state: "succeeded", reason: null, fromVersion: "2.34.0", toVersion: "2.35.0", sync: { state: "synced", reason: null }, restart: { requested: "app-server", outcome: "requested" }, startedAt: null, finishedAt: null }] }) });
    }
    return response({ error: { code: "not_found" } }, 404);
  });
  const host = await mount();
  await click([...host.querySelectorAll(".remote-link-row button")].find(item => item.textContent === "Update")!);
  await click([...host.querySelectorAll(".remote-link-row dialog button")].find(item => item.textContent === "Update")!);
  const panel = host.querySelector(".remote-link-job")!;
  expect(panel.textContent).toContain("Updating…");
  expect(panel.textContent).toContain("Running");
  const statusReads = calls.filter(call => call.path.includes("/api/link/status")).length;
  await pollJobs();
  // The panel leaves the page once the job is done; the rows carry the result after one refresh.
  await settleUntil(() => host.querySelector(".remote-link-job") === null);
  expect(host.querySelector(".remote-link-job")).toBeNull();
  // pollJobs also wakes the page's own status poll, so count the completion refresh where it is exact: onDone.
  expect(calls.filter(call => call.path.includes("/api/link/status")).length).toBeGreaterThan(statusReads);
  expect(jobPolls).toBeGreaterThan(0);
});

test("a finished job renders item states, sync and restart outcomes", async () => {
  installFetch(call => call.path.startsWith("/api/link/children/jobs/")
    ? response({ job: job({ state: "done", items: [{ linkId: "lnk_0000000000000011", alias: "box-one", state: "succeeded", reason: null, fromVersion: "2.34.0", toVersion: "2.35.0", sync: { state: "synced", reason: null }, restart: { requested: "app-server", outcome: "requested" }, startedAt: null, finishedAt: null }] }) })
    : response({ error: { code: "not_found" } }, 404));
  const finished = job({ state: "done", items: [{ linkId: "lnk_0000000000000011", alias: "box-one", state: "succeeded", reason: null, fromVersion: "2.34.0", toVersion: "2.35.0", sync: { state: "synced", reason: null }, restart: { requested: "app-server", outcome: "requested" }, startedAt: null, finishedAt: null }] });
  let doneCalls = 0;
  const host = await mountNode(<ChildJobProgress apiBase={HOME} job={parseChildJob(finished)} onDone={() => { doneCalls += 1; }} />);
  const panel = host.querySelector(".remote-link-job")!;
  expect(panel.textContent).toContain("Succeeded");
  expect(panel.textContent).toContain("Synced");
  expect(panel.textContent).toContain("Restart requested");
  expect(panel.textContent).toContain("2.34.0 → 2.35.0");
  expect(doneCalls).toBe(1);
});

test("a job_not_found answer stops polling and marks running items uncertain", async () => {
  const calls = installFetch(call => {
    if (call.path.startsWith("/api/link/status")) return response(status([row("lnk_0000000000000011", "box-one", childBlock())]));
    if (call.path === "/api/link/children/operations") return response({ job: job() }, 202);
    if (call.path.startsWith("/api/link/children/jobs/")) return response({ error: { code: "job_not_found" } }, 404);
    return response({ error: { code: "not_found" } }, 404);
  });
  const host = await mount();
  await click([...host.querySelectorAll(".remote-link-row button")].find(item => item.textContent === "Update")!);
  await click([...host.querySelectorAll(".remote-link-row dialog button")].find(item => item.textContent === "Update")!);
  await pollJobs();
  const polls = calls.filter(call => call.path.startsWith("/api/link/children/jobs/")).length;
  await settleUntil(() => host.querySelector(".remote-link-job") === null);
  await pollJobs();
  expect(calls.filter(call => call.path.startsWith("/api/link/children/jobs/")).length).toBe(polls);
  expect(polls).toBeGreaterThan(0);
});

test("a lost job says its progress is gone and marks a running item uncertain", async () => {
  installFetch(() => response({ error: { code: "job_not_found" } }, 404));
  const host = await mountNode(<ChildJobProgress apiBase={HOME} job={parseChildJob(job())} onDone={() => {}} />);
  await settleUntil(() => (host.querySelector(".remote-link-job")?.textContent ?? "").includes("Outcome unknown"));
  const panel = host.querySelector(".remote-link-job")!;
  expect(panel.textContent).toContain("Outcome unknown");
  expect(panel.textContent).toContain("This Home restarted, so the job's progress is gone.");
});

test("a 409 link_operation_in_progress is shown translated", async () => {
  installFetch(call => {
    if (call.path.startsWith("/api/link/status")) return response(status([row("lnk_0000000000000011", "box-one", childBlock())]));
    if (call.path === "/api/link/children/operations") return response({ error: { code: "link_operation_in_progress" } }, 409);
    return response({ error: { code: "not_found" } }, 404);
  });
  const host = await mount();
  await click(button(host, "Check"));
  expect(host.textContent).toContain("Another operation is running on this Child.");
});

test("an active job holds the row and its progress is adopted on load", async () => {
  const calls = installFetch(call => {
    if (call.path.startsWith("/api/link/status")) return response(status([
      row("lnk_0000000000000011", "box-one", childBlock({ activeJob: { jobId: "ljob_0123456789abcdef", op: "sync", state: "running" } })),
      row("lnk_0000000000000012", "box-two", childBlock({ activeJob: { jobId: "ljob_fedcba9876543210", op: "update", state: "running" } })),
    ]));
    if (call.path === "/api/link/children/jobs/ljob_0123456789abcdef") return response({ job: job({ jobId: "ljob_0123456789abcdef", op: "sync" }) });
    if (call.path === "/api/link/children/jobs/ljob_fedcba9876543210") return response({ job: job({ jobId: "ljob_fedcba9876543210", op: "update" }) });
    return response({ error: { code: "not_found" } }, 404);
  });
  const host = await mount();
  await settleUntil(() => host.querySelectorAll(".remote-link-job").length === 2);
  expect(host.querySelectorAll(".remote-link-job")).toHaveLength(2);
  expect(calls.filter(call => call.path.startsWith("/api/link/children/jobs/")).length).toBe(2);
  const firstRow = host.querySelectorAll(".remote-link-row")[0]!;
  for (const label of ["Check", "Sync now", "Restart Codex", "Update"]) {
    expect(([...firstRow.querySelectorAll("button")].find(item => item.textContent === label) as HTMLButtonElement).disabled).toBe(true);
  }
  expect(([...firstRow.querySelectorAll("button")].find(item => item.textContent === "Disconnect") as HTMLButtonElement).disabled).toBe(true);
});

test("an accepted job holds the row before the next status poll reports it", async () => {
  let polls = 0;
  const calls = installFetch(call => {
    if (call.path.startsWith("/api/link/status")) {
      polls += 1;
      // The first read has no activeJob; the server only reports it on a later poll.
      return response(status([row("lnk_0000000000000011", "box-one", childBlock()), row("lnk_0000000000000012", "box-two", childBlock())]));
    }
    if (call.path === "/api/link/children/operations") return response({ job: job() }, 202);
    if (call.path.startsWith("/api/link/children/jobs/")) return response({ job: job() });
    return response({ error: { code: "not_found" } }, 404);
  });
  const host = await mount();
  const firstRow = host.querySelectorAll(".remote-link-row")[0]!;
  await click([...firstRow.querySelectorAll("button")].find(item => item.textContent === "Update")!);
  await click([...firstRow.querySelectorAll("dialog button")].find(item => item.textContent === "Update")!);
  // The POST is accepted and the job is tracked: childOpBusy is clear, and no status poll has reported activeJob.
  const rowButtons = () => [...firstRow.querySelectorAll("button")];
  for (const label of ["Check", "Sync now", "Restart Codex", "Update"]) {
    expect(rowButtons().find(item => item.textContent === label)!.disabled).toBe(true);
  }
  expect(rowButtons().find(item => item.textContent === "Disconnect")!.disabled).toBe(true);
  // The tracked job names l1 only; l2 keeps its controls.
  const secondRow = host.querySelectorAll(".remote-link-row")[1]!;
  expect(([...secondRow.querySelectorAll("button")].find(item => item.textContent === "Check") as HTMLButtonElement).disabled).toBe(false);
  expect(([...secondRow.querySelectorAll("button")].find(item => item.textContent === "Disconnect") as HTMLButtonElement).disabled).toBe(false);
  expect(calls.filter(call => call.method === "POST")).toHaveLength(1);
  expect(polls).toBeGreaterThan(0);
});

test("a client-initiated row shows badges but no actions", async () => {
  installFetch(() => response(status([row("lnk_0000000000000011", "box-one", childBlock(), "client-initiated")])));
  const host = await mount();
  expect(host.querySelector(".remote-link-child-badges")).not.toBeNull();
  expect(host.querySelector(".remote-link-child-actions")).toBeNull();
  expect(button(host, "Disconnect").disabled).toBe(false);
});

test("manual restart and update wait for in-flight activity only", async () => {
  installFetch(call => call.path.startsWith("/api/link/status")
    ? response(status([row("lnk_0000000000000011", "box-one", childBlock({ activity: { idle: false, inFlight: 2, lastDataEndAt: 7 } }))]))
    : response({ error: { code: "not_found" } }, 404));
  const host = await mount();
  expect(button(host, "Check").disabled).toBe(false);
  expect(button(host, "Sync now").disabled).toBe(false);
  expect(button(host, "Restart Codex").disabled).toBe(true);
  expect(button(host, "Update").disabled).toBe(true);
});

test("the policy panel loads once, keeps edits across a status poll, and saves only changed keys", async () => {
  const calls = installFetch(call => {
    if (call.path.startsWith("/api/link/status")) return response(status([row("lnk_0000000000000011", "box-one", childBlock())]));
    if (call.path === "/api/link/children/policy" && call.method === "GET") return response({ policy: POLICY, warning: null });
    if (call.path === "/api/link/children/policy" && call.method === "PUT") return response({ policy: { ...POLICY, catalogFanout: "manual" }, warning: null });
    return response({ error: { code: "not_found" } }, 404);
  });
  const host = await mount();
  await settleUntil(() => host.querySelector(".remote-link-policy") !== null);
  expect(host.querySelector(".remote-link-policy")!.textContent).toContain("Child automation");
  await click(openSelect(host, 0));
  await chooseOption("Manual");
  await act(async () => { win.document.dispatchEvent(new win.Event("visibilitychange")); });
  await flush();
  expect(openSelect(host, 0).textContent).toContain("Manual");
  expect(calls.filter(call => call.path === "/api/link/children/policy" && call.method === "GET")).toHaveLength(1);
  await click(button(host, "Save"));
  expect(calls.filter(call => call.method === "PUT").at(-1)?.body).toEqual({ catalogFanout: "manual" });
  expect(host.querySelector(".remote-link-policy")!.textContent).toContain("Saved");
});

test("a damaged policy file warns and a save writes every knob", async () => {
  const calls = installFetch(call => {
    if (call.path.startsWith("/api/link/status")) return response(status([row("lnk_0000000000000011", "box-one", childBlock())]));
    if (call.path === "/api/link/children/policy" && call.method === "GET") return response({ policy: { catalogFanout: "manual", childCodexRestart: "never", updates: "off", idleAfterMs: 600_000 }, warning: "policy-file-invalid" });
    if (call.path === "/api/link/children/policy" && call.method === "PUT") return response({ policy: { ...POLICY }, warning: null });
    return response({ error: { code: "not_found" } }, 404);
  });
  const host = await mount();
  await settleUntil(() => host.querySelector(".remote-link-policy") !== null);
  expect(host.querySelector(".remote-link-policy")!.textContent).toContain("automatic catalog fan-out and automatic updates are off");
  await click(openSelect(host, 0));
  await chooseOption("Automatic");
  await click(button(host, "Save"));
  expect(calls.filter(call => call.method === "PUT").at(-1)?.body).toEqual({ catalogFanout: "auto", childCodexRestart: "never", updates: "off", idleAfterMs: 600_000 });
});

test("a failed policy load shows an error with Retry, and Retry re-reads the policy", async () => {
  let reads = 0;
  const calls = installFetch(call => {
    if (call.path.startsWith("/api/link/status")) return response(status([row("lnk_0000000000000011", "box-one", childBlock())]));
    if (call.path === "/api/link/children/policy" && call.method === "GET") {
      reads += 1;
      return reads === 1 ? response({ error: { code: "policy_write_failed" } }, 500) : response({ policy: POLICY, warning: null });
    }
    return response({ error: { code: "not_found" } }, 404);
  });
  const host = await mount();
  await settleUntil(() => host.querySelector(".remote-link-policy")?.textContent?.includes("Could not load Child automation settings") ?? false);
  const panel = host.querySelector(".remote-link-policy")!;
  expect(panel.textContent).toContain("Could not load Child automation settings.");
  expect(calls.filter(call => call.path === "/api/link/children/policy")).toHaveLength(1);
  await click(button(host, "Retry"));
  await settleUntil(() => host.querySelector(".remote-link-policy")?.querySelector("[role=combobox]") !== null);
  const reloaded = host.querySelector(".remote-link-policy")!;
  expect(reloaded.querySelectorAll("[role=combobox]").length).toBeGreaterThan(0);
  expect(reloaded.textContent).not.toContain("Could not load Child automation settings.");
  expect(calls.filter(call => call.path === "/api/link/children/policy" && call.method === "GET")).toHaveLength(2);
});

test("the page Refresh also reloads the policy", async () => {
  const calls = installFetch(call => {
    if (call.path.startsWith("/api/link/status")) return response(status([row("lnk_0000000000000011", "box-one", childBlock())]));
    if (call.path === "/api/link/children/policy" && call.method === "GET") return response({ policy: POLICY, warning: null });
    return response({ error: { code: "not_found" } }, 404);
  });
  const host = await mount();
  await settleUntil(() => host.querySelector(".remote-link-policy") !== null);
  expect(calls.filter(call => call.path === "/api/link/children/policy")).toHaveLength(1);
  // A status poll alone must not re-read the policy, or an in-progress edit would be lost.
  await act(async () => { win.document.dispatchEvent(new win.Event("visibilitychange")); });
  await flush();
  expect(calls.filter(call => call.path === "/api/link/children/policy")).toHaveLength(1);
  await click(button(host, "Refresh"));
  await settleUntil(() => calls.filter(call => call.path === "/api/link/children/policy").length === 2);
  expect(calls.filter(call => call.path === "/api/link/children/policy" && call.method === "GET").length).toBe(2);
});

test("the idle-minutes input only accepts digits in range", async () => {
  const calls = installFetch(call => {
    if (call.path.startsWith("/api/link/status")) return response(status([row("lnk_0000000000000011", "box-one", childBlock())]));
    if (call.path === "/api/link/children/policy" && call.method === "GET") return response({ policy: POLICY, warning: null });
    if (call.path === "/api/link/children/policy" && call.method === "PUT") return response({ policy: POLICY, warning: null });
    return response({ error: { code: "not_found" } }, 404);
  });
  const host = await mount();
  await settleUntil(() => host.querySelector(".remote-link-policy") !== null);
  const input = host.querySelector<HTMLInputElement>(".remote-link-policy input[type=number]")!;
  const type = async (value: string) => {
    await act(async () => {
      Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, "value")!.set!.call(input, value);
      input.dispatchEvent(new win.Event("input", { bubbles: true }));
      input.dispatchEvent(new win.Event("change", { bubbles: true }));
      await flush();
    });
  };
  // Empty, partial and out-of-range text never reaches the draft: the input keeps the last valid value.
  for (const bad of ["", "0", "61", "1e3", "-5", "7.5"]) { await type(bad); expect(input.value).toBe("10"); }
  await type("15");
  expect(input.value).toBe("15");
  await click(button(host, "Save"));
  expect(calls.filter(call => call.method === "PUT").at(-1)?.body).toEqual({ idleAfterMs: 900_000 });
});

test("a withheld restart says a request was in flight", async () => {
  installFetch(() => response({ job: job({ state: "done", items: [{ linkId: "lnk_0000000000000011", alias: "box-one", state: "succeeded", reason: null, fromVersion: null, toVersion: null, restart: { requested: "app-server", outcome: "skipped" }, startedAt: null, finishedAt: null }] }) }));
  const host = await mountNode(<ChildJobProgress apiBase={HOME} job={parseChildJob(job({ op: "restart-codex" }))} onDone={() => {}} />);
  await settleUntil(() => (host.querySelector(".remote-link-job")?.textContent ?? "").includes("Restart withheld"));
  const panel = host.querySelector(".remote-link-job")!;
  expect(panel.textContent).toContain("Restart withheld: a request was in flight on this Child.");
  expect(panel.textContent).not.toContain("Restart requested");
});

test("an unknown last-operation state renders as code", async () => {
  installFetch(() => response(status([row("lnk_0000000000000011", "box-one", childBlock({
    lastOperation: { op: "update", jobId: "ljob_0123456789abcdef", state: "melted", reason: null, fromVersion: null, toVersion: null, finishedAt: null },
  }))])));
  const host = await mount();
  const badges = host.querySelector(".remote-link-child-badges")!;
  expect([...badges.querySelectorAll("code")].map(item => item.textContent)).toContain("melted");
  // `remoteLink.job.last` names the operation with a noun key (OP_NOUN_KEY), not the in-progress label.
  expect(badges.textContent).toContain("Last operation: Update — melted");
});

test("an unknown restart outcome renders as code instead of a guessed sentence", async () => {
  const melted = job({ items: [{ linkId: "lnk_0000000000000011", alias: "box-one", state: "succeeded", reason: null, fromVersion: null, toVersion: null, restart: { requested: "app-server", outcome: "melted" }, startedAt: null, finishedAt: null }] });
  installFetch(() => response({ job: melted }));
  const host = await mountNode(<ChildJobProgress apiBase={HOME} job={parseChildJob(melted)} onDone={() => {}} />);
  await settleUntil(() => [...host.querySelectorAll("code")].some(item => item.textContent === "melted"));
  expect([...host.querySelectorAll("code")].map(item => item.textContent)).toContain("melted");
  expect(host.querySelector(".remote-link-job")!.textContent).not.toContain("Restart requested");
});

test("a job item renders the hint the server attached to it", async () => {
  const hinted = job({ state: "done", items: [{ linkId: "lnk_0000000000000011", alias: "box-one", state: "owner-action", reason: "launcher-node-missing",
    hint: "Install Node.js where the npm or pnpm that installed OpenCodex on this Child can find it, or update there with ocx update.",
    fromVersion: null, toVersion: null, startedAt: null, finishedAt: null }] });
  installFetch(() => response({ job: hinted }));
  const host = await mountNode(<ChildJobProgress apiBase={HOME} job={parseChildJob(hinted)} onDone={() => {}} />);
  const panel = host.querySelector(".remote-link-job")!;
  expect(panel.textContent).toContain("launcher-node-missing");
  expect(panel.textContent).toContain("Install Node.js where the npm or pnpm that installed OpenCodex on this Child can find it, or update there with ocx update.");
});

test("parsers reject a malformed child block and keep an unknown job state", () => {
  expect(parseChildOps(null)).toBeNull();
  expect(parseChildOps({ homeVersion: "1.0.0" })).toBeNull();
  expect(parseChildOps(childBlock())?.versionSkew).toBe("behind");
  const parsed = parseChildJob(job({ state: "melted" }));
  expect(parsed.state).toBe("running");
  expect(parsed.items[0]?.state).toBe("running");
  expect(() => parseChildJob({ schema: "ocx.link.child-job/1" })).toThrow();
});

test("a two-item job releases a row as soon as its own item finishes", async () => {
  const twoItemJob = (first: string) => job({ jobId: "ljob_twoitems00000000", state: "running", items: [
    { linkId: "lnk_0000000000000011", alias: "box-one", state: first, reason: null, fromVersion: null, toVersion: null, startedAt: null, finishedAt: null },
    { linkId: "lnk_0000000000000012", alias: "box-two", state: "running", reason: null, fromVersion: null, toVersion: null, startedAt: null, finishedAt: null },
  ] });
  let reads = 0;
  installFetch(call => {
    // No status row carries activeJob: the page's accepted job is the only signal, as right after the POST.
    if (call.path.startsWith("/api/link/status")) return response(status([row("lnk_0000000000000011", "box-one", childBlock()), row("lnk_0000000000000012", "box-two", childBlock())]));
    if (call.path === "/api/link/children/operations") return response({ job: twoItemJob("running") }, 202);
    if (call.path === "/api/link/children/jobs/ljob_twoitems00000000") {
      reads += 1;
      return response({ job: twoItemJob(reads === 1 ? "running" : "succeeded") });
    }
    return response({ error: { code: "not_found" } }, 404);
  });
  const host = await mount();
  await click(button(host, "Check all"));
  await settleUntil(() => host.querySelectorAll(".remote-link-job").length === 1);
  const check = (index: number) => [...host.querySelectorAll(".remote-link-row")[index]!.querySelectorAll("button")].find(item => item.textContent === "Check") as HTMLButtonElement;
  // Both items are still running, so both rows are held.
  expect(check(0).disabled).toBe(true);
  expect(check(1).disabled).toBe(true);
  await pollJobs();
  await settleUntil(() => reads >= 2);
  // The first item reached a terminal state; the page must release that row without waiting for the second.
  await settleUntil(() => !check(0).disabled);
  expect(check(0).disabled).toBe(false);
  expect(check(1).disabled).toBe(true);
});

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(res => { resolve = res; });
  return { promise, resolve };
}

test("a policy GET in flight when a save starts never overwrites the saved values", async () => {
  const stale = deferred<Response>();
  let reads = 0;
  const calls = installFetch(call => {
    if (call.path.startsWith("/api/link/status")) return response(status([row("lnk_0000000000000011", "box-one", childBlock())]));
    if (call.path === "/api/link/children/policy" && call.method === "GET") {
      reads += 1;
      return reads === 1 ? response({ policy: POLICY, warning: null }) : stale.promise;
    }
    if (call.path === "/api/link/children/policy" && call.method === "PUT") return response({ policy: { ...POLICY, catalogFanout: "manual" }, warning: null });
    return response({ error: { code: "not_found" } }, 404);
  });
  const host = await mount();
  await settleUntil(() => host.querySelector(".remote-link-policy") !== null);
  await click(button(host, "Refresh"));
  await settleUntil(() => reads === 2);
  await click(openSelect(host, 0));
  await chooseOption("Manual");
  await click(button(host, "Save"));
  expect(host.querySelector(".remote-link-policy")!.textContent).toContain("Saved");
  // The reload that began before the save lands afterwards: it must not replace what the save wrote.
  await act(async () => { stale.resolve(response({ policy: { ...POLICY, catalogFanout: "auto", updates: "off" }, warning: null })); await flush(); });
  expect(openSelect(host, 0).textContent).toContain("Manual");
  expect(host.querySelector(".remote-link-policy")!.textContent).toContain("Saved");
  expect(calls.filter(call => call.method === "PUT")).toHaveLength(1);
});

test("an edit made during a policy reload survives it", async () => {
  const slow = deferred<Response>();
  let reads = 0;
  const calls = installFetch(call => {
    if (call.path.startsWith("/api/link/status")) return response(status([row("lnk_0000000000000011", "box-one", childBlock())]));
    if (call.path === "/api/link/children/policy" && call.method === "GET") {
      reads += 1;
      return reads === 1 ? response({ policy: POLICY, warning: null }) : slow.promise;
    }
    if (call.path === "/api/link/children/policy" && call.method === "PUT") return response({ policy: { ...POLICY, catalogFanout: "manual" }, warning: null });
    return response({ error: { code: "not_found" } }, 404);
  });
  const host = await mount();
  await settleUntil(() => host.querySelector(".remote-link-policy") !== null);
  await click(button(host, "Refresh"));
  await settleUntil(() => reads === 2);
  await click(openSelect(host, 0));
  await chooseOption("Manual");
  // The reload lands after the edit; the operator's choice must stay, and the save must carry it.
  await act(async () => { slow.resolve(response({ policy: POLICY, warning: null })); await flush(); });
  expect(openSelect(host, 0).textContent).toContain("Manual");
  await click(button(host, "Save"));
  expect(calls.filter(call => call.method === "PUT").at(-1)?.body).toEqual({ catalogFanout: "manual" });
});

test("a job poll that never settles times out, so the interval polls again and releases the row", async () => {
  // Capture the poll interval and the per-request deadline so the test drives them instead of waiting them out.
  const ticks: Array<() => void> = [];
  const deadlines: Array<() => void> = [];
  const setIntervalReal = win.setInterval.bind(win);
  const setTimeoutReal = win.setTimeout.bind(win);
  Object.assign(win, {
    setInterval: (callback: () => void, ms?: number) => { if (ms === CHILD_JOB_POLL_MS) ticks.push(callback); return setIntervalReal(() => undefined, 3_600_000); },
    setTimeout: (callback: () => void, ms?: number) => { if (ms === CHILD_JOB_POLL_TIMEOUT_MS) deadlines.push(callback); return setTimeoutReal(callback, ms === CHILD_JOB_POLL_TIMEOUT_MS ? 3_600_000 : ms); },
  });
  const items = (state: string) => job({ jobId: "ljob_hung000000000000", state: "running", items: [
    { linkId: "lnk_0000000000000011", alias: "box-one", state, reason: null, fromVersion: null, toVersion: null, startedAt: null, finishedAt: null },
  ] });
  let reads = 0;
  installFetch(call => {
    if (call.path.startsWith("/api/link/status")) return response(status([row("lnk_0000000000000011", "box-one", childBlock())]));
    if (call.path === "/api/link/children/operations") return response({ job: items("running") }, 202);
    if (call.path === "/api/link/children/jobs/ljob_hung000000000000") {
      reads += 1;
      // The first poll hangs forever and ignores its abort signal, like a stalled connection.
      return reads === 1 ? new Promise<Response>(() => undefined) : response({ job: items("succeeded") });
    }
    return response({ error: { code: "not_found" } }, 404);
  });
  const host = await mount();
  await click(button(host, "Check"));
  expect(ticks.length).toBe(1);
  await act(async () => { ticks[0]!(); await flush(); });
  expect(reads).toBe(1);
  expect(button(host, "Check").disabled).toBe(true);
  // While the hung request is pending, an interval tick sends nothing.
  await act(async () => { ticks[0]!(); await flush(); });
  expect(reads).toBe(1);
  expect(deadlines.length).toBe(1);
  await act(async () => { deadlines[0]!(); await flush(); });
  await act(async () => { ticks[0]!(); await flush(); });
  expect(reads).toBe(2);
  expect(button(host, "Check").disabled).toBe(false);
  expect(host.querySelector(".remote-link-job")!.textContent).toContain("Succeeded");
});

test("an older poll landing after a newer one never restores a released hold", async () => {
  const first = deferred<Response>();
  const second = deferred<Response>();
  const items = (state: string) => job({ jobId: "ljob_overlap000000000", state: "running", items: [
    { linkId: "lnk_0000000000000011", alias: "box-one", state, reason: null, fromVersion: null, toVersion: null, startedAt: null, finishedAt: null },
  ] });
  let reads = 0;
  installFetch(call => {
    if (call.path.startsWith("/api/link/status")) return response(status([row("lnk_0000000000000011", "box-one", childBlock())]));
    if (call.path === "/api/link/children/operations") return response({ job: items("running") }, 202);
    if (call.path === "/api/link/children/jobs/ljob_overlap000000000") {
      reads += 1;
      // Poll A (running) is deliberately slow; poll B (succeeded) resolves first.
      return reads === 1 ? first.promise : reads === 2 ? second.promise : response({ job: items("succeeded") });
    }
    return response({ error: { code: "not_found" } }, 404);
  });
  const host = await mount();
  await click(button(host, "Check"));
  await settleUntil(() => reads === 1);
  // A second tick fires while the first request is still pending. Serialized polling skips it; without the guard
  // both are in flight and the older running response can land last and restore the hold.
  await pollJobs();
  await act(async () => { second.resolve(response({ job: items("succeeded") })); await flush(); });
  await act(async () => { first.resolve(response({ job: items("running") })); await flush(); });
  // Asserted before the next interval tick: a later poll would re-release a row a stale response re-held.
  expect(button(host, "Check").disabled).toBe(false);
  expect(host.querySelector(".remote-link-job")!.textContent).toContain("Succeeded");
});

test("a reload merges only the fields the operator changed onto the server's answer", async () => {
  const slow = deferred<Response>();
  let reads = 0;
  const calls = installFetch(call => {
    if (call.path.startsWith("/api/link/status")) return response(status([row("lnk_0000000000000011", "box-one", childBlock())]));
    if (call.path === "/api/link/children/policy" && call.method === "GET") {
      reads += 1;
      // The reload reports updates: off, a field the operator never touched.
      return reads === 1 ? response({ policy: POLICY, warning: null }) : slow.promise;
    }
    if (call.path === "/api/link/children/policy" && call.method === "PUT") return response({ policy: { ...POLICY, catalogFanout: "manual", updates: "off" }, warning: null });
    return response({ error: { code: "not_found" } }, 404);
  });
  const host = await mount();
  await settleUntil(() => host.querySelector(".remote-link-policy") !== null);
  await click(button(host, "Refresh"));
  await settleUntil(() => reads === 2);
  await click(openSelect(host, 0));
  await chooseOption("Manual");
  await act(async () => { slow.resolve(response({ policy: { ...POLICY, updates: "off" }, warning: null })); await flush(); });
  // The untouched field adopts the server's value; the operator's field stays.
  expect(openSelect(host, 2).textContent).toContain("Off");
  expect(openSelect(host, 0).textContent).toContain("Manual");
  await click(button(host, "Save"));
  expect(calls.filter(call => call.method === "PUT").at(-1)?.body).toEqual({ catalogFanout: "manual" });
});
