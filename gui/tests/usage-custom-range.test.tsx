import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { resolve } from "node:path";
import { act } from "react";
import type { Root } from "react-dom/client";
import { LanguageProvider } from "../src/i18n/provider";
import { clearClientResourceStoresForTests } from "../src/client-resource";
import Usage from "../src/pages/Usage";

const globals = ["document", "window", "navigator", "localStorage", "sessionStorage", "ResizeObserver", "IS_REACT_ACT_ENVIRONMENT"] as const;
const originalFetch = globalThis.fetch;
let previousGlobals: Record<(typeof globals)[number], unknown>;
let testWindow: Window;
let root: Root | undefined;
let container: HTMLElement;
let apiBase: string;
let sequence = 0;
type RequestGate = { url: string; resolve: (response: Response) => void };
let requests: RequestGate[];

beforeEach(() => {
  previousGlobals = Object.fromEntries(globals.map(key => [key, Reflect.get(globalThis, key)])) as typeof previousGlobals;
  clearClientResourceStoresForTests();
  testWindow = new Window({ url: "http://localhost/" });
  testWindow.localStorage.setItem("ocx-lang", "en");
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: testWindow.document },
    window: { configurable: true, value: testWindow },
    navigator: { configurable: true, value: testWindow.navigator },
    localStorage: { configurable: true, value: testWindow.localStorage },
    sessionStorage: { configurable: true, value: testWindow.sessionStorage },
    ResizeObserver: { configurable: true, value: testWindow.ResizeObserver },
    IS_REACT_ACT_ENVIRONMENT: { configurable: true, value: true },
  });
  // The page also has a held memory cache: each test gets a distinct report identity.
  apiBase = `http://usage-custom-${++sequence}`;
  requests = [];
  globalThis.fetch = ((input: RequestInfo | URL) => new Promise<Response>(resolve => {
    requests.push({ url: String(input), resolve });
  })) as typeof fetch;
});

afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  root = undefined;
  globalThis.fetch = originalFetch;
  clearClientResourceStoresForTests();
  testWindow.close();
  for (const key of globals) Object.defineProperty(globalThis, key, { configurable: true, value: previousGlobals[key] });
});

async function mount(connected = false) {
  const previousRequests = requests.length;
  container = document.createElement("div");
  document.body.append(container);
  const { createRoot } = await import("react-dom/client");
  await act(async () => {
    root = createRoot(container);
    root.render(<LanguageProvider><Usage apiBase={apiBase} connected={connected} apiKeyId={connected ? "machine/key + one" : undefined} /></LanguageProvider>);
  });
  expect(requests).toHaveLength(previousRequests + 1);
}

function report(gate: RequestGate, marker: string, date = "2020-09-15") {
  const query = new URL(gate.url).searchParams;
  const custom = query.has("since");
  return {
    range: query.get("range"), surface: query.get("surface"),
    since: custom ? Number(query.get("since")) : null,
    ...(custom ? { customWindow: true, until: Number(query.get("until")) } : {}),
    generatedAt: Date.now(),
    summary: {
      requests: 1, measuredRequests: 1, reportedRequests: 1, unreportedRequests: 0,
      unsupportedRequests: 0, estimatedRequests: 0, inputTokens: 10, outputTokens: 20,
      cachedInputTokens: 0, reasoningOutputTokens: 0, totalTokens: 30, coverageRatio: 1,
    },
    days: [{ date, requests: 1, measuredRequests: 1, reportedRequests: 1, totalTokens: 30, models: [] }],
    models: [{ model: marker, provider: "openai", requests: 1, measuredRequests: 1, reportedRequests: 1,
      estimatedRequests: 0, totalTokens: 30, inputTokens: 10, outputTokens: 20, shareRatio: 1 }],
    providers: [], historyTruncated: false, truncatedPrefixBytes: 0, entriesTruncated: false, entriesDropped: 0,
  };
}

async function respond(index: number, marker: string, date?: string) {
  await act(async () => { requests[index].resolve(Response.json(report(requests[index], marker, date))); });
}

const form = () => container.querySelector<HTMLFormElement>('form[aria-label="Custom date range"]')!;
const startInput = () => form().querySelectorAll<HTMLInputElement>('input[type="datetime-local"]')[0];
const endInput = () => form().querySelectorAll<HTMLInputElement>('input[type="datetime-local"]')[1];
const interval = () => form().querySelector('[role="status"]')?.textContent;
const error = () => form().querySelector('[role="alert"]')?.textContent;
const preset = (name: string) => container.querySelector<HTMLButtonElement>(`button.usage-segmented-btn[aria-label="${name}"]`)!;

async function click(button: HTMLButtonElement) {
  expect(button).toBeTruthy();
  await act(async () => { button.click(); });
}

