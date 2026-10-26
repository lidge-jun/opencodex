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
  answers = {
    good: () => Response.json(success),
    bad: () => Response.json({ ...success, ok: false, termination: "failed", ttftMs: null,
      error: { code: "http_status", status: 404, message: "model not found" } }),
    busy: () => Response.json({ error: "completion test already running for this provider" }, { status: 409 }),
  };
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push({ url: String(input), init: init! });
    if (String(input).includes("/api/model-visibility")) return Response.json({ ok: true });
    return answers[JSON.parse(String(init!.body)).model as string]!();
  }) as typeof fetch;
});
afterEach(async () => {
  await act(async () => { root?.unmount(); }); root = undefined;
  globalThis.fetch = originalFetch;
  win.close();
  for (const key of globals) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value: previous[key] });
});
async function render() {
  const { createRoot } = await import("react-dom/client"); root = createRoot(host);
  await act(async () => {
    root!.render(<LanguageProvider><ProviderOverview item={item} apiBase="http://localhost"
      connectionIdentity="credential" availableModels={["good"]} /></LanguageProvider>);
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
  expect(actionDialogText(document)).toContain("3 models");
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
  await act(async () => { button("Disable 1 failed models")!.click(); });
  await act(async () => { dismissActionDialog(document); });
  expect(requests.filter(r => r.url.includes("model-visibility"))).toHaveLength(0);
  await act(async () => { button("Disable 1 failed models")!.click(); });
  await act(async () => { acceptActionDialog(document); });
  const put = requests.find(r => r.url === "http://localhost/api/model-visibility")!;
  expect(put.init.method).toBe("PUT");
  expect(JSON.parse(String(put.init.body))).toEqual({ scope: "models", provider: "vendor", targets: [{ id: "bad" }], enabled: false });
  expect(host.textContent).toContain("Disabled 1 models");
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
  expect(host.textContent).toContain("Stopped after 1 of 3 models");
});
