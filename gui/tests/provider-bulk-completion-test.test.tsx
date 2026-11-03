import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import ProviderOverview from "../src/components/provider-workspace/ProviderOverview";
import type { CompletionTestResult } from "../src/components/provider-workspace/ProviderCompletionTest";
import { LanguageProvider } from "../src/i18n/provider";
import type { WorkspaceItem } from "../src/provider-workspace/catalog";
import { acceptActionDialog, actionDialogOpen, actionDialogText, dismissActionDialog } from "./helpers/action-dialog";

const globals = ["document", "window", "navigator", "localStorage", "HTMLElement", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previous: Record<string, unknown>;
let win: Window;
let root: Root | undefined;
let host: HTMLElement;
let requests: Array<{ url: string; init: RequestInit }>;
const originalFetch = globalThis.fetch;
const item: WorkspaceItem = { name: "vendor", adapter: "openai-chat", baseUrl: "https://example.test/v1",
  hasApiKey: true, models: ["good", "bad"], defaultModel: "busy" };
const success: Extract<CompletionTestResult, { applicable: true }> = {
  applicable: true, ok: true, provider: item.name, requestedModel: "good", wireModel: "good",
  wire: "openai-chat", upstreamModel: "good", modelComparison: "match", identityVerified: false,
  ttftMs: 12, totalLatencyMs: 45, outputTokenCap: 32, termination: "completed", error: null,
};
let answers: Record<string, () => Response | Promise<Response>>;
let visibilityAnswer: () => Response | Promise<Response>;

beforeEach(() => {
  previous = Object.fromEntries(globals.map(key => [key, Reflect.get(globalThis, key)]));
  win = new Window({ url: "http://localhost/#providers" });
  Object.defineProperty(win.navigator, "language", { configurable: true, value: "en-US" });
  for (const [key, value] of Object.entries({ window: win, document: win.document, navigator: win.navigator,
    localStorage: win.localStorage, HTMLElement: win.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true })) {
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  host = document.createElement("div"); document.body.append(host);
  requests = [];
  visibilityAnswer = () => Response.json({ ok: true });
  answers = {
    good: () => Response.json(success),
    bad: () => Response.json({ ...success, ok: false, termination: "failed", ttftMs: null,
      error: { code: "http_status", status: 404, message: "model not found" } }),
    busy: () => Response.json({ error: "completion test already running for this provider" }, { status: 409 }),
  };
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push({ url: String(input), init: init! });
    if (String(input).includes("/api/model-visibility")) return visibilityAnswer();
    return answers[JSON.parse(String(init!.body)).model as string]!();
  }) as typeof fetch;
});
afterEach(async () => {
  await act(async () => { root?.unmount(); }); root = undefined;
  globalThis.fetch = originalFetch;
  win.close();
  for (const key of globals) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value: previous[key] });
});
async function render(connectionIdentity = "credential") {
  const { createRoot } = await import("react-dom/client"); root ??= createRoot(host);
  await act(async () => {
    root!.render(<LanguageProvider><ProviderOverview item={item} apiBase="http://localhost"
      connectionIdentity={connectionIdentity} availableModels={["good"]} /></LanguageProvider>);
  });
}
function button(text: string | RegExp) {
  return Array.from(host.querySelectorAll<HTMLButtonElement>("button"))
    .find(b => typeof text === "string" ? b.textContent === text : text.test(b.textContent ?? ""));
}
async function runAll(accept = true) {
  await act(async () => { button("Test all models")!.click(); });
  expect(actionDialogOpen(document)).toBe(true);
  if (accept) await act(async () => { acceptActionDialog(document); });
}
const outcomes = () => Array.from(host.querySelectorAll("[data-model-test-outcome]"))
  .map(row => [row.querySelector("code")!.textContent, row.getAttribute("data-model-test-outcome")]);

test("one confirmation names the count and cost; canceling sends nothing", async () => {
  await render(); await runAll(false);
  expect(actionDialogText(document)).toContain("(3 total)");
  expect(actionDialogText(document)).toContain("real completion requests one at a time (up to 3)");
  expect(actionDialogText(document)).toContain("skipped before sending");
  expect(actionDialogText(document)).toContain("quota");
  expect(actionDialogText(document)).toContain("32");
  await act(async () => { dismissActionDialog(document); });
  expect(requests).toHaveLength(0);
  expect(button("Test all models")!.disabled).toBe(false);
});

test("tests every deduplicated model in order and classifies the outcomes", async () => {
  await render(); await runAll();
  expect(requests.map(r => JSON.parse(String(r.init.body)))).toEqual([
    { model: "good", confirm: true }, { model: "bad", confirm: true }, { model: "busy", confirm: true },
  ]);
  expect(outcomes()).toEqual([["good", "ok"], ["bad", "failed"], ["busy", "skipped"]]);
  expect(host.textContent).toContain("1 passed, 1 failed, 1 not tested");
  expect(host.textContent).toContain("http_status (404)");
});