async function enter(start: string, end: string) {
  await act(async () => {
    for (const [input, value] of [[startInput(), start], [endInput(), end]] as const) {
      Object.getOwnPropertyDescriptor(testWindow.HTMLInputElement.prototype, "value")!.set!.call(input, value);
      input.dispatchEvent(new testWindow.Event("input", { bubbles: true }));
      input.dispatchEvent(new testWindow.Event("change", { bubbles: true }));
    }
  });
}

const apply = () => click(form().querySelector<HTMLButtonElement>('button[type="submit"]')!);
const clear = () => click(form().querySelector<HTMLButtonElement>('button[type="button"]')!);
const since = new Date(2020, 8, 15, 10, 20, 0, 0).getTime();
const until = new Date(2020, 8, 15, 10, 21, 59, 999).getTime();
const boundsQuery = `since=${since}&until=${until}`;

function sessionEntries() {
  return Array.from({ length: sessionStorage.length }, (_, index) => {
    const key = sessionStorage.key(index)!;
    return [key, sessionStorage.getItem(key)];
  });
}

for (const connected of [false, true]) {
  test.each([
    ["older daemon", { customWindow: undefined, until: undefined }],
    ["missing mode", { customWindow: undefined }],
    ["preset mode", { customWindow: false }],
    ["nonboolean mode", { customWindow: "true" }],
    ["missing since", { since: undefined }],
    ["missing until", { until: undefined }],
    ["wrong since", { since: since + 1 }],
    ["wrong until", { until: until + 1 }],
    ["string bounds", { since: String(since), until: String(until) }],
  ])(`rejects custom %s receipts without displaying totals (connected=${connected})`, async (_name, receipt) => {
    await mount(connected);
    await respond(0, "held-preset-marker");
    const held = sessionEntries();
    await enter("2020-09-15T10:20", "2020-09-15T10:21");
    await apply();
    await act(async () => {
      requests[1].resolve(Response.json({ ...report(requests[1], "mismatched-report-marker"), ...receipt }));
    });
    expect(container.textContent).toContain("Could not load usage data.");
    expect(container.textContent).toContain("The proxy returned an unexpected response.");
    expect(container.textContent).not.toContain("mismatched-report-marker");
    expect(container.textContent).not.toContain("held-preset-marker");
    expect(container.querySelector(".stat-value")).toBeNull();
    expect(sessionEntries()).toEqual(held);
    const retry = [...container.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "Retry")!;
    await click(retry);
    await respond(2, "exact-retry-marker");
    expect(container.textContent).toContain("exact-retry-marker");
    expect(container.textContent).not.toContain("Could not load usage data.");
  });
}

test("America/Santiago midnight DST retains final-day activity and tooltip", async () => {
  if (process.env.OCX_USAGE_SANTIAGO_CHILD !== "1") {
    // Restoring an absent TZ can change Bun's effective timezone on Windows.
    // Start the DST case in its timezone without mutating this suite's clock.
    const timezone = { present: Object.hasOwn(process.env, "TZ"), value: process.env.TZ };
    const localTime = new Date(2020, 8, 15, 10, 20).getTime();
    const child = Bun.spawnSync([
      process.execPath, "test", import.meta.path,
      "-t", "^America/Santiago midnight DST retains final-day activity and tooltip$",
      "--timeout", "10000",
    ], {
      cwd: resolve(import.meta.dir, ".."),
      env: { ...process.env, TZ: "America/Santiago", OCX_USAGE_SANTIAGO_CHILD: "1" },
      stdout: "pipe", stderr: "pipe", timeout: 12000, killSignal: "SIGKILL",
    });
    const diagnostics = `${child.stdout.toString()}\n${child.stderr.toString()}`;
    expect(child.exitedDueToTimeout, diagnostics).not.toBe(true);
    expect(child.signalCode, diagnostics).toBeUndefined();
    expect(child.exitCode, diagnostics).toBe(0);
    expect(child.stdout.toString().split(/\r?\n/), diagnostics).toContain("OCX_SANTIAGO_CASE_COMPLETED");
    expect({ present: Object.hasOwn(process.env, "TZ"), value: process.env.TZ }).toEqual(timezone);
    expect(new Date(2020, 8, 15, 10, 20).getTime()).toBe(localTime);
    return;
  }
  expect(process.env.TZ).toBe("America/Santiago");
  expect(new Date(2026, 8, 6, 0).getHours()).toBe(1);
  await mount();
  await respond(0, "preset-marker");
  await enter("2026-09-05T00:00", "2026-09-07T23:59");
  await apply();
  const gate = requests.at(-1)!;
  const data = report(gate, "santiago-marker", "2026-09-07");
  data.days = ["2026-09-05", "2026-09-06", "2026-09-07"].map(date => ({
    date, requests: date === "2026-09-07" ? 7 : 0, measuredRequests: 0, reportedRequests: 0,
    totalTokens: date === "2026-09-07" ? 700 : 0, models: [],
  }));
  await act(async () => gate.resolve(Response.json(data)));
  const active = container.querySelector<HTMLElement>('.heatmap-grid .heatmap-cell:not(.heatmap-cell-0)');
  expect(active).not.toBeNull();
  await act(async () => active!.dispatchEvent(new testWindow.MouseEvent("mouseover", { bubbles: true })));
  expect(container.querySelector(".heatmap-tip-date")?.textContent).toBe("2026-09-07");
  expect(container.querySelector(".heatmap-tip")?.textContent).toContain("700");
  if (process.env.OCX_USAGE_SANTIAGO_CHILD === "1") console.log("OCX_SANTIAGO_CASE_COMPLETED");
}, process.env.OCX_USAGE_SANTIAGO_CHILD === "1" ? 10000 : 15000);

