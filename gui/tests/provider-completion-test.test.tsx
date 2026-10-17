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
const item: WorkspaceItem = { name: "test vendor", adapter: "openai-chat", baseUrl: "https://example.test/v1",
  hasApiKey: true, models: ["configured"], defaultModel: "default" };
const success: Extract<CompletionTestResult, { applicable: true }> = {
  applicable: true, ok: true, provider: item.name, requestedModel: "configured", wireModel: "wire-model",
  wire: "openai-chat", upstreamModel: "wire-model", modelComparison: "match", identityVerified: false,
  ttftMs: 12, totalLatencyMs: 45, outputTokenCap: 32, termination: "completed", error: null,
};
let respond: () => Promise<Response>;

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
  respond = async () => Response.json(success);
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push({ url: String(input), init: init! });
    return respond();
  }) as typeof fetch;
});
afterEach(async () => {
  await act(async () => { root?.unmount(); }); root = undefined;
  globalThis.fetch = originalFetch;
  win.close();
  for (const key of globals) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value: previous[key] });
});
async function render(provider = item, identity = "credential-a", apiBase = "http://localhost") {
  if (!root) {
    const { createRoot } = await import("react-dom/client"); root = createRoot(host);
  }
  await act(async () => {
    root!.render(<LanguageProvider><ProviderOverview item={provider} apiBase={apiBase}
      connectionIdentity={identity} availableModels={["listed", "configured"]} /></LanguageProvider>);
  });
}
function runButton() {
  return Array.from(host.querySelectorAll<HTMLButtonElement>("button")).find(button => button.textContent === "Test model")!;
}
async function select(model = "configured") {
  await act(async () => { host.querySelector<HTMLButtonElement>('[role="combobox"][aria-label="Model to test"]')!.click(); });
  const option = Array.from(document.querySelectorAll<HTMLButtonElement>('[role="option"]')).find(o => o.textContent === model)!;
  expect(option).toBeTruthy();
  await act(async () => { option.click(); });
}
async function begin(accept = true) {
  await act(async () => { runButton().click(); });
  expect(actionDialogOpen(document)).toBe(true);
  if (accept) await act(async () => { acceptActionDialog(document); });
}
function hold() {
  let release!: (response: Response) => void;
  respond = () => new Promise<Response>(resolve => { release = resolve; });
  return (result: CompletionTestResult = success) => release(Response.json(result));
}

test("model selection and explicit confirmation are required; configured/listed/default ids are deduplicated", async () => {
  await render();
  expect(runButton().disabled).toBe(true); expect(requests).toHaveLength(0);
  await select();
  expect(runButton().disabled).toBe(false); expect(requests).toHaveLength(0);
  await begin(false);
  expect(requests).toHaveLength(0);
  expect(actionDialogText(document)).toContain("32");
  expect(actionDialogText(document)).toContain("quota");
  expect(actionDialogText(document)).toContain("costs");
  expect(actionDialogText(document)).toContain("configured");
  expect(actionDialogText(document)).toContain(item.name);
  await act(async () => { acceptActionDialog(document); });
  expect(requests).toHaveLength(1);
  expect(requests[0].url).toBe("http://localhost/api/providers/test-completion?name=test%20vendor");
  expect(requests[0].init.method).toBe("POST");
  expect(new Headers(requests[0].init.headers).get("content-type")).toBe("application/json");
  expect(JSON.parse(String(requests[0].init.body))).toEqual({ model: "configured", confirm: true });
  await select("listed"); await select("default");
  await act(async () => { host.querySelector<HTMLButtonElement>('[role="combobox"]')!.click(); });
  expect(Array.from(document.querySelectorAll('[role="option"]')).map(o => o.textContent)).toEqual([
    "Choose a model", "configured", "listed", "default",
  ]);
});

test("canceling the confirmation sends zero requests", async () => {
  await render(); await select(); await begin(false);
  await act(async () => { dismissActionDialog(document); });
  expect(requests).toHaveLength(0); expect(runButton().disabled).toBe(false);
});

