import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { jevAutoCreateHash } from "../src/app-routing";
import ComboWorkspace from "../src/components/ComboWorkspace";
import ProviderDetails from "../src/components/provider-workspace/ProviderDetails";
import { navigateHash } from "../src/hash-routing";
import { LanguageProvider } from "../src/i18n/provider";
import Combos from "../src/pages/Combos";
import type { ComboItem } from "../src/combo-workspace-data";

const globals = ["document", "window", "navigator", "localStorage", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previousGlobals: Record<(typeof globals)[number], unknown>;
let originalFetch: typeof globalThis.fetch;
let testWindow: Window;
let root: Root | null;

const models = [
  { provider: "openai", id: "gpt-6-astra", reasoningEfforts: ["medium", "high"] },
  { provider: "openai", id: "gpt-5.6-sol", reasoningEfforts: ["low", "medium"] },
  { provider: "openai", id: "gpt-5.6-luna", reasoningEfforts: ["low"] },
];
const providers = [
  { name: "openai", adapter: "openai-responses" },
  { name: "jev", adapter: "jev-decision", baseUrl: "https://api.typesafe.ai/v1/systemone", hiddenFromPicker: true },
  { name: "tev-local", adapter: "jev-decision", baseUrl: "http://127.0.0.1:11434/v1/systemone", defaultModel: "tev1:4b", hiddenFromPicker: true },
  { name: "tev-off", adapter: "jev-decision", baseUrl: "http://127.0.0.1:11435/v1/systemone", defaultModel: "tev1:4b", disabled: true, hiddenFromPicker: true },
];

beforeEach(() => {
  previousGlobals = Object.fromEntries(globals.map(key => [key, Reflect.get(globalThis, key)])) as typeof previousGlobals;
  originalFetch = globalThis.fetch;
  testWindow = new Window({ url: "http://localhost/#providers/tev-local" });
  Object.defineProperty(testWindow.navigator, "language", { configurable: true, value: "en-US" });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: testWindow.document },
    window: { configurable: true, value: testWindow },
    navigator: { configurable: true, value: testWindow.navigator },
    localStorage: { configurable: true, value: testWindow.localStorage },
  });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  root = null;
});

afterEach(async () => {
  if (root) await act(async () => { root?.unmount(); });
  Object.defineProperty(globalThis, "fetch", { configurable: true, value: originalFetch });
  testWindow.close();
  for (const key of globals) {
    Object.defineProperty(globalThis, key, { configurable: true, value: previousGlobals[key] });
  }
});

async function flush(rounds = 3) {
  await act(async () => {
    for (let index = 0; index < rounds; index += 1) {
      await new Promise(resolve => setTimeout(resolve, 0));
    }
  });
}

function setSelect(select: HTMLSelectElement, value: string) {
  Object.getOwnPropertyDescriptor(testWindow.HTMLSelectElement.prototype, "value")!
    .set!.call(select, value);
  select.dispatchEvent(new testWindow.Event("change", { bubbles: true }));
}

function setInput(input: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(testWindow.HTMLInputElement.prototype, "value")!
    .set!.call(input, value);
  input.dispatchEvent(new testWindow.Event("input", { bubbles: true }));
}

function button(host: HTMLElement, text: string): HTMLButtonElement | undefined {
  return [...host.querySelectorAll<HTMLButtonElement>("button")]
    .find(candidate => candidate.textContent?.trim() === text);
}

