import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import type { Root } from "react-dom/client";
import { act } from "react";
import RemoteLink from "../src/pages/RemoteLink";
import { LanguageProvider } from "../src/i18n/provider";
import { parseChildJob, parseChildOps } from "../src/remote-link-child-ops-api";

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
function installFetch(handle: (call: Call) => Response): Call[] {
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
    items: [{ linkId: "l1", alias: "box-one", state: "running", reason: null, fromVersion: "2.34.0", toVersion: "2.35.0", startedAt: null, finishedAt: null }], ...overrides };
}

async function mount(): Promise<HTMLDivElement> {
  const host = win.document.createElement("div");
  win.document.body.append(host);
  root = (await import("react-dom/client")).createRoot(host);
  await act(async () => { root?.render(<LanguageProvider><RemoteLink apiBase={HOME} diagnosticsApiBase={HOME} sessionReady /></LanguageProvider>); });
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

test("status is requested with children=1", async () => {
  const calls = installFetch(() => response(status([row("l1", "box-one", childBlock())])));
  await mount();
  expect(calls[0]?.path).toBe("/api/link/status?children=1");
});

test("an older Home renders today's row with no child controls", async () => {
  const calls = installFetch(call => call.path.startsWith("/api/link/status") ? response(status([row("l1", "box-one", null)])) : response({ error: { code: "not_found" } }, 404));
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
    row("l1", "box-one", childBlock({ codex: { appServers: "stale", staleCount: 2, catalogMatchesHome: false, catalogSyncedAt: null, reportedAt: 5 } })),
    row("l2", "box-two", childBlock({ versionSkew: "same", update: { route: "owner-action", reason: "desktop-app-owned", observedAt: null }, catalog: { state: "current", pulledAt: 1, homeChangedAt: 1 } })),
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
    if (call.path.startsWith("/api/link/status")) return response(status([row("l1", "box-one", childBlock({ activity: { idle: false, inFlight: 1, lastDataEndAt: null } }))]));
    if (call.path === "/api/link/children/operations") return response({ job: job({ op: "observe", state: "done", items: [] }) }, 202);
    return response({ error: { code: "not_found" } }, 404);
  });
  const host = await mount();
  await click(button(host, "Check"));
  await click(button(host, "Sync now"));
  const posts = calls.filter(call => call.method === "POST");
  expect(posts.map(call => call.body)).toEqual([{ op: "observe", linkIds: ["l1"] }, { op: "sync", linkIds: ["l1"] }]);
});

test("Restart Codex picks a scope and states the app-server caveat", async () => {
  const calls = installFetch(call => {
    if (call.path.startsWith("/api/link/status")) return response(status([row("l1", "box-one", childBlock())]));
    if (call.path === "/api/link/children/operations") return response({ job: job({ op: "restart-codex", state: "done", items: [] }) }, 202);
    return response({ error: { code: "not_found" } }, 404);
  });
  const host = await mount();
  await click(button(host, "Restart Codex"));
  const dialog = host.querySelector(".remote-link-confirm-dialog")!;
  expect(dialog.querySelectorAll("input[type=radio]")[0]?.hasAttribute("checked")).toBe(true as unknown as boolean);
  expect(dialog.textContent).toContain("The Codex desktop app's own app-server is not refreshed");
  await click([...dialog.querySelectorAll("button")].find(item => item.textContent === "Restart")!);
  expect(calls.filter(call => call.method === "POST").at(-1)?.body).toEqual({ op: "restart-codex", linkIds: ["l1"], restart: "app-server" });

  await click(button(host, "Restart Codex"));
  const reopened = host.querySelector(".remote-link-confirm-dialog")!;
  await click(reopened.querySelectorAll<HTMLInputElement>("input[type=radio]")[1]!);
  expect(reopened.textContent).toContain("Quits and relaunches the Codex desktop app on box-one");
  await click([...reopened.querySelectorAll("button")].find(item => item.textContent === "Restart")!);
  expect(calls.filter(call => call.method === "POST").at(-1)?.body).toEqual({ op: "restart-codex", linkIds: ["l1"], restart: "codex" });
});

