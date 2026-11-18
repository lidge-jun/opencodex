import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { LanguageProvider } from "../src/i18n/provider";
import CodexCliUpdate from "../src/pages/codex-cli-update";

const names = ["document", "window", "navigator", "localStorage", "HTMLElement", "fetch", "IS_REACT_ACT_ENVIRONMENT"] as const;
let saved: Record<string, PropertyDescriptor | undefined>;
let win: Window;
let root: Root | undefined;
let requests: Array<{ url: string; method: string; body: unknown }>;

const PLAN_ID = "0123456789abcdef0123456789abcdef";
const plan = (over: Record<string, unknown> = {}) => ({
  schemaVersion: 1, package: "@openai/codex", channel: "latest", applicable: true, refusal: null, planId: PLAN_ID,
  provenance: "npm-global", managed: true, installedVersion: "0.160.0", versionEvidence: "package-json",
  location: "~/.npm-global/lib/node_modules/@openai/codex", targetVersion: "0.163.0", targetIntegrity: "sha512-x",
  session: { state: "none", matches: 0 }, installContentDigest: "d", command: ["npm", "install", "-g", "@openai/codex@0.163.0"], ...over,
});
const JOB_ID = "11111111-2222-3333-4444-555555555555";
const job = (over: Record<string, unknown> = {}) => ({
  jobId: JOB_ID, status: "queued", ownerState: "active", lifetimeUncertain: false, childState: "not_started",
  leaseState: "unknown", createdAt: "", updatedAt: "", planId: PLAN_ID, outcome: null, reason: null, cleanupErrors: [], ...over,
});

beforeEach(() => {
  saved = Object.fromEntries(names.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  win = new Window({ url: "http://127.0.0.1:10100/#codex-set/cli" });
  win.localStorage.setItem("ocx-lang", "en");
  Object.defineProperty(win.navigator, "language", { configurable: true, value: "en-US" });
  for (const name of names.filter(value => value !== "fetch")) {
    Object.defineProperty(globalThis, name, { configurable: true, value: name === "IS_REACT_ACT_ENVIRONMENT" ? true : Reflect.get(win, name) });
  }
  requests = [];
});
afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  root = undefined;
  win.close();
  for (const name of names) {
    if (saved[name]) Object.defineProperty(globalThis, name, saved[name]!);
    else Reflect.deleteProperty(globalThis, name);
  }
});

type Route = (url: string, init?: RequestInit) => Response | Promise<Response>;
function serve(route: Route) {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    requests.push({ url, method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : undefined });
    return route(url, init);
  }) as typeof fetch;
}

async function mount(props: { connected?: boolean } = {}): Promise<HTMLElement> {
  const host = document.createElement("div");
  document.body.append(host);
  const { createRoot } = await import("react-dom/client");
  await act(async () => {
    root = createRoot(host);
    root.render(<LanguageProvider><CodexCliUpdate apiBase="http://127.0.0.1:10100" {...props} /></LanguageProvider>);
  });
  return host;
}
const settle = (ms = 0) => act(async () => { await new Promise(resolve => setTimeout(resolve, ms)); });
const button = (host: HTMLElement, label: string) => [...host.querySelectorAll<HTMLButtonElement>("button")].find(b => b.textContent?.includes(label));
const checkbox = (host: HTMLElement) => host.querySelector<HTMLInputElement>('input[type="checkbox"]');
async function click(element: HTMLElement | null | undefined) { await act(async () => { element!.click(); }); await settle(); }

test("nothing is read until Check, and a refused plan never offers Apply", async () => {
  serve(() => Response.json(plan({ applicable: false, refusal: "not_managed", planId: null, provenance: "version-manager", managed: false })));
  const host = await mount();
  expect(requests).toHaveLength(0);
  await click(button(host, "Check for update"));
  expect(requests.map(r => r.url)).toEqual(["http://127.0.0.1:10100/api/codex/cli-update/plan"]);
  expect(host.textContent).toContain("OpenCodex does not manage this installation");
  expect(host.textContent).toContain("A version manager");
  expect(button(host, "Update Codex CLI")).toBeUndefined();
});

test("Apply stays disabled until the operator confirms, then posts the shown plan and polls to the result", async () => {
  let reads = 0;
  serve((url) => {
    if (url.endsWith("/plan")) return Response.json(plan());
    if (url.endsWith("/apply")) return Response.json({ job: job() }, { status: 202 });
    reads += 1;
    return Response.json(reads < 2 ? job({ status: "running", childState: "active_or_not_observed" })
      : job({ status: "applied", ownerState: "finished", outcome: "applied", reason: "verified_target" }));
  });
  const host = await mount();
  await click(button(host, "Check for update"));
  expect(host.textContent).toContain("0.163.0");
  const apply = button(host, "Update Codex CLI")!;
  expect(apply.disabled).toBe(true);
  await click(checkbox(host));
  expect(apply.disabled).toBe(false);
  await click(apply);
  const post = requests.find(r => r.method === "POST")!;
  expect(post.body).toMatchObject({ planId: PLAN_ID, confirmed: true });
  expect(typeof (post.body as { requestId: unknown }).requestId).toBe("string");
  await settle(1700);
  await settle(1700);
  expect(requests.filter(r => r.url.endsWith(`/jobs/${JOB_ID}`)).length).toBe(2);
  expect(host.textContent).toContain("Updated. The installed version was read back and matches.");
  expect(host.textContent).toContain("verified_target");
});

