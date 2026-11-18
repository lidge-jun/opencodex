import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act, type ReactNode } from "react";
import type { Root } from "react-dom/client";
import type { CompletionTestResult } from "../src/components/provider-workspace/ProviderCompletionTest";
import ProviderDetails from "../src/components/provider-workspace/ProviderDetails";
import ProviderOverview from "../src/components/provider-workspace/ProviderOverview";
import { LanguageProvider } from "../src/i18n/provider";
import type { WorkspaceItem } from "../src/provider-workspace/catalog";
import { acceptActionDialog, dismissActionDialog } from "./helpers/action-dialog";

const globals = [
  "document",
  "window",
  "navigator",
  "localStorage",
  "sessionStorage",
  "HTMLElement",
  "IS_REACT_ACT_ENVIRONMENT",
] as const;

let previous: Record<string, unknown>;
let win: Window;
let root: Root | undefined;
let host: HTMLElement;
let respondCompletion: (init?: RequestInit) => Promise<Response>;
const originalFetch = globalThis.fetch;

const baseItem: WorkspaceItem = {
  name: "my-provider",
  adapter: "openai-chat",
  baseUrl: "https://example.test/v1",
  authMode: "key",
  hasApiKey: true,
  models: ["model-a", "model-b"],
  defaultModel: "model-a",
};

const completionOk: Extract<CompletionTestResult, { applicable: true }> = {
  applicable: true,
  ok: true,
  provider: "my-provider",
  requestedModel: "model-a",
  wireModel: "model-a",
  wire: "openai-chat",
  upstreamModel: "model-a",
  modelComparison: "match",
  identityVerified: false,
  ttftMs: 9,
  totalLatencyMs: 25,
  outputTokenCap: 32,
  termination: "completed",
  error: null,
};

function failedResult(
  code: Extract<CompletionTestResult, { applicable: true }>["error"] extends { code: infer C } | null ? C : string,
  status?: number,
  termination: Extract<CompletionTestResult, { applicable: true }>["termination"] = "failed",
): Extract<CompletionTestResult, { applicable: true }> {
  return {
    ...completionOk,
    ok: false,
    ttftMs: null,
    termination,
    error: { code: code as never, ...(status !== undefined ? { status } : {}), message: "Upstream test failure" },
  };
}

beforeEach(() => {
  previous = Object.fromEntries(globals.map(key => [key, Reflect.get(globalThis, key)]));
  win = new Window({ url: "http://localhost/#providers" });
  Object.defineProperty(win.navigator, "language", { configurable: true, value: "en-US" });
  for (const [key, value] of Object.entries({
    window: win,
    document: win.document,
    navigator: win.navigator,
    localStorage: win.localStorage,
    sessionStorage: win.sessionStorage,
    HTMLElement: win.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  host = document.createElement("div");
  document.body.append(host);
  respondCompletion = async () => Response.json(completionOk);
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/api/providers/test-completion")) return respondCompletion(init);
    if (url.includes("/api/provider-presets")) return Response.json({ providers: [] });
    if (url.includes("/api/provider-request-pacing")) return Response.json({ enabled: false, queued: 0, nextSlotInMs: 0 });
    if (url.includes("/api/protocols")) return Response.json({ protocols: [] });
    return Response.json({});
  }) as typeof fetch;
});

afterEach(async () => {
  await act(async () => { root?.unmount(); });
  root = undefined;
  globalThis.fetch = originalFetch;
  win.close();
  for (const key of globals) {
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value: previous[key] });
  }
});

async function render(node: ReactNode) {
  if (!root) {
    const { createRoot } = await import("react-dom/client");
    root = createRoot(host);
  }
  await act(async () => {
    root!.render(<LanguageProvider>{node}</LanguageProvider>);
  });
}

async function selectModel(model = "model-a") {
  await act(async () => {
    host.querySelector<HTMLButtonElement>('[role="combobox"][aria-label="Model to test"]')!.click();
  });
  const option = Array.from(document.querySelectorAll<HTMLButtonElement>('[role="option"]')).find(o => o.textContent === model)!;
  await act(async () => { option.click(); });
}

function runButton(): HTMLButtonElement {
  return Array.from(host.querySelectorAll<HTMLButtonElement>("button")).find(b => b.textContent === "Test model")!;
}

async function runAndConfirm() {
  await act(async () => { runButton().click(); });
  await act(async () => { acceptActionDialog(document); });
}

