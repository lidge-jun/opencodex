import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act, type ReactNode } from "react";
import type { Root } from "react-dom/client";
import { clearClientResourceStoresForTests } from "../src/client-resource";
import ProviderModelsNotice from "../src/components/ProviderModelsNotice";
import type { CompletionTestResult } from "../src/components/provider-workspace/ProviderCompletionTest";
import ProviderDetails from "../src/components/provider-workspace/ProviderDetails";
import ProviderOverview from "../src/components/provider-workspace/ProviderOverview";
import { LanguageProvider } from "../src/i18n/provider";
import type { ModelRow } from "../src/pages/models-shared";
import Providers from "../src/pages/Providers";
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
let requests: Array<{ url: string; init?: RequestInit }>;
let respondCompletion: () => Promise<Response>;
const originalFetch = globalThis.fetch;

const baseItem: WorkspaceItem = {
  name: "my-provider",
  adapter: "openai-chat",
  baseUrl: "https://example.test/v1",
  hasApiKey: true,
  models: ["model-a"],
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
  ttftMs: 10,
  totalLatencyMs: 30,
  outputTokenCap: 32,
  termination: "completed",
  error: null,
};

beforeEach(() => {
  previous = Object.fromEntries(globals.map(key => [key, Reflect.get(globalThis, key)]));
  clearClientResourceStoresForTests();
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
  requests = [];
  respondCompletion = async () => Response.json(completionOk);
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    requests.push({ url, init });
    if (url.includes("/api/providers/test-completion")) return respondCompletion();
    return Response.json({});
  }) as typeof fetch;
});