test("Apply submits inclusive bounds once; Clear restores the held preset without custom cache entries", async () => {
  await mount();
  expect(requests[0].url).toBe(`${apiBase}/api/usage?range=30d&surface=all`);
  await respond(0, "preset-report-marker");
  const held = sessionEntries();
  expect(held).toHaveLength(1);
  await enter("2020-09-15T10:20", "2020-09-15T10:21");
  expect(requests).toHaveLength(1);
  expect(container.textContent).toContain("preset-report-marker");
  await apply();
  expect(requests).toHaveLength(2);
  expect(requests[1].url).toBe(`${apiBase}/api/usage?range=30d&surface=all&${boundsQuery}`);
  for (const name of ["Available history", "30d", "7d"]) expect(preset(name).getAttribute("aria-pressed")).toBe("false");
  expect(container.textContent).not.toContain("preset-report-marker");
  expect(container.textContent).toContain("Loading usage data");
  expect(interval()).toContain("both inclusive");
  expect(interval()).toContain(".999");
  const appliedInterval = interval();
  await respond(1, "custom-report-marker");
  expect(container.textContent).toContain("custom-report-marker");
  expect(sessionEntries()).toEqual(held);
  // Resource eviction is scheduled on a zero-delay timer. Drain that turn before Clear
  // so this explicitly covers restoring a held preset after its resource store was evicted.
  await act(async () => { await new Promise<void>(resolve => setTimeout(resolve, 0)); });
  // A one-day historical window must not produce a year grid anchored to today's date.
  expect(container.querySelectorAll(".heatmap-grid .heatmap-cell")).toHaveLength(7);
  const activeCell = container.querySelector(".heatmap-grid .heatmap-cell-1")!;
  await act(async () => { activeCell.dispatchEvent(new testWindow.MouseEvent("mouseover", { bubbles: true })); });
  expect(container.querySelector('[role="tooltip"]')?.textContent).toContain("2020-09-15");
  await enter("2020-09-16T10:20", "2020-09-16T10:21");
  expect(interval()).toBe(appliedInterval);
  expect(requests).toHaveLength(2);
  await clear();
  expect(startInput().value).toBe("");
  expect(endInput().value).toBe("");
  expect(interval()).toBeUndefined();
  expect(preset("30d").getAttribute("aria-pressed")).toBe("true");
  expect(container.textContent).toContain("preset-report-marker");
  expect(container.textContent).not.toContain("custom-report-marker");
  expect(requests.at(-1)!.url).toBe(`${apiBase}/api/usage?range=30d&surface=all`);
  await act(async () => { root!.unmount(); });
  root = undefined;
  container.remove();
  clearClientResourceStoresForTests();
  await mount();
  expect(container.textContent).toContain("preset-report-marker");
  await enter("2020-09-15T10:20", "2020-09-15T10:21");
  await apply();
  // Reopening that exact custom window must not resurrect a module/session-held report.
  expect(container.textContent).not.toContain("custom-report-marker");
  expect(container.textContent).not.toContain("preset-report-marker");
  expect(container.textContent).toContain("Loading usage data");
  expect(requests.at(-1)!.url).toBe(`${apiBase}/api/usage?range=30d&surface=all&${boundsQuery}`);
});