describe("failure -> fix -> re-verify -> disconnect linkage", () => {
  test("classifies 401/auth, 429/rate_limit, timeout/connection, 404/model, 500/upstream, aborted, credential_changed, and 409 request failures", async () => {
    let fixedAuth = 0;
    let fixedSettings = 0;
    let fixedModels = 0;
    await render(
      <ProviderOverview
        item={baseItem}
        apiBase=""
        availableModels={["model-a", "model-b"]}
        onOpenAccounts={() => { fixedAuth++; }}
        onEditSettings={() => { fixedSettings++; }}
        onOpenModelsTab={() => { fixedModels++; }}
      />,
    );
    await selectModel("model-a");

    // 401 -> auth recovery with fix-auth action
    respondCompletion = async () => Response.json(failedResult("http_status", 401));
    await runAndConfirm();
    expect(host.querySelector('[data-failure-recovery="auth"]')).not.toBeNull();
    await act(async () => { host.querySelector<HTMLButtonElement>('[data-recovery-action="fix-auth"]')!.click(); });
    expect(fixedAuth).toBe(1);

    // 429 -> rate_limit recovery (advises waiting or switching key/account, never enabling request pacing)
    respondCompletion = async () => Response.json(failedResult("http_status", 429));
    await runAndConfirm();
    const rateLimitEl = host.querySelector('[data-failure-recovery="rate_limit"]')!;
    expect(rateLimitEl).not.toBeNull();
    expect(rateLimitEl.textContent?.toLowerCase()).not.toContain("pacing");

    // timeout -> connection recovery with fix-connection action
    respondCompletion = async () => Response.json(failedResult("timeout", undefined, "timeout"));
    await runAndConfirm();
    expect(host.querySelector('[data-failure-recovery="connection"]')).not.toBeNull();
    await act(async () => { host.querySelector<HTMLButtonElement>('[data-recovery-action="fix-connection"]')!.click(); });
    expect(fixedSettings).toBe(1);

    // 404 -> model recovery with fix-model action
    respondCompletion = async () => Response.json(failedResult("http_status", 404));
    await runAndConfirm();
    expect(host.querySelector('[data-failure-recovery="model"]')).not.toBeNull();
    await act(async () => { host.querySelector<HTMLButtonElement>('[data-recovery-action="fix-model"]')!.click(); });
    expect(fixedModels).toBe(1);

    // 500 -> upstream recovery
    respondCompletion = async () => Response.json(failedResult("http_status", 500));
    await runAndConfirm();
    expect(host.querySelector('[data-failure-recovery="upstream"]')).not.toBeNull();

    // aborted precedence over HTTP status 401
    respondCompletion = async () => Response.json(failedResult("aborted", 401, "aborted"));
    await runAndConfirm();
    expect(host.querySelector('[data-failure-recovery="aborted"]')).not.toBeNull();

    // credential_changed -> concurrency recovery, not blaming credentials
    respondCompletion = async () => Response.json(failedResult("credential_changed", 401));
    await runAndConfirm();
    expect(host.querySelector('[data-failure-recovery="concurrency"]')).not.toBeNull();

    // HTTP 409 management-request failure preserves exact role="alert" text and shows request recovery
    respondCompletion = async () => Response.json({ error: "completion test already running for this provider" }, { status: 409 });
    await runAndConfirm();
    expect(host.querySelector('[role="alert"]')?.textContent).toBe("completion test already running for this provider");
    expect(host.querySelector('[data-failure-recovery="request"]')).not.toBeNull();

    // Failed Test connection renders a direct recovery button beside the failed connection status
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/providers/test?")) {
        return Response.json({ applicable: true, ok: false, error: "Upstream 401" });
      }
      return Response.json({});
    }) as typeof fetch;
    const testConnBtn = Array.from(host.querySelectorAll<HTMLButtonElement>("button")).find(b => b.textContent === "Test connection")!;
    await act(async () => { testConnBtn.click(); });
    const connRecoveryBtn = host.querySelector<HTMLButtonElement>('[data-connection-recovery-action="fix-connection"]')!;
    expect(connRecoveryBtn).not.toBeNull();
    await act(async () => { connRecoveryBtn.click(); });
    expect(fixedAuth).toBe(2);
  });

  test("full ProviderDetails flow: 401 failure -> tab hop retains result -> saving settings latches re-verify -> re-running same preserved model succeeds", async () => {
    let savedPatches = 0;
    let currentItem: WorkspaceItem = { ...baseItem };
    respondCompletion = async () => Response.json(failedResult("http_status", 401));
    const mountDetails = () => render(
      <ProviderDetails
        item={currentItem}
        availableModels={["model-a", "model-b"]}
        hasLiveModels
        selectedModels={["model-a", "model-b"]}
        modelRows={[
          { provider: "my-provider", id: "model-a", namespaced: "my-provider/model-a", disabled: false },
          { provider: "my-provider", id: "model-b", namespaced: "my-provider/model-b", disabled: false },
        ]}
        modelRevision="r1"
        modelRowsReady
        onOpenModels={() => {}}
        onDeselect={() => {}}
        apiBase=""
        onUpdateProvider={async (_name, patch) => {
          savedPatches++;
          currentItem = { ...currentItem, ...(patch.baseUrl ? { baseUrl: patch.baseUrl } : {}) };
          return { ok: true };
        }}
      />,
    );
    await mountDetails();

    await selectModel("model-a");
    await runAndConfirm();
    expect(host.querySelector('[data-failure-recovery="auth"]')).not.toBeNull();

    // Click fix-connection / settings tab without saving, then hop back to Overview:
    // the failed result, recovery block, and selected model are all retained!
    await act(async () => { host.querySelector<HTMLButtonElement>("#pws-tab-settings")!.click(); });
    await act(async () => { host.querySelector<HTMLButtonElement>("#pws-tab-overview")!.click(); });
    expect(host.querySelector('[data-failure-recovery="auth"]')).not.toBeNull();
    expect(host.querySelector<HTMLButtonElement>('[role="combobox"][aria-label="Model to test"]')?.textContent).toContain("model-a");

    // Saving a note-only patch on Overview does NOT clear the failure or trigger re-verification:
    await act(async () => { host.querySelector<HTMLButtonElement>(".pws-notes-display")!.click(); });
    const noteBox = host.querySelector<HTMLTextAreaElement>(".pws-notes-textarea")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(win.HTMLTextAreaElement.prototype, "value")!.set!.call(noteBox, "operator note");
      noteBox.dispatchEvent(new win.Event("input", { bubbles: true }));
    });
    await act(async () => {
      noteBox.dispatchEvent(new win.FocusEvent("focusout", { bubbles: true, relatedTarget: null }));
      await Promise.resolve();
    });
    expect(savedPatches).toBe(1);
    expect(host.querySelector('[data-failure-recovery="auth"]')).not.toBeNull();
    expect(host.querySelector('[data-first-response-step="probe"]')?.getAttribute("data-reverify-pending")).toBeNull();

    // Now hop to Settings and save a change:
    await act(async () => { host.querySelector<HTMLButtonElement>("#pws-tab-settings")!.click(); await new Promise(r => win.setTimeout(r, 15)); });
    const baseUrlInput = Array.from(host.querySelectorAll<HTMLInputElement>(".pws-detail-panel input"))
      .find(i => i.value === "https://example.test/v1")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, "value")!.set!.call(baseUrlInput, "https://fixed.example.test/v1");
      baseUrlInput.dispatchEvent(new win.Event("input", { bubbles: true }));
    });
    const saveBtn = host.querySelector<HTMLButtonElement>(".pwi-settings-sticky-bar .btn-primary")!;
    await act(async () => { saveBtn.click(); await Promise.resolve(); });
    expect(savedPatches).toBe(2);
    await mountDetails();

    // Return to Overview: stale failure result is cleared, model-a is still selected, and re-verify is pending!
    await act(async () => { host.querySelector<HTMLButtonElement>("#pws-tab-overview")!.click(); });
    expect(host.querySelector('[data-failure-recovery]')).toBeNull();
    expect(host.querySelector<HTMLButtonElement>('[role="combobox"][aria-label="Model to test"]')?.textContent).toContain("model-a");
    const probeStep = host.querySelector('[data-first-response-step="probe"]')!;
    expect(probeStep.getAttribute("data-step-state")).toBe("untested");
    expect(probeStep.getAttribute("data-reverify-pending")).toBe("true");
    expect(probeStep.textContent).toContain("model-a");

    // Canceling confirmation keeps re-verify pending:
    await act(async () => { runButton().click(); });
    await act(async () => { dismissActionDialog(document); });
    expect(probeStep.getAttribute("data-reverify-pending")).toBe("true");

    // Re-running the preserved model-a to success clears re-verify pending and reaches "ok":
    respondCompletion = async () => Response.json(completionOk);
    await runAndConfirm();
    expect(probeStep.getAttribute("data-step-state")).toBe("ok");
    expect(probeStep.getAttribute("data-reverify-pending")).toBeNull();
  });

  test("adding an API key through ProviderAuthPanel advances probe revision even when active key ID is unchanged", async () => {
    let addedKeys = 0;
    let cancelledRemovals = 0;
    respondCompletion = async () => Response.json(failedResult("http_status", 401));
    await render(
      <ProviderDetails
        item={baseItem}
        availableModels={["model-a"]}
        hasLiveModels
        selectedModels={["model-a"]}
        modelRows={[{ provider: "my-provider", id: "model-a", namespaced: "my-provider/model-a", disabled: false }]}
        modelRevision="r1"
        modelRowsReady
        onOpenModels={() => {}}
        onDeselect={() => {}}
        apiBase=""
        keys={[{ id: "k1", masked: "sk-...1", active: true }]}
        authHandlers={{
          onLogin: () => {},
          onLogout: () => {},
          onReauth: () => {},
          onSwitchAccount: () => {},
          onPauseAccount: () => {},
          onRemoveAccount: () => {},
          onAddApiKey: async () => { addedKeys++; return true; },
          onSwitchApiKey: () => {},
          onRemoveApiKey: async () => { cancelledRemovals++; },
          onEditAlias: () => {},
        }}
      />,
    );

    await selectModel("model-a");
    await runAndConfirm();
    expect(host.querySelector('[data-failure-recovery="auth"]')).not.toBeNull();

    // Click Update credentials -> switches to API Keys tab. A cancelled remove (void return, keys unchanged) preserves the failure:
    await act(async () => { host.querySelector<HTMLButtonElement>('[data-recovery-action="fix-auth"]')!.click(); });
    const removeKeyBtn = host.querySelector<HTMLButtonElement>('.pwi-auth-acct-actions button[aria-label*="Remove"], .pwi-auth-acct button[title*="Remove"]')
      ?? Array.from(host.querySelectorAll<HTMLButtonElement>(".pws-detail-panel li button")).at(-1)!;
    await act(async () => { removeKeyBtn.click(); await Promise.resolve(); });
    expect(cancelledRemovals).toBe(1);
    await act(async () => { host.querySelector<HTMLButtonElement>("#pws-tab-overview")!.click(); });
    expect(host.querySelector('[data-failure-recovery="auth"]')).not.toBeNull();
    expect(host.querySelector('[data-first-response-step="probe"]')?.getAttribute("data-reverify-pending")).toBeNull();

    // Now switch back to API Keys and add a confirmed key (onAddApiKey returns true while active key ID remains k1):
    await act(async () => { host.querySelector<HTMLButtonElement>('[data-recovery-action="fix-auth"]')!.click(); });
    const addKeyToggle = Array.from(host.querySelectorAll<HTMLButtonElement>(".pws-detail-panel button"))
      .find(b => b.textContent?.includes("Add API key"))!;
    await act(async () => { addKeyToggle.click(); });
    const keyInput = host.querySelector<HTMLInputElement>('.pws-detail-panel input[type="password"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, "value")!.set!.call(keyInput, "sk-new-key-value");
      keyInput.dispatchEvent(new win.Event("input", { bubbles: true }));
    });
    const saveKeyBtn = host.querySelector<HTMLButtonElement>(".pwi-auth-add-key .btn-primary")!;
    await act(async () => { saveKeyBtn.click(); await Promise.resolve(); });
    expect(addedKeys).toBe(1);

    // Return to Overview: re-verify is pending and model-a remains selected!
    await act(async () => { host.querySelector<HTMLButtonElement>("#pws-tab-overview")!.click(); });
    const probeStep = host.querySelector('[data-first-response-step="probe"]')!;
    expect(probeStep.getAttribute("data-reverify-pending")).toBe("true");
    expect(host.querySelector<HTMLButtonElement>('[role="combobox"][aria-label="Model to test"]')?.textContent).toContain("model-a");
  });

  test("OAuth roster settlement and Codex pool mutations with unchanged active ID still latch re-verification", async () => {
    respondCompletion = async () => Response.json(failedResult("http_status", 401));
    const mountWithPools = (
      providerItem: WorkspaceItem,
      oauthAccounts: Array<{ id: string; active: boolean; expiresAt?: number }>,
      codexAccounts: Array<{ id: string; email: string; isMain: boolean; paused: boolean; priority: number; hasCredential: boolean; quota: null }>,
    ) => render(
      <ProviderDetails
        item={providerItem}
        availableModels={["model-a"]}
        hasLiveModels
        selectedModels={["model-a"]}
        modelRows={[{ provider: providerItem.name, id: "model-a", namespaced: `${providerItem.name}/model-a`, disabled: false }]}
        modelRevision="r1"
        modelRowsReady
        onOpenModels={() => {}}
        onDeselect={() => {}}
        apiBase=""
        accounts={oauthAccounts}
        codexController={{
          accounts: codexAccounts,
          activeId: "main",
        } as never}
      />,
    );

    const baseCodex = [
      { id: "main", email: "main@example.test", isMain: true, paused: false, priority: 0, hasCredential: true, quota: null },
      { id: "pool-2", email: "p2@example.test", isMain: false, paused: false, priority: 1, hasCredential: true, quota: null },
    ];
    await mountWithPools(baseItem, [{ id: "acct-1", active: true, expiresAt: 1000 }], baseCodex);
    await selectModel("model-a");
    await runAndConfirm();
    expect(host.querySelector('[data-first-response-step="probe"]')?.getAttribute("data-step-state")).toBe("failed");

    // Codex pool changes must NOT invalidate or latch re-verification for an unrelated non-forward provider:
    await mountWithPools(
      baseItem,
      [{ id: "acct-1", active: true, expiresAt: 1000 }],
      [baseCodex[0]!, { ...baseCodex[1]!, paused: true }],
    );
    expect(host.querySelector('[data-first-response-step="probe"]')?.getAttribute("data-step-state")).toBe("failed");
    expect(host.querySelector('[data-first-response-step="probe"]')?.getAttribute("data-reverify-pending")).toBeNull();

    // A noncanonical custom forward provider does not use the Codex account pool and must also stay unaffected:
    const customForwardItem: WorkspaceItem = {
      ...baseItem,
      name: "custom-forward",
      adapter: "openai-responses",
      authMode: "forward",
      baseUrl: "https://custom-forward.example.test/v1",
    };
    await mountWithPools(customForwardItem, [], baseCodex);
    await selectModel("model-a");
    await runAndConfirm();
    expect(host.querySelector('[data-first-response-step="probe"]')?.getAttribute("data-step-state")).toBe("failed");
    await mountWithPools(customForwardItem, [], [baseCodex[0]!, { ...baseCodex[1]!, paused: true }]);
    expect(host.querySelector('[data-first-response-step="probe"]')?.getAttribute("data-step-state")).toBe("failed");
    expect(host.querySelector('[data-first-response-step="probe"]')?.getAttribute("data-reverify-pending")).toBeNull();

    // OAuth reauth refreshes expiresAt (or adds a non-active account) while active ID stays "acct-1":
    await mountWithPools(baseItem, [{ id: "acct-1", active: true, expiresAt: 1000 }], baseCodex);
    await selectModel("model-a");
    await runAndConfirm();
    await mountWithPools(baseItem, [{ id: "acct-1", active: true, expiresAt: 2000 }], baseCodex);
    expect(host.querySelector('[data-first-response-step="probe"]')?.getAttribute("data-reverify-pending")).toBe("true");

    // On the forward/account provider itself, pausing a non-active Codex pool account while activeId stays "main" DOES latch re-verification:
    const forwardItem: WorkspaceItem = {
      ...baseItem,
      name: "openai",
      adapter: "openai-responses",
      authMode: "forward",
      baseUrl: "https://chatgpt.com/backend-api/codex",
    };
    await mountWithPools(forwardItem, [], baseCodex);
    await selectModel("model-a");
    await runAndConfirm();
    expect(host.querySelector('[data-first-response-step="probe"]')?.getAttribute("data-step-state")).toBe("failed");
    await mountWithPools(
      forwardItem,
      [],
      [baseCodex[0]!, { ...baseCodex[1]!, paused: true }],
    );
    expect(host.querySelector('[data-first-response-step="probe"]')?.getAttribute("data-reverify-pending")).toBe("true");
  });

  test("K1 -> K2 -> K1 keeps re-verification latched until a new run, and off-tab model removal permanently clears state", async () => {
    respondCompletion = async () => Response.json(failedResult("http_status", 401));
    const renderDetails = (identity: string, available: string[]) => render(
      <ProviderDetails
        item={{ ...baseItem, models: available, defaultModel: available[0] }}
        availableModels={available}
        hasLiveModels
        selectedModels={available}
        modelRows={available.map(id => ({ provider: "my-provider", id, namespaced: `my-provider/${id}`, disabled: false }))}
        modelRevision="r1"
        modelRowsReady
        onOpenModels={() => {}}
        onDeselect={() => {}}
        apiBase=""
        keys={[{ id: identity, masked: "sk-...", active: true }]}
      />,
    );

    await renderDetails("k1", ["model-a", "model-b"]);
    await selectModel("model-a");
    await runAndConfirm();
    expect(host.querySelector('[data-first-response-step="probe"]')?.getAttribute("data-step-state")).toBe("failed");

    // K1 -> K2 -> K1: re-verify remains latched even after returning to K1!
    await renderDetails("k2", ["model-a", "model-b"]);
    expect(host.querySelector('[data-first-response-step="probe"]')?.getAttribute("data-reverify-pending")).toBe("true");
    await renderDetails("k1", ["model-a", "model-b"]);
    expect(host.querySelector('[data-first-response-step="probe"]')?.getAttribute("data-reverify-pending")).toBe("true");

    // Hop to Settings tab, remove model-a while off-tab, then re-add model-a and return to Overview:
    await act(async () => { host.querySelector<HTMLButtonElement>("#pws-tab-settings")!.click(); });
    await renderDetails("k1", ["model-b"]);
    await renderDetails("k1", ["model-a", "model-b"]);
    await act(async () => { host.querySelector<HTMLButtonElement>("#pws-tab-overview")!.click(); });
    expect(host.querySelector('[data-first-response-step="probe"]')?.getAttribute("data-reverify-pending")).toBeNull();
    expect(host.querySelector<HTMLButtonElement>('[role="combobox"][aria-label="Model to test"]')?.textContent).toContain("Choose a model");
  });

  test("leaving Overview during an in-flight probe aborts the request and clears testing status", async () => {
    let release!: (res: Response) => void;
    let capturedSignal: AbortSignal | null | undefined;
    respondCompletion = (init?: RequestInit) => {
      capturedSignal = init?.signal;
      return new Promise<Response>(resolve => { release = resolve; });
    };
    await render(
      <ProviderDetails
        item={baseItem}
        availableModels={["model-a"]}
        hasLiveModels
        selectedModels={["model-a"]}
        modelRows={[{ provider: "my-provider", id: "model-a", namespaced: "my-provider/model-a", disabled: false }]}
        modelRevision="r1"
        modelRowsReady
        onOpenModels={() => {}}
        onDeselect={() => {}}
        apiBase=""
      />,
    );
    await selectModel("model-a");
    await runAndConfirm();
    expect(host.querySelector('[data-first-response-step="probe"]')?.getAttribute("data-step-state")).toBe("testing");
    expect(capturedSignal?.aborted).toBe(false);

    // Switch to Settings while the probe is in flight, then resolve the old request and return to Overview:
    await act(async () => { host.querySelector<HTMLButtonElement>("#pws-tab-settings")!.click(); });
    expect(capturedSignal?.aborted).toBe(true);
    await act(async () => { release(Response.json(completionOk)); });
    await act(async () => { host.querySelector<HTMLButtonElement>("#pws-tab-overview")!.click(); });
    expect(host.querySelector('[data-first-response-step="probe"]')?.getAttribute("data-step-state")).toBe("untested");
  });

  test("disconnect guidance explains Claude Code toggle vs Codex service/catalog restore, running-session scope, and links to Connect", async () => {
    let openedConnect = 0;
    await render(
      <ProviderOverview
        item={baseItem}
        apiBase=""
        availableModels={["model-a"]}
        onOpenConnect={() => { openedConnect++; }}
      />,
    );
    const disconnectRow = host.querySelector('[data-first-response-step="disconnect"]')!;
    expect(disconnectRow).not.toBeNull();
    expect(disconnectRow.getAttribute("data-step-state")).toBe("info");
    expect(disconnectRow.textContent).toContain("Claude Code");
    expect(disconnectRow.textContent).toContain("Codex");
    expect(disconnectRow.textContent).toContain("my-provider");
    await act(async () => { disconnectRow.querySelector<HTMLButtonElement>("button")!.click(); });
    expect(openedConnect).toBe(1);
  });
});