test("a keyless self-hosted decision row creates JEV Auto with itself as the decision service", async () => {
  const { createRoot } = await import("react-dom/client");
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);

  await act(async () => {
    root!.render(
      <LanguageProvider>
        <ProviderDetails
          item={{
            name: "tev-local",
            adapter: "jev-decision",
            baseUrl: "http://127.0.0.1:11434/v1/systemone",
            authMode: "key",
            hasApiKey: false,
          }}
          availableModels={[]}
          hasLiveModels={false}
          selectedModels={[]}
          modelRows={[]}
          modelRevision="tev-test"
          modelRowsReady
          onOpenModels={() => {}}
          onCreateJevAuto={() => navigateHash(jevAutoCreateHash("tev-local"))}
          onDeselect={() => {}}
          apiBase=""
        />
      </LanguageProvider>,
    );
  });
  const providerAction = button(host, "Create JEV Auto");
  expect(providerAction).toBeDefined();
  await act(async () => { providerAction!.click(); });
  expect(window.location.hash).toBe("#models/combos/jev-auto?decisionProvider=tev-local");

  await act(async () => { root!.unmount(); });
  root = createRoot(host);

  const puts: Array<{ combo: Record<string, unknown> }> = [];
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/api/combos") && init?.method === "PUT") {
        puts.push(JSON.parse(String(init.body)));
        return Response.json({ success: true });
      }
      if (url.endsWith("/api/combos")) return Response.json({ combos: [] });
      if (url.endsWith("/api/config")) {
        return Response.json({
          providers: Object.fromEntries(providers.map(({ name, adapter, baseUrl, defaultModel, disabled }) => [
            name,
            { adapter, baseUrl: baseUrl ?? "", ...(defaultModel ? { defaultModel } : {}), ...(disabled ? { disabled } : {}) },
          ])),
        });
      }
      if (url.endsWith("/api/models")) return Response.json(models);
      if (url.endsWith("/api/provider-quotas")) return Response.json({ reports: [] });
      throw new Error(`unexpected request: ${url}`);
    },
  });

  await act(async () => {
    root!.render(<LanguageProvider><Combos apiBase="" /></LanguageProvider>);
  });
  await flush(6);

  const dialog = host.querySelector<HTMLDialogElement>('dialog[data-combo-preset="jev-auto"]');
  expect(dialog).not.toBeNull();
  // The deep-linked row selects the System One method; the select lists only server rows.
  expect(host.querySelector("#cwi-new-decision-method-systemone")?.getAttribute("aria-pressed")).toBe("true");
  const service = host.querySelector<HTMLSelectElement>("#cwi-new-decision-provider")!;
  expect(service.value).toBe("tev-local");
  expect([...service.options].map(option => [option.value, option.textContent, option.disabled])).toEqual([
    ["tev-local", "tev-local", false],
    // A disabled decision row is listed with its reason but cannot be picked.
    ["tev-off", "tev-off (disabled)", true],
  ]);
  expect(service.getAttribute("aria-describedby")).toBe("cwi-new-decision-provider-hint");
  expect(host.querySelector("#cwi-new-decision-provider-hint")?.textContent).toContain("Self-hosted decision service");
  expect(dialog!.textContent).toContain("http://127.0.0.1:11434/v1/systemone");
  const timeout = host.querySelector<HTMLInputElement>("#cwi-new-decision-timeout")!;
  expect(timeout.placeholder).toBe("4000");
  expect(timeout.getAttribute("aria-describedby")).toBe("cwi-new-decision-timeout-hint");
  expect(host.querySelector("#cwi-new-decision-timeout-hint")?.textContent).toContain("4000 ms");

  // Below the floor: the dialog explains the bounds and nothing is sent.
  await act(async () => { setInput(timeout, "999"); });
  await act(async () => { button(host, "Create combo")!.click(); });
  await flush();
  expect(dialog!.querySelector(".notice-err")?.textContent)
    .toBe("Decision timeout must be an integer from 1000 to 120000 ms, or empty for the default.");
  expect(puts).toHaveLength(0);

  await act(async () => { setInput(timeout, "60000"); });

  await act(async () => { button(host, "Create combo")!.click(); });
  await flush();

  expect(puts).toHaveLength(1);
  expect(puts[0]!.combo).toMatchObject({ strategy: "jev", decisionProvider: "tev-local", decisionTimeoutMs: 60000 });
});