test("Update and Update all confirm the disruption and post their bodies", async () => {
  const calls = installFetch(call => {
    if (call.path.startsWith("/api/link/status")) return response(status([
      row("l1", "box-one", childBlock()),
      row("l2", "box-two", childBlock({ versionSkew: "same", update: { route: "orchestrated", reason: null, observedAt: null } })),
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
  expect(calls.filter(call => call.method === "POST").at(-1)?.body).toEqual({ op: "update", linkIds: "all" });

  const firstRow = host.querySelectorAll(".remote-link-row")[0]!;
  await click([...firstRow.querySelectorAll("button")].find(item => item.textContent === "Update")!);
  const rowDialog = firstRow.querySelector("dialog")!;
  expect(rowDialog.textContent).toContain("Update box-one to 2.35.0?");
  expect(rowDialog.textContent).toContain("ends any turn currently relayed for it");
  await click([...rowDialog.querySelectorAll("button")].find(item => item.textContent === "Update")!);
  expect(calls.filter(call => call.method === "POST").at(-1)?.body).toEqual({ op: "update", linkIds: ["l1"] });
});

test("a running job shows per-item progress and refreshes status once when done", async () => {
  let jobPolls = 0;
  const calls = installFetch(call => {
    if (call.path.startsWith("/api/link/status")) return response(status([row("l1", "box-one", childBlock())]));
    if (call.path === "/api/link/children/operations") return response({ job: job() }, 202);
    if (call.path === "/api/link/children/jobs/ljob_0123456789abcdef") {
      jobPolls += 1;
      return response({ job: job({ state: "done", items: [{ linkId: "l1", alias: "box-one", state: "succeeded", reason: null, fromVersion: "2.34.0", toVersion: "2.35.0", sync: { state: "synced", reason: null }, restart: { requested: "app-server", outcome: "requested" }, startedAt: null, finishedAt: null }] }) });
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
  await settleUntil(() => host.querySelector(".remote-link-job")?.textContent?.includes("Succeeded") ?? false);
  const finished = host.querySelector(".remote-link-job")!;
  expect(finished.textContent).toContain("Succeeded");
  expect(finished.textContent).toContain("Synced");
  expect(finished.textContent).toContain("Restart requested");
  await settleUntil(() => calls.filter(call => call.path.includes("/api/link/status")).length > statusReads);
  expect(calls.filter(call => call.path.includes("/api/link/status")).length).toBe(statusReads + 1);
  expect(jobPolls).toBeGreaterThan(0);
});

test("a job_not_found answer stops polling and marks running items uncertain", async () => {
  const calls = installFetch(call => {
    if (call.path.startsWith("/api/link/status")) return response(status([row("l1", "box-one", childBlock())]));
    if (call.path === "/api/link/children/operations") return response({ job: job() }, 202);
    if (call.path.startsWith("/api/link/children/jobs/")) return response({ error: { code: "job_not_found" } }, 404);
    return response({ error: { code: "not_found" } }, 404);
  });
  const host = await mount();
  await click([...host.querySelectorAll(".remote-link-row button")].find(item => item.textContent === "Update")!);
  await click([...host.querySelectorAll(".remote-link-row dialog button")].find(item => item.textContent === "Update")!);
  await pollJobs();
  await settleUntil(() => (host.querySelector(".remote-link-job")?.textContent ?? "").includes("Outcome unknown"));
  const panel = host.querySelector(".remote-link-job")!;
  expect(panel.textContent).toContain("Outcome unknown");
  expect(panel.textContent).toContain("This Home restarted, so the job's progress is gone.");
  const polls = calls.filter(call => call.path.startsWith("/api/link/children/jobs/")).length;
  await pollJobs();
  expect(calls.filter(call => call.path.startsWith("/api/link/children/jobs/")).length).toBe(polls);
});

test("a 409 link_operation_in_progress is shown translated", async () => {
  installFetch(call => {
    if (call.path.startsWith("/api/link/status")) return response(status([row("l1", "box-one", childBlock())]));
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
      row("l1", "box-one", childBlock({ activeJob: { jobId: "ljob_0123456789abcdef", op: "sync", state: "running" } })),
      row("l2", "box-two", childBlock({ activeJob: { jobId: "ljob_fedcba9876543210", op: "update", state: "running" } })),
    ]));
    if (call.path === "/api/link/children/jobs/ljob_0123456789abcdef") return response({ job: job({ jobId: "ljob_0123456789abcdef", op: "sync" }) });
    if (call.path === "/api/link/children/jobs/ljob_fedcba9876543210") return response({ job: job({ jobId: "ljob_fedcba9876543210", op: "update", state: "done", items: [] }) });
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

test("a client-initiated row shows badges but no actions", async () => {
  installFetch(() => response(status([row("l1", "box-one", childBlock(), "client-initiated")])));
  const host = await mount();
  expect(host.querySelector(".remote-link-child-badges")).not.toBeNull();
  expect(host.querySelector(".remote-link-child-actions")).toBeNull();
  expect(button(host, "Disconnect").disabled).toBe(false);
});

test("manual restart and update wait for in-flight activity only", async () => {
  installFetch(call => call.path.startsWith("/api/link/status")
    ? response(status([row("l1", "box-one", childBlock({ activity: { idle: false, inFlight: 2, lastDataEndAt: 7 } }))]))
    : response({ error: { code: "not_found" } }, 404));
  const host = await mount();
  expect(button(host, "Check").disabled).toBe(false);
  expect(button(host, "Sync now").disabled).toBe(false);
  expect(button(host, "Restart Codex").disabled).toBe(true);
  expect(button(host, "Update").disabled).toBe(true);
});

test("the policy panel loads once, keeps edits across a status poll, and saves only changed keys", async () => {
  const calls = installFetch(call => {
    if (call.path.startsWith("/api/link/status")) return response(status([row("l1", "box-one", childBlock())]));
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
    if (call.path.startsWith("/api/link/status")) return response(status([row("l1", "box-one", childBlock())]));
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

test("a withheld restart says a request was in flight", async () => {
  installFetch(call => {
    if (call.path.startsWith("/api/link/status")) return response(status([row("l1", "box-one", childBlock())]));
    if (call.path === "/api/link/children/operations") return response({ job: job({ state: "done", items: [{ linkId: "l1", alias: "box-one", state: "succeeded", reason: null, fromVersion: null, toVersion: null, restart: { requested: "app-server", outcome: "skipped" }, startedAt: null, finishedAt: null }] }) }, 202);
    return response({ error: { code: "not_found" } }, 404);
  });
  const host = await mount();
  await click(button(host, "Restart Codex"));
  await click([...host.querySelectorAll(".remote-link-confirm-dialog button")].find(item => item.textContent === "Restart")!);
  const panel = host.querySelector(".remote-link-job")!;
  expect(panel.textContent).toContain("Restart withheld: a request was in flight on this Child.");
  expect(panel.textContent).not.toContain("Restart requested");
});

test("an unknown restart outcome and an unknown last-operation state render as code", async () => {
  installFetch(call => {
    if (call.path.startsWith("/api/link/status")) return response(status([row("l1", "box-one", childBlock({
      lastOperation: { op: "update", jobId: "ljob_0123456789abcdef", state: "melted", reason: null, fromVersion: null, toVersion: null, finishedAt: null },
    }))]));
    if (call.path === "/api/link/children/operations") return response({ job: job({ state: "done", items: [{ linkId: "l1", alias: "box-one", state: "succeeded", reason: null, fromVersion: null, toVersion: null, restart: { requested: "app-server", outcome: "done" }, startedAt: null, finishedAt: null }] }) }, 202);
    return response({ error: { code: "not_found" } }, 404);
  });
  const host = await mount();
  const badges = host.querySelector(".remote-link-child-badges")!;
  expect(badges.querySelector("code")?.textContent).toBe("melted");
  await click(button(host, "Restart Codex"));
  await click([...host.querySelectorAll(".remote-link-confirm-dialog button")].find(item => item.textContent === "Restart")!);
  const panel = host.querySelector(".remote-link-job")!;
  expect(panel.querySelector("code")?.textContent).toBe("done");
  expect(panel.textContent).not.toContain("Restart requested");
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