test("a new Check withdraws the confirmation and the old plan", async () => {
  serve(() => Response.json(plan()));
  const host = await mount();
  await click(button(host, "Check for update"));
  await click(checkbox(host));
  expect(checkbox(host)!.checked).toBe(true);
  await click(button(host, "Check for update"));
  expect(checkbox(host)!.checked).toBe(false);
  expect(button(host, "Update Codex CLI")!.disabled).toBe(true);
});

test("a dashboard without a paired local session is told how to pair or use the CLI", async () => {
  serve((url) => url.endsWith("/plan") ? Response.json(plan())
    : Response.json({ error: "local_dashboard_confirmation_required" }, { status: 403 }));
  const host = await mount();
  await click(button(host, "Check for update"));
  await click(checkbox(host));
  await click(button(host, "Update Codex CLI"));
  expect(host.textContent).toContain("Applying needs a paired browser on this computer");
  expect(host.textContent).toContain(`ocx system codex-cli-update apply --plan-id ${PLAN_ID} --yes`);
  expect(requests.filter(r => r.method === "POST")).toHaveLength(1);
});

test("a conflicting request is final: no resend, a new Check is needed", async () => {
  serve((url) => url.endsWith("/plan") ? Response.json(plan()) : Response.json({ error: "idempotency_conflict" }, { status: 409 }));
  const host = await mount();
  await click(button(host, "Check for update"));
  await click(checkbox(host));
  await click(button(host, "Update Codex CLI"));
  expect(host.textContent).toContain("Check again before updating");
  expect(button(host, "Update Codex CLI")!.disabled).toBe(true);
});

test("a busy job store may be retried with the same request id", async () => {
  let posts = 0;
  serve((url) => {
    if (url.endsWith("/plan")) return Response.json(plan());
    posts += 1;
    return posts === 1 ? Response.json({ error: "job_store_busy" }, { status: 503, headers: { "Retry-After": "1" } })
      : Response.json({ job: job({ status: "refused", ownerState: "finished", outcome: "refused", reason: "plan_changed" }) }, { status: 202 });
  });
  const host = await mount();
  await click(button(host, "Check for update"));
  await click(checkbox(host));
  await click(button(host, "Update Codex CLI"));
  expect(host.textContent).toContain("Try again");
  await click(button(host, "Try again"));
  const ids = requests.filter(r => r.method === "POST").map(r => (r.body as { requestId: string }).requestId);
  expect(ids).toHaveLength(2);
  expect(ids[0]).toBe(ids[1]!);
  // A terminal 202 is shown without polling.
  expect(host.textContent).toContain("Refused before anything was installed.");
  expect(requests.some(r => r.url.includes("/jobs/"))).toBe(false);
});

test("a vanished job record stops polling and says the result is unknown", async () => {
  serve((url) => {
    if (url.endsWith("/plan")) return Response.json(plan());
    if (url.endsWith("/apply")) return Response.json({ job: job() }, { status: 202 });
    return Response.json({ error: "job_not_found" }, { status: 404 });
  });
  const host = await mount();
  await click(button(host, "Check for update"));
  await click(checkbox(host));
  await click(button(host, "Update Codex CLI"));
  await settle(1700);
  await settle(1700);
  expect(requests.filter(r => r.url.includes("/jobs/"))).toHaveLength(1);
  expect(host.textContent).toContain("The job record is gone");
  // A stopped poll must not strand the tab: Check is available again.
  expect(button(host, "Check for update")!.disabled).toBe(false);
});

test("a refusal the tab has no words for says the update could not start and shows the code", async () => {
  serve((url) => url.endsWith("/plan") ? Response.json(plan()) : Response.json({ error: "invalid_request" }, { status: 400 }));
  const host = await mount();
  await click(button(host, "Check for update"));
  await click(checkbox(host));
  await click(button(host, "Update Codex CLI"));
  expect(host.textContent).toContain("The update could not start.");
  expect(host.textContent).toContain("invalid_request");
  expect(host.textContent).not.toContain("no longer matches");
});

test("a connected dashboard shows where to run the update and reads nothing", async () => {
  serve(() => Response.json(plan()));
  const host = await mount({ connected: true });
  expect(host.textContent).toContain("Open the dashboard on that computer");
  expect(button(host, "Check for update")).toBeUndefined();
  expect(requests).toHaveLength(0);
});