test("the overview names each JEV combo's service; the editor clears it and hides it off JEV", async () => {
  const { createRoot } = await import("react-dom/client");
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  const combo: ComboItem = {
    id: "tev-auto",
    model: "combo/tev-auto",
    alias: null,
    nativeAlias: false,
    displayName: null,
    strategy: "jev",
    stickyLimit: 1,
    defaultEffort: null,
    decisionProvider: "tev-local",
    decisionTimeoutMs: 30000,
    targets: [{ provider: "openai", model: "gpt-6-astra", clientKey: "t1" }],
  };
  const saved: ComboItem[] = [];

  await act(async () => {
    root!.render(
      <LanguageProvider>
        <ComboWorkspace
          combos={[combo]}
          providerQuotaStates={{}}
          providers={providers}
          models={models}
          loading={false}
          onRefresh={() => {}}
          onSave={async (item) => { saved.push(item); return { ok: true }; }}
          onRemove={async () => ({ ok: true })}
          onAdd={() => {}}
          adding={false}
          onCloseAdd={() => {}}
          onCreated={() => {}}
        />
      </LanguageProvider>,
    );
  });

  const row = host.querySelector<HTMLButtonElement>('[data-decision-provider="tev-local"]');
  expect(row?.textContent).toContain("tev-local");
  expect(row?.textContent).toContain("http://127.0.0.1:11434/v1/systemone");
  expect(row?.textContent).toContain("Timeout 30000 ms");
  await act(async () => { row!.click(); });
  await flush(); // the detail panel syncs its draft from the baseline on a zero-delay timer

  const service = host.querySelector<HTMLSelectElement>("#cwi-edit-decision-provider")!;
  expect(service.value).toBe("tev-local");
  expect(host.querySelector<HTMLInputElement>("#cwi-edit-decision-timeout")!.value).toBe("30000");

  // Switching to TypeSafe is a method choice; the server select goes away with it.
  await act(async () => { host.querySelector<HTMLButtonElement>("#cwi-edit-decision-method-typesafe")!.click(); });
  expect(host.querySelector("#cwi-edit-decision-provider")).toBeNull();
  expect(host.querySelector("#cwi-edit-decision-method-typesafe")?.getAttribute("aria-pressed")).toBe("true");
  await act(async () => { setInput(host.querySelector<HTMLInputElement>("#cwi-edit-decision-timeout")!, ""); });
  expect(host.textContent).toContain("The hosted TypeSafe decision service");
  await act(async () => { host.querySelector<HTMLButtonElement>("#cwi-edit-save")!.click(); });
  await flush();
  expect(saved.at(-1)).toMatchObject({ decisionProvider: null, decisionModel: null, decisionTimeoutMs: null });

  const failover = [...host.querySelectorAll<HTMLButtonElement>('[role="radio"]')]
    .find(candidate => candidate.textContent?.trim() === "Failover")!;
  await act(async () => { failover.click(); });
  expect(host.querySelector("#cwi-edit-decision-provider")).toBeNull();
  expect(host.querySelector("#cwi-edit-decision-timeout")).toBeNull();
});

test("a stored decision service that is gone stays selected with its reason and blocks Save", async () => {
  const { createRoot } = await import("react-dom/client");
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  const saved: ComboItem[] = [];
  const combo: ComboItem = {
    id: "stale",
    model: "combo/stale",
    alias: null,
    nativeAlias: false,
    displayName: null,
    strategy: "jev",
    stickyLimit: 1,
    defaultEffort: null,
    decisionProvider: "gone",
    targets: [{ provider: "openai", model: "gpt-6-astra", clientKey: "t1" }],
  };

  await act(async () => {
    root!.render(
      <LanguageProvider>
        <ComboWorkspace
          combos={[combo]}
          providerQuotaStates={{}}
          providers={providers}
          models={models}
          loading={false}
          onRefresh={() => {}}
          onSave={async (item) => { saved.push(item); return { ok: true }; }}
          onRemove={async () => ({ ok: true })}
          onAdd={() => {}}
          adding={false}
          onCloseAdd={() => {}}
          onCreated={() => {}}
        />
      </LanguageProvider>,
    );
  });
  await act(async () => { host.querySelector<HTMLButtonElement>('[data-decision-provider="gone"]')!.click(); });
  await flush();

  const service = host.querySelector<HTMLSelectElement>("#cwi-edit-decision-provider")!;
  // Opening the editor never rewrites the stored id.
  expect(service.value).toBe("gone");
  const stored = [...service.options].find(option => option.value === "gone")!;
  expect(stored.textContent).toBe("gone (not configured)");
  expect(stored.disabled).toBe(false);
  expect(service.getAttribute("aria-invalid")).toBe("true");
  expect(service.getAttribute("aria-describedby"))
    .toBe("cwi-edit-decision-provider-hint cwi-edit-decision-provider-issue");
  expect(host.querySelector("#cwi-edit-decision-provider-issue")?.textContent)
    .toBe("Decision service gone can't be used (not configured). Choose another service or TypeSafe JEV.");

  // Make the draft dirty with an unrelated edit; Save must stop before calling the API.
  await act(async () => { setInput(host.querySelector<HTMLInputElement>("#cwi-edit-decision-timeout")!, "5000"); });
  await act(async () => { host.querySelector<HTMLButtonElement>("#cwi-edit-save")!.click(); });
  await flush();
  expect(saved).toHaveLength(0);
  expect(host.querySelector(".notice-err")?.textContent)
    .toBe("Decision service gone can't be used (not configured). Choose another service or TypeSafe JEV.");

  await act(async () => { setSelect(service, "tev-local"); });
  await act(async () => { host.querySelector<HTMLButtonElement>("#cwi-edit-save")!.click(); });
  await flush();
  expect(saved.at(-1)).toMatchObject({ decisionProvider: "tev-local", decisionTimeoutMs: 5000 });
});