for (const change of ["model", "provider", "credential", "endpoint", "unmount"] as const) {
  test(`${change} change aborts and suppresses a late completion response`, async () => {
    const release = hold();
    await render(); await select(); await begin();
    const signal = requests[0].init.signal!;
    expect(signal.aborted).toBe(false);
    if (change === "model") await select("listed");
    else if (change === "provider") await render({ ...item, name: "other" });
    else if (change === "credential") await render(item, "credential-b");
    else if (change === "endpoint") await render(item, "credential-a", "http://localhost:9999");
    else await act(async () => { root!.unmount(); root = undefined; });
    expect(signal.aborted).toBe(true);
    await act(async () => { release(); });
    expect(host.querySelector('[data-completion-test-state]')).toBeNull();
    if (change !== "unmount") {
      if (change !== "model") await select();
      respond = async () => Response.json({ ...success, upstreamModel: "new-model", modelComparison: "mismatch" });
      await begin();
      expect(host.textContent).toContain("new-model");
    }
  });
  test(`${change} change withdraws a pending confirmation without sending`, async () => {
    await render(); await select(); await begin(false);
    if (change === "model") await select("listed");
    else if (change === "provider") await render({ ...item, name: "other" });
    else if (change === "credential") await render(item, "credential-b");
    else if (change === "endpoint") await render(item, "credential-a", "http://localhost:9999");
    else await act(async () => { root!.unmount(); root = undefined; });
    expect(actionDialogOpen(document)).toBe(false); expect(requests).toHaveLength(0);
  });
}

test("success renders timing, upstream comparison and the identity disclaimer", async () => {
  await render(); await select(); await begin();
  expect(host.querySelector('[data-completion-test-state="ok"]')).toBeTruthy();
  for (const text of ["Model test succeeded", "Time to first token", "12 ms", "Total latency", "45 ms",
    "Upstream reported wire-model for wire-model", "Match", "does not verify the actual model's identity"]) {
    expect(host.textContent).toContain(text);
  }
});

test("mismatched metadata is distinct from completion success", async () => {
  respond = async () => Response.json({ ...success, upstreamModel: "another-model", modelComparison: "mismatch" });
  await render(); await select(); await begin();
  expect(host.querySelector('[data-completion-test-state="ok"]')).toBeTruthy();
  expect(host.textContent).toContain("Upstream reported another-model for wire-model");
  expect(host.querySelector(".badge-amber")?.textContent).toBe("Mismatch");
});

for (const [note, message] of [["missing_metadata", "no model metadata"], ["conflicting_metadata", "conflicting model metadata"]] as const) {
  test(`unknown comparison renders ${note}`, async () => {
    respond = async () => Response.json({ ...success, upstreamModel: null, modelComparison: "unknown", comparisonNote: note, ttftMs: null });
    await render(); await select(); await begin();
    expect(host.textContent).toContain("Upstream did not report a model for wire-model");
    expect(host.querySelector(".badge-muted")?.textContent).toBe("Unknown");
    expect(host.textContent).toContain(message);
    expect(host.querySelector(".pws-kv dd")?.textContent).not.toContain("null");
  });
}

for (const reason of ["disabled", "forward_auth", "oauth_auth", "unsupported_adapter", "unsupported_transport"] as const) {
  test(`inapplicable ${reason} renders its reason without success or timing`, async () => {
    respond = async () => Response.json({ applicable: false, reason, adapter: "anthropic" });
    await render(); await select(); await begin();
    expect(host.textContent).toContain("Test not applicable");
    expect(host.textContent).toContain("anthropic");
    expect(host.textContent).not.toContain("Time to first token");
    expect(host.querySelector('[data-completion-test-state]')).toBeNull();
  });
}

for (const [detail, message] of [["tls_profile", "custom TLS profile"], ["upstream_http_version", "upstream HTTP version"],
  ["request_pacing", "Request pacing"], ["custom_executor_egress", "custom fetch executor"]] as const) {
  test(`inapplicable transport renders ${detail}`, async () => {
    respond = async () => Response.json({ applicable: false, reason: "unsupported_transport", detail });
    await render(); await select(); await begin();
    expect(host.textContent).toContain(message);
  });
}

for (const termination of ["failed", "timeout", "aborted", "too_large"] as const) {
  test(`${termination} result renders code, message, status and timings`, async () => {
    respond = async () => Response.json({ ...success, ok: false, termination, ttftMs: null,
      error: { code: termination === "failed" ? "http_status" : termination, status: 401, message: "Fixed safe failure" } });
    await render(); await select(); await begin();
    expect(host.querySelector('[data-completion-test-state="failed"]')).toBeTruthy();
    expect(host.querySelector('[role="alert"]')?.textContent).toContain(termination === "failed" ? "http_status" : termination);
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("401");
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("Fixed safe failure");
    expect(host.textContent).toContain("45 ms");
    expect(host.textContent).toContain("does not verify the actual model's identity");
  });
}

test("HTTP rejection displays the management API error and allows retry", async () => {
  respond = async () => Response.json({ error: "completion test already running for this provider" }, { status: 409 });
  await render(); await select(); await begin();
  expect(host.querySelector('[role="alert"]')?.textContent).toBe("completion test already running for this provider");
  expect(runButton().disabled).toBe(false);
});