afterEach(async () => {
  await act(async () => { root?.unmount(); });
  root = undefined;
  clearClientResourceStoresForTests();
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

function stepState(step: "provider" | "models" | "clients" | "probe"): string | null {
  return host.querySelector(`[data-first-response-step="${step}"]`)?.getAttribute("data-step-state") ?? null;
}

function stepText(step: "provider" | "models" | "clients" | "probe"): string {
  return host.querySelector(`[data-first-response-step="${step}"]`)?.textContent ?? "";
}

async function selectProbeModel(model = "model-a") {
  await act(async () => {
    host.querySelector<HTMLButtonElement>('[role="combobox"][aria-label="Model to test"]')!.click();
  });
  const option = Array.from(document.querySelectorAll<HTMLButtonElement>('[role="option"]')).find(o => o.textContent === model)!;
  await act(async () => { option.click(); });
}

function runProbeButton(): HTMLButtonElement {
  return Array.from(host.querySelectorAll<HTMLButtonElement>("button")).find(b => b.textContent === "Test model")!;
}

describe("first-response progression states on ProviderOverview", () => {
  test("distinguishes provider saved, models ready, client routing guidance, and untested probe without claiming Connected", async () => {
    const rows: ModelRow[] = [{ provider: "my-provider", id: "model-a", namespaced: "my-provider/model-a", disabled: false }];
    let openedConnect = 0;
    let openedModelsTab = 0;
    await render(
      <ProviderOverview
        item={baseItem}
        apiBase=""
        availableModels={["model-a"]}
        selectedModels={["model-a"]}
        modelRows={rows}
        modelRowsReady
        onOpenConnect={() => { openedConnect++; }}
        onOpenModelsTab={() => { openedModelsTab++; }}
      />,
    );
    expect(host.textContent).not.toContain("Connected");
    expect(stepState("provider")).toBe("saved");
    expect(stepState("models")).toBe("ready");
    expect(stepText("models")).toContain("1");
    expect(stepState("clients")).toBe("info");
    expect(stepText("clients")).toContain("my-provider");
    expect(stepState("probe")).toBe("untested");

    const openModelsBtn = host.querySelector<HTMLButtonElement>('[data-first-response-step="models"] button')!;
    await act(async () => { openModelsBtn.click(); });
    expect(openedModelsTab).toBe(1);

    const openConnectBtn = host.querySelector<HTMLButtonElement>('[data-first-response-step="clients"] button')!;
    await act(async () => { openConnectBtn.click(); });
    expect(openedConnect).toBe(1);
  });

  test("provider step distinguishes disabled, needs-attention, oauth login required, and missing credentials", async () => {
    await render(<ProviderOverview item={{ ...baseItem, disabled: true }} apiBase="" />);
    expect(stepState("provider")).toBe("disabled");

    await render(<ProviderOverview item={{ ...baseItem, activeNeedsReauth: true }} apiBase="" />);
    expect(stepState("provider")).toBe("needs-attention");
    expect(host.querySelector(".pws-kv dd")?.textContent).toContain("Needs attention");

    await render(
      <ProviderOverview
        item={{ ...baseItem, authMode: "oauth", hasApiKey: false }}
        oauth={{ loggedIn: true, needsReauth: true }}
        apiBase=""
      />,
    );
    expect(stepState("provider")).toBe("needs-attention");
    expect(host.querySelector(".pws-kv dd")?.textContent).toContain("Needs attention");

    await render(
      <ProviderOverview
        item={{ ...baseItem, authMode: "oauth", hasApiKey: false }}
        oauth={{ loggedIn: false }}
        apiBase=""
      />,
    );
    expect(stepState("provider")).toBe("needs-login");
    expect(host.querySelector(".pws-kv dd")?.textContent).toContain("Needs setup");

    await render(<ProviderOverview item={{ ...baseItem, hasApiKey: false }} apiBase="" />);
    expect(stepState("provider")).toBe("needs-setup");
    expect(host.querySelector(".pws-kv dd")?.textContent).toContain("Needs setup");
  });

  test("models step precedence covers loading, load failed, discovery failed (empty, pending, retained), pending, all-off, configured, and empty", async () => {
    const enabledRow: ModelRow = { provider: "my-provider", id: "model-a", namespaced: "my-provider/model-a", disabled: false };
    const disabledRow: ModelRow = { provider: "my-provider", id: "model-a", namespaced: "my-provider/model-a", disabled: true };
    const pendingRow: ModelRow = { ...disabledRow, initialSelectionPending: true };

    await render(<ProviderOverview item={baseItem} apiBase="" modelsLoading modelRows={[enabledRow]} modelRowsReady />);
    expect(stepState("models")).toBe("loading");

    await render(<ProviderOverview item={baseItem} apiBase="" modelsLoadFailed modelRows={[enabledRow]} modelRowsReady />);
    expect(stepState("models")).toBe("failed");

    await render(
      <ProviderOverview
        item={{ ...baseItem, models: [], defaultModel: undefined, discovery: { status: "failed", reason: "http", httpStatus: 401 } }}
        apiBase=""
        modelRows={[]}
        modelRowsReady
      />,
    );
    expect(stepState("models")).toBe("failed");
    expect(stepText("models")).toContain("401");

    await render(
      <ProviderOverview
        item={{ ...baseItem, discovery: { status: "failed", reason: "network" }, initialModelSelection: { status: "pending" } }}
        apiBase=""
        modelRows={[pendingRow]}
        modelRowsReady
      />,
    );
    expect(stepState("models")).toBe("failed");

    await render(
      <ProviderOverview
        item={{ ...baseItem, discovery: { status: "failed", reason: "network" } }}
        apiBase=""
        modelRows={[enabledRow]}
        modelRowsReady
      />,
    );
    expect(stepState("models")).toBe("ready-discovery-failed");

    await render(<ProviderOverview item={baseItem} apiBase="" modelRows={[pendingRow]} modelRowsReady />);
    expect(stepState("models")).toBe("pending");

    // A settled snapshot whose rows are no longer pending wins over a stale config-level pending flag.
    await render(
      <ProviderOverview
        item={{ ...baseItem, initialModelSelection: { status: "pending" } }}
        apiBase=""
        modelRows={[enabledRow]}
        modelRowsReady
      />,
    );
    expect(stepState("models")).toBe("ready");

    await render(<ProviderOverview item={baseItem} apiBase="" modelRows={[disabledRow]} modelRowsReady />);
    expect(stepState("models")).toBe("all-off");

    await render(<ProviderOverview item={baseItem} apiBase="" modelRows={[]} modelRowsReady />);
    expect(stepState("models")).toBe("configured");

    await render(
      <ProviderOverview
        item={{ ...baseItem, models: [], defaultModel: undefined }}
        apiBase=""
        modelRows={[]}
        modelRowsReady
      />,
    );
    expect(stepState("models")).toBe("empty");
  });

  test("probe step transitions untested -> testing -> ok/failed and permanently invalidates on model removal or A->B->A key change", async () => {
    let release!: (res: Response) => void;
    respondCompletion = () => new Promise<Response>(resolve => { release = resolve; });

    await render(<ProviderOverview item={baseItem} apiBase="" availableModels={["model-a", "model-b"]} />);
    expect(stepState("probe")).toBe("untested");

    await selectProbeModel("model-a");
    await act(async () => { runProbeButton().click(); });
    await act(async () => { dismissActionDialog(document); });
    expect(stepState("probe")).toBe("untested");

    await act(async () => { runProbeButton().click(); });
    await act(async () => { acceptActionDialog(document); });
    expect(stepState("probe")).toBe("testing");

    await act(async () => { release(Response.json(completionOk)); });
    expect(stepState("probe")).toBe("ok");
    expect(stepText("probe")).toContain("model-a");

    // Re-selecting the same model or canceling a re-run confirmation preserves the verified "ok" status.
    await selectProbeModel("model-a");
    expect(stepState("probe")).toBe("ok");
    await act(async () => { runProbeButton().click(); });
    await act(async () => { dismissActionDialog(document); });
    expect(stepState("probe")).toBe("ok");

    // Removing model-a and re-adding it must not resurrect the old "ok" state.
    await render(<ProviderOverview item={{ ...baseItem, models: [], defaultModel: undefined }} apiBase="" availableModels={["model-b"]} />);
    expect(stepState("probe")).toBe("untested");
    await render(<ProviderOverview item={baseItem} apiBase="" availableModels={["model-a", "model-b"]} />);
    expect(stepState("probe")).toBe("untested");

    // Re-run to ok, then change connectionIdentity A -> B -> A: must stay untested.
    respondCompletion = async () => Response.json(completionOk);
    await render(<ProviderOverview item={baseItem} apiBase="" connectionIdentity="cred-a" availableModels={["model-a"]} />);
    await selectProbeModel("model-a");
    await act(async () => { runProbeButton().click(); });
    await act(async () => { acceptActionDialog(document); });
    expect(stepState("probe")).toBe("ok");

    await render(<ProviderOverview item={baseItem} apiBase="" connectionIdentity="cred-b" availableModels={["model-a"]} />);
    expect(stepState("probe")).toBe("untested");
    await render(<ProviderOverview item={baseItem} apiBase="" connectionIdentity="cred-a" availableModels={["model-a"]} />);
    expect(stepState("probe")).toBe("untested");

    // An in-flight probe started under cred-a that resolves after cred-a -> cred-b -> cred-a is ignored.
    let releaseLate!: (res: Response) => void;
    respondCompletion = () => new Promise<Response>(resolve => { releaseLate = resolve; });
    await selectProbeModel("model-a");
    await act(async () => { runProbeButton().click(); });
    await act(async () => { acceptActionDialog(document); });
    expect(stepState("probe")).toBe("testing");

    await render(<ProviderOverview item={baseItem} apiBase="" connectionIdentity="cred-b" availableModels={["model-a"]} />);
    expect(stepState("probe")).toBe("untested");
    await render(<ProviderOverview item={baseItem} apiBase="" connectionIdentity="cred-a" availableModels={["model-a"]} />);
    expect(stepState("probe")).toBe("untested");
    await act(async () => { releaseLate(Response.json(completionOk)); });
    expect(stepState("probe")).toBe("untested");
  });
});

describe("ProviderDetails raw ID disambiguation and Providers page integration", () => {
  test("ProviderDetails header shows both display name and raw config ID when they differ", async () => {
    await render(
      <ProviderDetails
        item={baseItem}
        availableModels={["model-a"]}
        hasLiveModels
        selectedModels={["model-a"]}
        modelRows={[]}
        modelRevision="r1"
        modelRowsReady
        onOpenModels={() => {}}
        onDeselect={() => {}}
        apiBase=""
      />,
    );
    const title = host.querySelector(".pws-detail-title")!;
    expect(title.textContent).toContain("My Provider");
    expect(title.querySelector("code.pws-detail-id")?.textContent).toBe("my-provider");

    await render(
      <ProviderDetails
        item={{ ...baseItem, name: "CustomMixed" }}
        availableModels={["model-a"]}
        hasLiveModels
        selectedModels={["model-a"]}
        modelRows={[]}
        modelRevision="r1"
        modelRowsReady
        onOpenModels={() => {}}
        onDeselect={() => {}}
        apiBase=""
      />,
    );
    expect(host.querySelector(".pws-detail-title code.pws-detail-id")).toBeNull();
  });

  test("ProviderModelsNotice focus fallback skips document.body and CSS-hidden buttons in priority order", async () => {
    const hiddenAncestor = document.createElement("div");
    hiddenAncestor.style.display = "none";
    const hiddenPrev = document.createElement("button");
    hiddenAncestor.append(hiddenPrev);
    document.body.append(hiddenAncestor);

    const panel = document.createElement("div");
    panel.className = "pws-detail-panel";
    const disabledBtn = document.createElement("button");
    disabledBtn.disabled = true;
    const hiddenBtn = document.createElement("button");
    hiddenBtn.textContent = "Hidden action";
    hiddenBtn.style.visibility = "hidden";
    const visibleBtn = document.createElement("button");
    visibleBtn.textContent = "Visible panel action";
    panel.append(disabledBtn, hiddenBtn, visibleBtn);
    document.body.append(panel);

    hiddenPrev.focus();
    await render(
      <ProviderModelsNotice
        provider="my-provider"
        loading={false}
        failed={false}
        providerKnown
        initialRegistration
        onClose={() => {}}
        onOpenModels={() => {}}
      />,
    );
    await render(null);
    expect(document.activeElement).toBe(visibleBtn);
    hiddenAncestor.remove();

    const unmountedTrigger = document.createElement("button");
    document.body.append(unmountedTrigger);
    unmountedTrigger.focus();
    await render(
      <ProviderModelsNotice
        provider="my-provider"
        loading={false}
        failed={false}
        providerKnown
        initialRegistration
        onClose={() => {}}
        onOpenModels={() => {}}
      />,
    );
    unmountedTrigger.remove();
    await render(null);
    expect(document.activeElement).toBe(visibleBtn);
    panel.remove();
  });

  test("Providers page joins /api/providers discovery with the model snapshot and refreshes on retry", async () => {
    let discoveryPhase: "empty-failed" | "pending-failed" | "retained-failed" | "ok" = "empty-failed";
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const path = new URL(String(input), "http://localhost").pathname;
      if (path === "/api/config") {
        return Response.json({
          port: 0,
          defaultProvider: "my-provider",
          providers: {
            "my-provider": { adapter: "openai-chat", baseUrl: "https://example.test/v1", hasApiKey: true, liveModels: true },
          },
        });
      }
      if (path === "/api/oauth/providers") return Response.json({ providers: [] });
      if (path === "/api/provider-presets") return Response.json({ providers: [] });
      if (path === "/api/provider-quotas") return Response.json({ reports: [] });
      if (path === "/api/usage") return Response.json({ providers: [], models: [] });
      if (path === "/api/codex-auth/accounts") return Response.json({ accounts: [] });
      if (path === "/api/codex-auth/active") return Response.json({ activeCodexAccountId: null });
      if (path === "/api/selected-models") {
        return Response.json({
          selected: {},
          available: discoveryPhase === "empty-failed" ? {} : { "my-provider": ["model-a"] },
          liveModelCounts: {},
        });
      }
      if (path === "/api/models") {
        return Response.json(
          discoveryPhase === "empty-failed"
            ? []
            : discoveryPhase === "pending-failed"
              ? [{ provider: "my-provider", id: "model-a", namespaced: "my-provider/model-a", disabled: true, initialSelectionPending: true }]
              : [{ provider: "my-provider", id: "model-a", namespaced: "my-provider/model-a", disabled: false }],
        );
      }
      if (path === "/api/providers") {
        return Response.json([
          {
            name: "my-provider",
            adapter: "openai-chat",
            baseUrl: "https://example.test/v1",
            hasApiKey: true,
            liveModels: true,
            discovery: discoveryPhase === "ok" ? { status: "ok" } : { status: "failed", reason: "http", httpStatus: 502 },
          },
        ]);
      }
      return Response.json({});
    }) as typeof fetch;

    await render(<Providers apiBase="" />);
    await act(async () => { await new Promise(r => win.setTimeout(r, 30)); });

    const option = host.querySelector<HTMLButtonElement>('[role="option"]')!;
    await act(async () => { option.click(); });
    expect(stepState("models")).toBe("failed");
    expect(stepText("models")).toContain("502");

    const retry = () => Array.from(host.querySelectorAll<HTMLButtonElement>('[data-first-response-step="models"] button'))
      .find(b => b.textContent === "Retry")!;

    discoveryPhase = "pending-failed";
    await act(async () => { retry().click(); await new Promise(r => win.setTimeout(r, 30)); });
    expect(stepState("models")).toBe("failed");

    discoveryPhase = "retained-failed";
    await act(async () => { retry().click(); await new Promise(r => win.setTimeout(r, 30)); });
    expect(stepState("models")).toBe("ready-discovery-failed");
  });

  test("adding a provider selects it when none is open, and preserves an already open provider's dirty Settings", async () => {
    const configuredProviders: Record<string, { adapter: string; baseUrl: string; hasApiKey: boolean; liveModels: boolean }> = {
      existing: { adapter: "openai-chat", baseUrl: "https://existing.test/v1", hasApiKey: true, liveModels: false },
    };
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input), "http://localhost").pathname;
      const method = init?.method ?? "GET";
      if (path === "/api/config") {
        return Response.json({
          port: 0,
          defaultProvider: "existing",
          providers: { ...configuredProviders },
        });
      }
      if (path === "/api/providers" && method === "POST") {
        const body = JSON.parse(String(init?.body)) as { name: string };
        configuredProviders[body.name] = { adapter: "openai-chat", baseUrl: "https://new.test/v1", hasApiKey: true, liveModels: false };
        return Response.json({ ok: true });
      }
      if (path === "/api/providers") {
        return Response.json(Object.entries(configuredProviders).map(([name, p]) => ({ name, ...p })));
      }
      if (path === "/api/oauth/providers") return Response.json({ providers: [] });
      if (path === "/api/provider-presets") {
        return Response.json({ providers: [{ id: "custom", label: "Custom Provider", adapter: "openai-chat", baseUrl: "", auth: "key" }] });
      }
      if (path === "/api/provider-quotas") return Response.json({ reports: [] });
      if (path === "/api/usage") return Response.json({ providers: [], models: [] });
      if (path === "/api/codex-auth/accounts") return Response.json({ accounts: [] });
      if (path === "/api/codex-auth/active") return Response.json({ activeCodexAccountId: null });
      if (path === "/api/selected-models") return Response.json({ selected: {}, available: {}, liveModelCounts: {} });
      if (path === "/api/models") return Response.json([]);
      if (path === "/api/protocols") return Response.json({ protocols: [] });
      if (path === "/api/provider-request-pacing") return Response.json({ enabled: false, queued: 0, nextSlotInMs: 0 });
      return Response.json({});
    }) as typeof fetch;

    await render(<Providers apiBase="" />);
    await act(async () => { await new Promise(r => win.setTimeout(r, 30)); });
    expect(host.querySelector(".pws-detail-title")).toBeNull();

    const addProviderThroughModal = async (name: string) => {
      const addBtn = Array.from(host.querySelectorAll<HTMLButtonElement>(".page-head button"))
        .find(b => b.textContent?.includes("Add Provider"))!;
      await act(async () => { addBtn.click(); await new Promise(r => win.setTimeout(r, 10)); });
      const customTile = Array.from(host.querySelectorAll<HTMLButtonElement>(".modal-card button"))
        .find(b => b.textContent?.includes("custom"))!;
      await act(async () => { customTile.click(); await new Promise(r => win.setTimeout(r, 10)); });
      const inputs = host.querySelectorAll<HTMLInputElement>(".modal-card input");
      const setInputValue = (input: HTMLInputElement, val: string) => {
        Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, "value")!.set!.call(input, val);
        input.dispatchEvent(new win.Event("input", { bubbles: true }));
      };
      await act(async () => {
        setInputValue(inputs[0]!, name);
        setInputValue(inputs[1]!, "https://new.test/v1");
      });
      const submitBtn = host.querySelector<HTMLButtonElement>(".modal-card .btn-primary")!;
      await act(async () => { submitBtn.click(); await new Promise(r => win.setTimeout(r, 30)); });
      const closeNoticeBtn = Array.from(host.querySelectorAll<HTMLButtonElement>('[role="dialog"] button'))
        .find(b => b.textContent === "Close")!;
      await act(async () => { closeNoticeBtn.click(); await new Promise(r => win.setTimeout(r, 15)); });
    };

    await addProviderThroughModal("first-added");
    expect(host.querySelector(".pws-detail-title")?.textContent).toContain("First Added");
    expect(host.querySelector(".pws-detail-panel")?.contains(document.activeElement)).toBe(true);

    await act(async () => { host.querySelector<HTMLButtonElement>("#pws-tab-settings")!.click(); await new Promise(r => win.setTimeout(r, 15)); });
    const baseUrlInput = Array.from(host.querySelectorAll<HTMLInputElement>(".pws-detail-panel input"))
      .find(i => i.value === "https://new.test/v1")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, "value")!.set!.call(baseUrlInput, "https://dirty.test/v1");
      baseUrlInput.dispatchEvent(new win.Event("input", { bubbles: true }));
    });
    expect(host.textContent).toContain("unsaved changes");

    await addProviderThroughModal("second-added");
    expect(host.querySelector(".pws-detail-title")?.textContent).toContain("First Added");
    expect(host.textContent).toContain("unsaved changes");
  });

  test("discovery freshness: stays loading until /api/providers finishes and marks failed if a later /api/providers read fails", async () => {
    let releaseProviders!: (res: Response) => void;
    let pass = 0;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const path = new URL(String(input), "http://localhost").pathname;
      if (path === "/api/config") {
        return Response.json({
          port: 0,
          defaultProvider: "my-provider",
          providers: {
            "my-provider": { adapter: "openai-chat", baseUrl: "https://example.test/v1", hasApiKey: true, liveModels: true },
          },
        });
      }
      if (path === "/api/oauth/providers") return Response.json({ providers: [] });
      if (path === "/api/provider-presets") return Response.json({ providers: [] });
      if (path === "/api/provider-quotas") return Response.json({ reports: [] });
      if (path === "/api/usage") return Response.json({ providers: [], models: [] });
      if (path === "/api/codex-auth/accounts") return Response.json({ accounts: [] });
      if (path === "/api/codex-auth/active") return Response.json({ activeCodexAccountId: null });
      if (path === "/api/selected-models") {
        return Response.json({ selected: {}, available: { "my-provider": ["model-a"] }, liveModelCounts: { "my-provider": 1 } });
      }
      if (path === "/api/models") {
        return Response.json([{ provider: "my-provider", id: "model-a", namespaced: "my-provider/model-a", disabled: false }]);
      }
      if (path === "/api/providers") {
        pass++;
        return new Promise<Response>(resolve => { releaseProviders = resolve; });
      }
      return Response.json({});
    }) as typeof fetch;

    await render(<Providers apiBase="" />);
    await act(async () => { await new Promise(r => win.setTimeout(r, 20)); });

    const option = host.querySelector<HTMLButtonElement>('[role="option"]')!;
    await act(async () => { option.click(); });
    // /api/selected-models and /api/models have resolved, but /api/providers has not: must stay loading.
    expect(pass).toBe(1);
    expect(stepState("models")).toBe("loading");

    await act(async () => {
      releaseProviders(Response.json([{
        name: "my-provider",
        adapter: "openai-chat",
        baseUrl: "https://example.test/v1",
        hasApiKey: true,
        liveModels: true,
        discovery: { status: "ok" },
      }]));
      await new Promise(r => win.setTimeout(r, 20));
    });
    expect(stepState("models")).toBe("ready");
  });

  test("a failed /api/providers read marks the models step failed instead of succeeding without discovery data", async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const path = new URL(String(input), "http://localhost").pathname;
      if (path === "/api/config") {
        return Response.json({
          port: 0,
          defaultProvider: "my-provider",
          providers: {
            "my-provider": { adapter: "openai-chat", baseUrl: "https://example.test/v1", hasApiKey: true, liveModels: true },
          },
        });
      }
      if (path === "/api/oauth/providers") return Response.json({ providers: [] });
      if (path === "/api/provider-presets") return Response.json({ providers: [] });
      if (path === "/api/provider-quotas") return Response.json({ reports: [] });
      if (path === "/api/usage") return Response.json({ providers: [], models: [] });
      if (path === "/api/codex-auth/accounts") return Response.json({ accounts: [] });
      if (path === "/api/codex-auth/active") return Response.json({ activeCodexAccountId: null });
      if (path === "/api/selected-models") {
        return Response.json({ selected: {}, available: { "my-provider": ["model-a"] }, liveModelCounts: { "my-provider": 1 } });
      }
      if (path === "/api/models") {
        return Response.json([{ provider: "my-provider", id: "model-a", namespaced: "my-provider/model-a", disabled: false }]);
      }
      if (path === "/api/providers") {
        return new Response("upstream down", { status: 503 });
      }
      return Response.json({});
    }) as typeof fetch;

    await render(<Providers apiBase="" />);
    await act(async () => { await new Promise(r => win.setTimeout(r, 30)); });

    const option = host.querySelector<HTMLButtonElement>('[role="option"]')!;
    await act(async () => { option.click(); });
    expect(stepState("models")).toBe("failed");
  });
});