test("a deep link naming an unusable decision row falls back to TypeSafe", async () => {
  const { createRoot } = await import("react-dom/client");
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  navigateHash(jevAutoCreateHash("tev-off"));
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/api/combos")) return Response.json({ combos: [] });
      if (url.endsWith("/api/config")) {
        return Response.json({
          providers: Object.fromEntries(providers.map(({ name, adapter, baseUrl, defaultModel, disabled }) => [
            name,
            { adapter, baseUrl: baseUrl ?? "", ...(defaultModel ? { defaultModel } : {}), ...(disabled ? { disabled } : {}) },
          ])),
        });
      }
      if (url.endsWith("/api/models")) return Response.json(models);
      if (url.endsWith("/api/provider-quotas")) return Response.json({ reports: [] });
      throw new Error(`unexpected request: ${url}`);
    },
  });

  await act(async () => {
    root!.render(<LanguageProvider><Combos apiBase="" /></LanguageProvider>);
  });
  await flush(6);

  expect(host.querySelector('dialog[data-combo-preset="jev-auto"]')).not.toBeNull();
  expect(host.querySelector("#cwi-new-decision-provider")).toBeNull();
  expect(host.querySelector("#cwi-new-decision-method-typesafe")?.getAttribute("aria-pressed")).toBe("true");
});

test("the model method saves an opencodex route and refuses this combo's own selector", async () => {
  const { createRoot } = await import("react-dom/client");
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  const jevCombo: ComboItem = {
    id: "tev-auto",
    model: "router",
    alias: "router",
    nativeAlias: false,
    displayName: null,
    strategy: "jev",
    stickyLimit: 1,
    defaultEffort: null,
    targets: [{ provider: "openai", model: "gpt-6-astra", clientKey: "t1" }],
  };
  const coding: ComboItem = {
    id: "coding",
    model: "combo/coding",
    alias: null,
    nativeAlias: false,
    displayName: null,
    strategy: "failover",
    stickyLimit: 1,
    defaultEffort: null,
    targets: [{ provider: "openai", model: "gpt-5.6-sol", clientKey: "t2" }],
  };
  const saved: ComboItem[] = [];

  await act(async () => {
    root!.render(
      <LanguageProvider>
        <ComboWorkspace
          combos={[jevCombo, coding]}
          providerQuotaStates={{}}
          providers={providers}
          models={models}
          loading={false}
          onRefresh={() => {}}
          onSave={async (item) => { saved.push(item); return { ok: true }; }}
          onRemove={async () => ({ ok: true })}
          onAdd={() => {}}
          adding={false}
          onCloseAdd={() => {}}
          onCreated={() => {}}
        />
      </LanguageProvider>,
    );
  });
  await act(async () => { host.querySelector<HTMLButtonElement>('[data-decision-provider="jev"]')!.click(); });
  await flush();

  await act(async () => { host.querySelector<HTMLButtonElement>("#cwi-edit-decision-method-model")!.click(); });
  expect(host.querySelector("#cwi-edit-decision-provider")).toBeNull();
  const input = host.querySelector<HTMLInputElement>("#cwi-edit-decision-model")!;
  expect(input.getAttribute("aria-describedby")).toBe("cwi-edit-decision-model-hint");
  const routes = [...host.querySelectorAll<HTMLOptionElement>("#cwi-edit-decision-model-options option")]
    .map(option => option.value);
  // Enabled models and non-JEV combos are offered; this JEV combo's own selectors are not.
  expect(routes).toContain("openai/gpt-6-astra");
  expect(routes).toContain("combo/coding");
  expect(routes).not.toContain("combo/tev-auto");
  expect(routes).not.toContain("router");

  await act(async () => { setInput(input, "openai/gpt-5.6-luna"); });
  await act(async () => { host.querySelector<HTMLButtonElement>("#cwi-edit-save")!.click(); });
  await flush();
  expect(saved.at(-1)).toMatchObject({ decisionModel: "openai/gpt-5.6-luna", decisionProvider: null });

  const count = saved.length;
  await act(async () => { setInput(host.querySelector<HTMLInputElement>("#cwi-edit-decision-model")!, "router"); });
  await act(async () => { host.querySelector<HTMLButtonElement>("#cwi-edit-save")!.click(); });
  await flush();
  expect(saved).toHaveLength(count);
  expect(host.querySelector(".notice-err")?.textContent)
    .toBe("Choose a decision model opencodex can route. It cannot be this combo or another JEV combo.");
});