test("disabling failed models needs a second consent and hides only upstream failures", async () => {
  await render(); await runAll();
  await act(async () => { button("Disable failed models (1)")!.click(); });
  expect(actionDialogText(document)).toContain("stay callable by exact id");
  await act(async () => { dismissActionDialog(document); });
  expect(requests.filter(r => r.url.includes("model-visibility"))).toHaveLength(0);
  await act(async () => { button("Disable failed models (1)")!.click(); });
  await act(async () => { acceptActionDialog(document); });
  const put = requests.find(r => r.url === "http://localhost/api/model-visibility")!;
  expect(put.init.method).toBe("PUT");
  expect(JSON.parse(String(put.init.body))).toEqual({ scope: "models", provider: "vendor", targets: [{ id: "bad" }], enabled: false });
  expect(host.textContent).toContain("Models disabled: 1");
  expect(button(/^Disable/)).toBeUndefined();
});

test("no disable action is offered when nothing failed upstream", async () => {
  answers.bad = answers.good!;
  await render(); await runAll();
  expect(button(/^Disable/)).toBeUndefined();
});

test("a provider-level inapplicable result stops the run after one request", async () => {
  answers.good = () => Response.json({ applicable: false, reason: "oauth_auth" });
  await render(); await runAll();
  expect(requests).toHaveLength(1);
  expect(host.textContent).toContain("OAuth authentication is not supported.");
  expect(outcomes()).toEqual([]);
});

test("stop aborts the in-flight request and sends no more", async () => {
  let release!: (response: Response) => void;
  answers.bad = () => new Promise<Response>(resolve => { release = resolve; });
  await render(); await runAll();
  expect(requests).toHaveLength(2);
  const signal = requests[1]!.init.signal!;
  await act(async () => { button("Stop")!.click(); });
  expect(signal.aborted).toBe(true);
  await act(async () => { release(Response.json(success)); });
  expect(requests).toHaveLength(2);
  expect(outcomes()).toEqual([["good", "ok"]]);
  expect(host.textContent).toContain("Stopped: 1 of 3 tested");
});

test("stopped run cleanup preserves the restarted run and its Stop control", async () => {
  const releases: Array<(response: Response) => void> = [];
  answers.bad = () => new Promise<Response>(resolve => { releases.push(resolve); });
  await render(); await runAll();
  expect(requests).toHaveLength(2);
  const firstSignal = requests[1]!.init.signal!;
  await act(async () => { button("Stop")!.click(); });
  expect(firstSignal.aborted).toBe(true);

  await runAll();
  expect(requests).toHaveLength(4);
  const restartedSignal = requests[3]!.init.signal!;
  expect(restartedSignal.aborted).toBe(false);
  expect(button("Stop")).toBeDefined();

  // Let the stopped request settle only after the next run is already in flight.
  await act(async () => { releases[0]!(Response.json(success)); });
  expect(requests).toHaveLength(4);
  expect(outcomes()).toEqual([["good", "ok"]]);
  expect(host.querySelector("[data-completion-bulk-state]")?.getAttribute("data-completion-bulk-state")).toBe("running");
  expect(button(/^Testing/)!.disabled).toBe(true);
  expect(button("Stop")).toBeDefined();
  expect(restartedSignal.aborted).toBe(false);

  await act(async () => { button("Stop")!.click(); });
  expect(restartedSignal.aborted).toBe(true);
  await act(async () => { releases[1]!(Response.json(success)); });
  expect(requests).toHaveLength(4);
  expect(outcomes()).toEqual([["good", "ok"]]);
  expect(button("Stop")).toBeUndefined();
  expect(button("Test all models")!.disabled).toBe(false);
  expect(host.textContent).toContain("Stopped: 1 of 3 tested");
});

test.each(["credential_missing", "credential_changed", "destination_refused"])(
  "%s is not evidence that a model failed", async code => {
    answers.good = () => Response.json({ ...success, ok: false, termination: "failed",
      error: { code, message: "provider admission refused" } });
    answers.bad = answers.good!;
    await render(); await runAll();
    expect(outcomes()).toEqual([["good", "skipped"], ["bad", "skipped"], ["busy", "skipped"]]);
    expect(host.textContent).toContain("0 passed, 0 failed, 3 not tested");
    expect(host.textContent).toContain(code);
    expect(button(/^Disable/)).toBeUndefined();
  },
);

test("an unsupported model wire does not stop later supported models", async () => {
  answers.good = () => Response.json({ applicable: false, reason: "unsupported_adapter", adapter: "anthropic" });
  answers.bad = () => Response.json(success);
  await render(); await runAll();
  expect(requests).toHaveLength(3);
  expect(outcomes()).toEqual([["good", "skipped"], ["bad", "ok"], ["busy", "skipped"]]);
  expect(host.textContent).toContain("1 passed, 0 failed, 2 not tested");
  expect(button(/^Disable/)).toBeUndefined();
});