test("missing, partial, invalid and reversed drafts make no request or applied-state change", async () => {
  await mount();
  await respond(0, "held-valid-report");
  for (const [start, end, expected] of [
    ["", "", "Enter both"],
    ["2020-09-15T10:20", "", "Enter both"],
    ["", "2020-09-15T10:20", "Enter both"],
    ["1969-01-01T12:00", "2020-09-15T10:20", "Enter valid"],
    ["2020-09-16T10:20", "2020-09-15T10:20", "The end must"],
  ]) {
    await enter(start, end);
    await apply();
    expect(error()).toContain(expected);
    expect(startInput().getAttribute("aria-invalid")).toBe("true");
    expect(requests).toHaveLength(1);
    expect(container.textContent).toContain("held-valid-report");
    expect(interval()).toBeUndefined();
  }
  await enter("2020-09-15T10:20", "2020-09-15T10:21");
  await apply();
  await respond(1, "applied-valid-report");
  const previousInterval = interval();
  await enter("2020-09-16T10:20", "2020-09-15T10:20");
  await apply();
  expect(requests).toHaveLength(2);
  expect(interval()).toBe(previousInterval);
  expect(container.textContent).toContain("applied-valid-report");
  await clear();
  expect(error()).toBeUndefined();
});

test("new bounds never show a held report or a superseded request that settles late", async () => {
  await mount();
  await respond(0, "preset-stale-marker");
  await enter("2020-09-15T10:20", "2020-09-15T10:21");
  await apply();
  await respond(1, "first-custom-marker");
  // Change only until, then only since: each bound independently owns a new request.
  await enter("2020-09-15T10:20", "2020-09-15T10:22");
  await apply();
  expect(requests[2].url).toBe(`${apiBase}/api/usage?range=30d&surface=all&since=${since}&until=${until + 60_000}`);
  expect(container.textContent).not.toContain("first-custom-marker");
  await enter("2020-09-15T10:21", "2020-09-15T10:22");
  await apply();
  expect(requests[3].url).toBe(`${apiBase}/api/usage?range=30d&surface=all&since=${since + 60_000}&until=${until + 60_000}`);
  await respond(2, "late-superseded-marker");
  expect(container.textContent).not.toContain("late-superseded-marker");
  expect(container.textContent).not.toContain("preset-stale-marker");
  expect(container.textContent).toContain("Loading usage data");
  await respond(3, "latest-custom-marker");
  expect(container.textContent).toContain("latest-custom-marker");
  expect(sessionEntries()).toHaveLength(1);
});

test("Apply preserves machine key, surface and hub scope; choosing a preset clears custom", async () => {
  await mount(true);
  await respond(0, "machine-report");
  await click(preset("Grok"));
  await respond(1, "machine-grok-report");
  await enter("2020-09-15T10:20", "2020-09-15T10:21");
  await apply();
  expect(requests[2].url).toBe(`${apiBase}/api/usage?range=30d&surface=grok&apiKeyId=machine%2Fkey+%2B+one&${boundsQuery}`);
  await respond(2, "machine-custom-report");
  const hub = [...container.querySelectorAll<HTMLButtonElement>(".usage-scope-control button")].find(button => button.textContent === "Hub-wide")!;
  await click(hub);
  expect(requests[3].url).toBe(`${apiBase}/api/usage?range=30d&surface=grok&${boundsQuery}`);
  await respond(3, "hub-custom-report");
  await enter("2020-09-15T10:20", "2020-09-15T10:22");
  await apply();
  expect(requests[4].url).toBe(`${apiBase}/api/usage?range=30d&surface=grok&since=${since}&until=${until + 60_000}`);
  await respond(4, "hub-new-custom-report");
  await click(preset("7d"));
  expect(requests.at(-1)!.url).toBe(`${apiBase}/api/usage?range=7d&surface=grok`);
  expect(interval()).toBeUndefined();
  expect(startInput().value).toBe("");
  expect(endInput().value).toBe("");
  expect(preset("7d").getAttribute("aria-pressed")).toBe("true");
  expect(hub.getAttribute("aria-pressed")).toBe("true");
});

test("each preset clears custom, including the retained preset; 7d never replaces custom days with this week", async () => {
  await mount();
  await respond(0, "preset-marker");
  for (const [index, name] of ["30d", "Available history", "7d"].entries()) {
    await enter("2020-09-15T10:20", `2020-09-15T10:${21 + index}`);
    const previousRequests = requests.length;
    await apply();
    expect(requests).toHaveLength(previousRequests + 1);
    await respond(requests.length - 1, "custom-marker");
    await click(preset(name));
    expect(preset(name).getAttribute("aria-pressed")).toBe("true");
    expect(interval()).toBeUndefined();
    expect(startInput().value).toBe("");
    expect(endInput().value).toBe("");
  }
  await enter("2020-09-15T10:20", "2020-09-15T10:21");
  await apply();
  expect(requests.at(-1)!.url).toBe(`${apiBase}/api/usage?range=7d&surface=all&${boundsQuery}`);
  await respond(requests.length - 1, "custom-from-7d-marker");
  expect(container.querySelector(".daybars")).toBeNull();
  expect(container.querySelectorAll(".heatmap-grid .heatmap-cell")).toHaveLength(7);
  expect(preset("7d").getAttribute("aria-pressed")).toBe("false");
});