test.each(["unmount", "credential change"])("%s withdraws stale disable consent", async change => {
  await render(); await runAll();
  await act(async () => { button("Disable failed models (1)")!.click(); });
  expect(actionDialogOpen(document)).toBe(true);
  const oldAccept = document.querySelector("dialog button[type=submit]") as HTMLButtonElement;
  if (change === "unmount") {
    await act(async () => { root!.unmount(); }); root = undefined;
  } else await render("replacement-credential");
  const stillOpen = actionDialogOpen(document);
  // Even a queued click on the retired dialog must not issue the mutation.
  await act(async () => { oldAccept.click(); });
  expect(requests.filter(request => request.url.includes("model-visibility"))).toHaveLength(0);
  expect(stillOpen).toBe(false);
});

test("a pending disable is serialized before a new model-test batch", async () => {
  let release!: (response: Response) => void;
  visibilityAnswer = () => new Promise<Response>(resolve => { release = resolve; });
  await render(); await runAll();
  await act(async () => { button("Disable failed models (1)")!.click(); });
  expect(button("Test all models")!.disabled).toBe(true);
  await act(async () => { acceptActionDialog(document); });
  expect(requests.filter(request => request.url.includes("model-visibility"))).toHaveLength(1);
  expect(button("Test all models")!.disabled).toBe(true);
  await act(async () => { button("Test all models")!.click(); });
  expect(actionDialogOpen(document)).toBe(false);
  expect(requests).toHaveLength(4);
  await act(async () => { release(Response.json({ ok: true })); });
  expect(button("Test all models")!.disabled).toBe(false);
  await runAll();
  expect(outcomes()).toEqual([["good", "ok"], ["bad", "failed"], ["busy", "skipped"]]);
  expect(button("Disable failed models (1)")!.disabled).toBe(false);
  expect(host.textContent).not.toContain("Models disabled: 1");
});

test("a credential change aborts a pending disable write and ignores its late result", async () => {
  let release!: (response: Response) => void;
  visibilityAnswer = () => new Promise<Response>(resolve => { release = resolve; });
  await render(); await runAll();
  await act(async () => { button("Disable failed models (1)")!.click(); });
  await act(async () => { acceptActionDialog(document); });
  const mutation = requests.find(request => request.url.includes("model-visibility"))!;
  expect(mutation.init.signal?.aborted).toBe(false);
  await render("replacement-credential");
  expect(mutation.init.signal?.aborted).toBe(true);
  await runAll();
  await act(async () => { release(Response.json({ ok: true })); });
  expect(button("Disable failed models (1)")!.disabled).toBe(false);
  expect(host.textContent).not.toContain("Models disabled: 1");
});

test.each([401, 403, 429])("upstream HTTP %s is not a disable target", async status => {
  answers.good = () => Response.json({ ...success, ok: false, termination: "failed",
    error: { code: "http_status", status, message: "provider refused the request" } });
  answers.bad = answers.good!;
  await render(); await runAll();
  expect(outcomes()).toEqual([["good", "skipped"], ["bad", "skipped"], ["busy", "skipped"]]);
  expect(host.textContent).toContain(`http_status (${status})`);
  expect(host.textContent).toContain("0 passed, 0 failed, 3 not tested");
  expect(button(/^Disable/)).toBeUndefined();
});

async function selectSingle(model: string) {
  await act(async () => { host.querySelector<HTMLButtonElement>('[role="combobox"][aria-label="Model to test"]')!.click(); });
  const option = Array.from(document.querySelectorAll<HTMLButtonElement>('[role="option"]')).find(o => o.textContent === model)!;
  await act(async () => { option.click(); });
}

test("the single and all-model probes share one in-flight guard, so neither can overlap the other", async () => {
  let releaseSingle!: (response: Response) => void;
  answers.good = () => new Promise<Response>(resolve => { releaseSingle = resolve; });
  await render(); await selectSingle("good");
  await act(async () => { button("Test model")!.click(); });
  expect(button("Test all models")!.disabled).toBe(true);
  await act(async () => { acceptActionDialog(document); });
  expect(requests).toHaveLength(1);
  expect(button("Test all models")!.disabled).toBe(true);
  await act(async () => { button("Test all models")!.click(); });
  expect(actionDialogOpen(document)).toBe(false);
  expect(requests).toHaveLength(1);
  await act(async () => { releaseSingle(Response.json(success)); });
  expect(button("Test all models")!.disabled).toBe(false);

  let releaseBulk!: (response: Response) => void;
  answers.good = () => new Promise<Response>(resolve => { releaseBulk = resolve; });
  await runAll();
  expect(requests).toHaveLength(2);
  expect(button("Test model")!.disabled).toBe(true);
  await act(async () => { button("Test model")!.click(); });
  expect(actionDialogOpen(document)).toBe(false);
  expect(requests).toHaveLength(2);
  await act(async () => { button("Stop")!.click(); });
  await act(async () => { releaseBulk(Response.json(success)); });
  expect(button("Test model")!.disabled).toBe(false);
  expect(host.querySelector("[role=alert]")).toBeNull();
});
