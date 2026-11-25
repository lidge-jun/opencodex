import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act, StrictMode } from "react";
import type { Root } from "react-dom/client";
import { type ComboItem, providerQuotaStatesFromReports, toPutBody } from "../src/combo-workspace-data";
import ComboWorkspace from "../src/components/ComboWorkspace";
import { ComboRoutingEditor } from "../src/components/combo-workspace-fallback";
import { LanguageProvider } from "../src/i18n/provider";

const globals = ["document", "window", "navigator", "localStorage", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previousGlobals: Record<(typeof globals)[number], unknown>;
let testWindow: Window;

const combos: ComboItem[] = [
  {
    id: "alpha",
    model: "combo/alpha",
    alias: null,
    nativeAlias: false,
    displayName: null,
    strategy: "failover",
    stickyLimit: 1,
    defaultEffort: null,
    targets: [{ provider: "openai", model: "gpt-5", clientKey: "ct-a" }],
  },
  {
    id: "beta",
    model: "combo/beta",
    alias: null,
    nativeAlias: false,
    displayName: null,
    strategy: "failover",
    stickyLimit: 1,
    defaultEffort: null,
    targets: [{ provider: "openai", model: "gpt-5", clientKey: "ct-b" }],
  },
];

beforeEach(() => {
  previousGlobals = Object.fromEntries(globals.map((key) => [key, Reflect.get(globalThis, key)])) as typeof previousGlobals;
  testWindow = new Window({ url: "http://localhost/" });
  Object.defineProperty(testWindow.navigator, "language", { configurable: true, value: "en-US" });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: testWindow.document },
    window: { configurable: true, value: testWindow },
    navigator: { configurable: true, value: testWindow.navigator },
    localStorage: { configurable: true, value: testWindow.localStorage },
  });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  testWindow.close();
  for (const key of globals) {
    Object.defineProperty(globalThis, key, { configurable: true, value: previousGlobals[key] });
  }
});

async function flushTimers() {
  await act(async () => {
    await new Promise<void>((resolve) => testWindow.setTimeout(resolve, 0));
  });
}

function setInputValue(input: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(testWindow.HTMLInputElement.prototype, "value")!
    .set!.call(input, value);
  input.dispatchEvent(new testWindow.Event("input", { bubbles: true }));
}

function railButton(container: HTMLElement, model: string): HTMLButtonElement {
  const button = [...container.querySelectorAll<HTMLButtonElement>(".combos-workspace-rail-row")]
    .find((row) => row.querySelector(".combos-workspace-rail-name")?.textContent === model);
  if (!button) throw new Error(`rail row not found: ${model}`);
  return button;
}

test("Strict Mode: edit, revert, and unsaved navigation keep dirty state coherent", async () => {
  const { createRoot } = await import("react-dom/client");
  const container = document.createElement("div");
  document.body.append(container);
  let root!: Root;

  await act(async () => {
    root = createRoot(container);
    root.render(
      <StrictMode>
        <LanguageProvider>
          <ComboWorkspace
            combos={combos}
            providerQuotaStates={{ openai: "available" }}
            providers={[{ name: "openai" }]}
            models={[{ provider: "openai", id: "gpt-5" }]}
            loading={false}
            onRefresh={() => {}}
            onSave={async () => ({ ok: true })}
            onRemove={async () => ({ ok: true })}
            onAdd={() => {}}
            adding={false}
            onCloseAdd={() => {}}
            onCreated={() => {}}
          />
        </LanguageProvider>
      </StrictMode>,
    );
  });
  await flushTimers();

  await act(async () => {
    railButton(container, "combo/alpha").click();
  });
  await flushTimers();

  const aliasInput = container.querySelector<HTMLInputElement>("#cwi-edit-alias")!;
  expect(aliasInput).toBeTruthy();

  await act(async () => {
    setInputValue(aliasInput, "edited-alias");
  });
  expect(aliasInput.value).toBe("edited-alias");

  await act(async () => {
    railButton(container, "combo/beta").click();
  });
  expect(container.querySelector("#cwi-unsaved-title")).toBeTruthy();

  const keepButton = container.querySelector<HTMLButtonElement>('[data-testid="cwi-unsaved-keep"]');
  expect(keepButton).toBeTruthy();
  await act(async () => {
    keepButton!.click();
  });
  expect(container.querySelector("#cwi-unsaved-title")).toBeNull();
  expect(container.querySelector<HTMLInputElement>("#cwi-edit-alias")?.value).toBe("edited-alias");

  await act(async () => {
    railButton(container, "combo/beta").click();
  });
  expect(container.querySelector("#cwi-unsaved-title")).toBeTruthy();

  const discardButton = container.querySelector<HTMLButtonElement>('[data-testid="cwi-unsaved-discard"]');
  expect(discardButton).toBeTruthy();
  await act(async () => {
    discardButton!.click();
  });
  await flushTimers();
  expect(container.querySelector("#cwi-unsaved-title")).toBeNull();
  expect(container.querySelector(".combos-workspace-detail-title")?.textContent).toBe("combo/beta");

  await act(async () => {
    railButton(container, "combo/alpha").click();
  });
  await flushTimers();

  const aliasAgain = container.querySelector<HTMLInputElement>("#cwi-edit-alias")!;
  await act(async () => {
    setInputValue(aliasAgain, "temp");
  });
  await act(async () => {
    setInputValue(aliasAgain, "");
  });
  expect(aliasAgain.value).toBe("");

  await act(async () => {
    railButton(container, "combo/beta").click();
  });
  expect(container.querySelector("#cwi-unsaved-title")).toBeNull();
  expect(container.querySelector(".combos-workspace-detail-title")?.textContent).toBe("combo/beta");

  await act(async () => {
    root.unmount();
  });
  container.remove();
});

test("dirty Save disables for exhausted targets and re-enables on quota recovery", async () => {
  const { createRoot } = await import("react-dom/client");
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);

  const now = Date.now();
  const display = { provider: "openai", updatedAt: now,
    quota: { updatedAt: now, customWindows: [{ label: "Search", percent: 100 }] } };
  const render = (routingQuota?: Record<string, unknown>) => (
    <LanguageProvider>
      <ComboWorkspace
        combos={combos}
        providerQuotaStates={providerQuotaStatesFromReports([{ ...display, routingQuota }], now)}
        providers={[{ name: "openai" }]}
        models={[{ provider: "openai", id: "gpt-5" }]}
        loading={false}
        onRefresh={() => {}}
        onSave={async () => ({ ok: true })}
        onRemove={async () => ({ ok: true })}
        onAdd={() => {}}
        adding={false}
        onCloseAdd={() => {}}
        onCreated={() => {}}
      />
    </LanguageProvider>
  );

  await act(async () => { root.render(render({ state: "exhausted", updatedAt: now, validUntil: now + 60_000 })); });
  await flushTimers();
  await act(async () => { railButton(container, "combo/alpha").click(); });
  await flushTimers();
  await act(async () => {
    setInputValue(container.querySelector<HTMLInputElement>("#cwi-edit-alias")!, "dirty");
  });

  expect(container.querySelector<HTMLButtonElement>("#cwi-edit-save")!.disabled).toBe(true);
  expect(container.textContent).toContain("All enabled targets are out of quota");

  await act(async () => { root.render(render()); });
  expect(container.querySelector<HTMLButtonElement>("#cwi-edit-save")!.disabled).toBe(false);
  expect(container.textContent).not.toContain("All enabled targets are out of quota");

  await act(async () => { root.render(render({ state: "available", updatedAt: now, validUntil: now + 60_000 })); });
  expect(container.querySelector<HTMLButtonElement>("#cwi-edit-save")!.disabled).toBe(false);
  expect(container.textContent).not.toContain("All enabled targets are out of quota");

  await act(async () => { root.unmount(); });
  container.remove();
});

test("a save before the editor's reset never restores cleared paid-call settings", async () => {
  const { createRoot } = await import("react-dom/client");
  const container = document.createElement("div");
  document.body.append(container);
  const bodies: ReturnType<typeof toPutBody>[] = [];
  const loaded: ComboItem = {
    ...combos[0]!, id: "window", model: "combo/window", allowMeteredTargets: true,
    targets: [{ provider: "openai", model: "gpt-5", metered: true, clientKey: "ct-window" }],
  };
  const cleared: ComboItem = { ...loaded, allowMeteredTargets: undefined, targets: [{ ...loaded.targets[0]!, metered: undefined }] };
  let root!: Root;
  const render = (list: ComboItem[]) => root.render(
    <LanguageProvider>
      <ComboWorkspace
        combos={list}
        providerQuotaStates={{ openai: "available" }}
        providers={[{ name: "openai" }]}
        models={[{ provider: "openai", id: "gpt-5" }]}
        loading={false}
        onRefresh={() => {}}
        onSave={async (item, _isCreate, _renameFrom, stored) => {
          bodies.push(toPutBody(item, { stored }));
          return { ok: true };
        }}
        onRemove={async () => ({ ok: true })}
        onAdd={() => {}}
        adding={false}
        onCloseAdd={() => {}}
        onCreated={() => {}}
      />
    </LanguageProvider>,
  );
  await act(async () => { root = createRoot(container); render([loaded]); });
  await flushTimers();
  await act(async () => { railButton(container, "combo/window").click(); });
  await flushTimers();
  // The poll lands and the save follows before the editor's reset timer runs.
  await act(async () => { render([cleared]); });
  await act(async () => { container.querySelector<HTMLButtonElement>("#cwi-edit-save")!.click(); });

  expect(bodies).toHaveLength(1);
  expect(bodies[0]!.combo).not.toHaveProperty("allowMeteredTargets");
  expect(bodies[0]!.combo.targets).toEqual([{ provider: "openai", model: "gpt-5" }]);

  await act(async () => { root.unmount(); });
  container.remove();
});

test("a switch turned on right after a combo opens survives the editor's first render", async () => {
  const { createRoot } = await import("react-dom/client");
  const container = document.createElement("div");
  document.body.append(container);
  let root!: Root;
  await act(async () => {
    root = createRoot(container);
    root.render(
      <LanguageProvider>
        <ComboWorkspace
          combos={combos}
          providerQuotaStates={{ openai: "available" }}
          providers={[{ name: "openai" }]}
          models={[{ provider: "openai", id: "gpt-5" }]}
          loading={false}
          onRefresh={() => {}}
          onSave={async () => ({ ok: true })}
          onRemove={async () => ({ ok: true })}
          onAdd={() => {}}
          adding={false}
          onCloseAdd={() => {}}
          onCreated={() => {}}
        />
      </LanguageProvider>,
    );
  });
  await flushTimers();
  const quotaOnly = () => [...container.querySelectorAll<HTMLButtonElement>("[role=switch]")]
    .find(button => button.textContent?.trim() === "Switch only when quota runs out")!;
  // No timer runs between opening the combo and the click.
  await act(async () => { railButton(container, "combo/alpha").click(); });
  await act(async () => { quotaOnly().click(); });
  await flushTimers();
  expect(quotaOnly().getAttribute("aria-checked")).toBe("true");

  await act(async () => { root.unmount(); });
  container.remove();
});

test("the route preview asks again when a provider's configuration changes", async () => {
  const { createRoot } = await import("react-dom/client");
  const container = document.createElement("div");
  document.body.append(container);
  const requests: string[] = [];
  let enabled = false;
  const previousFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    requests.push(String(input));
    return Response.json({ routes: { "backup/m": enabled ? { provider: "backup", model: "m", requiresConsent: false } : null } });
  }) as typeof fetch;
  const draft: ComboItem = { ...combos[0]!, quotaOnlyFallback: true, targets: [{ provider: "backup", model: "m", clientKey: "ct-backup" }] };
  const render = (disabled: boolean) => root.render(
    <LanguageProvider>
      <ComboRoutingEditor apiBase="http://api.test" draft={draft} providers={[{ name: "backup", disabled, comboBilling: "local" }]}
        models={[{ provider: "backup", id: "m" }]} capabilityModels={[]} providerQuotaStates={{}} disabled={false} onChange={() => {}} />
    </LanguageProvider>,
  );
  const settle = () => act(async () => { await new Promise<void>(resolve => testWindow.setTimeout(resolve, 20)); });
  let root!: Root;
  try {
    await act(async () => { root = createRoot(container); render(true); });
    await settle();
    expect(container.querySelector(".cwi-preview")?.textContent).toContain("Provider unavailable");
    enabled = true;
    await act(async () => { render(false); });
    await settle();
    expect(requests).toHaveLength(2);
    expect(container.querySelector(".cwi-preview")?.textContent).not.toContain("Provider unavailable");
  } finally {
    globalThis.fetch = previousFetch;
    await act(async () => { root.unmount(); });
    container.remove();
  }
});

test("the route preview refreshes when the redirect configuration changes", async () => {
  const { createRoot } = await import("react-dom/client");
  const container = document.createElement("div");
  document.body.append(container);
  const previousFetch = globalThis.fetch;
  let destination = "old";
  let requests = 0;
  globalThis.fetch = (async () => {
    requests++;
    return Response.json({ routes: { "backup/m": { provider: "backup", model: destination, requiresConsent: false } } });
  }) as typeof fetch;
  const draft: ComboItem = { ...combos[0]!, targets: [{ provider: "backup", model: "m", clientKey: "ct-backup" }] };
  const root = createRoot(container);
  const render = (routingRevision: string) => root.render(<LanguageProvider>
    <ComboRoutingEditor apiBase="http://api.test" draft={draft} providers={[{ name: "backup" }]}
      models={[]} capabilityModels={[]} providerQuotaStates={{}} disabled={false} onChange={() => {}} routingRevision={routingRevision} />
  </LanguageProvider>);
  try {
    await act(async () => { render("old"); });
    await flushTimers();
    expect(container.querySelector(".cwi-preview")?.textContent).toContain("old");
    destination = "new";
    await act(async () => { render("new"); });
    await flushTimers();
    expect(requests).toBe(2);
    expect(container.querySelector(".cwi-preview")?.textContent).toContain("new");
  } finally {
    globalThis.fetch = previousFetch;
    await act(async () => { root.unmount(); });
    container.remove();
  }
});

test("the route preview says when it shows configured targets because routes are not checked", async () => {
  const { createRoot } = await import("react-dom/client");
  const container = document.createElement("div");
  document.body.append(container);
  let failPending!: (reason: Error) => void;
  const answers = [
    () => new Promise<Response>((_resolve, reject) => { failPending = reject; }),
    () => Promise.resolve(Response.json({ combos: [] })),
    () => Promise.resolve(Response.json({ routes: { "backup/m": { provider: "backup", model: "m", requiresConsent: false } } })),
  ];
  const previousFetch = globalThis.fetch;
  globalThis.fetch = (async () => answers.shift()!()) as unknown as typeof fetch;
  const draft: ComboItem = { ...combos[0]!, quotaOnlyFallback: true, targets: [{ provider: "backup", model: "m", clientKey: "ct-backup" }] };
  const render = (baseUrl: string) => root.render(
    <LanguageProvider>
      <ComboRoutingEditor apiBase={baseUrl} draft={draft} providers={[{ name: "backup", comboBilling: "local" }]}
        models={[{ provider: "backup", id: "m" }]} capabilityModels={[]} providerQuotaStates={{}} disabled={false} onChange={() => {}} />
    </LanguageProvider>,
  );
  const settle = () => act(async () => { await new Promise<void>(resolve => testWindow.setTimeout(resolve, 20)); });
  const note = () => container.querySelector(".cwi-preview-note")?.textContent;
  let root!: Root;
  try {
    await act(async () => { root = createRoot(container); render("http://offline.test"); });
    await settle();
    expect(note()).toContain("Routes have not been checked");
    await act(async () => { failPending(new TypeError("offline")); });
    await settle();
    expect(note()).toContain("Routes have not been checked");
    await act(async () => { render("http://older.test"); });
    await settle();
    expect(note()).toContain("Routes have not been checked");
    await act(async () => { render("http://current.test"); });
    await settle();
    expect(note()).not.toContain("Routes have not been checked");
  } finally {
    globalThis.fetch = previousFetch;
    await act(async () => { root.unmount(); });
    container.remove();
  }
});

test("a refreshed editor never restores paid-call settings the CLI cleared", async () => {
  const { createRoot } = await import("react-dom/client");
  const container = document.createElement("div");
  document.body.append(container);
  const bodies: ReturnType<typeof toPutBody>[] = [];
  const loaded: ComboItem = {
    ...combos[0]!, id: "paid", model: "combo/paid", allowMeteredTargets: true,
    targets: [{ provider: "openai", model: "gpt-5", metered: true, clientKey: "ct-paid" }],
  };
  const cleared: ComboItem = { ...loaded, allowMeteredTargets: undefined, targets: [{ ...loaded.targets[0]!, metered: undefined }] };
  const render = (list: ComboItem[]) => root.render(
    <LanguageProvider>
      <ComboWorkspace
        combos={list}
        providerQuotaStates={{ openai: "available" }}
        providers={[{ name: "openai" }]}
        models={[{ provider: "openai", id: "gpt-5" }]}
        loading={false}
        onRefresh={() => {}}
        onSave={async (item, _isCreate, _renameFrom, stored) => {
          bodies.push(toPutBody(item, { stored }));
          return { ok: true };
        }}
        onRemove={async () => ({ ok: true })}
        onAdd={() => {}}
        adding={false}
        onCloseAdd={() => {}}
        onCreated={() => {}}
      />
    </LanguageProvider>,
  );
  let root!: Root;
  await act(async () => {
    root = createRoot(container);
    render([loaded]);
  });
  await flushTimers();
  await act(async () => { railButton(container, "combo/paid").click(); });
  await flushTimers();

  // The dashboard poll returns the combo after the CLI removed its paid-call settings.
  await act(async () => { render([cleared]); });
  await flushTimers();
  await act(async () => { setInputValue(container.querySelector<HTMLInputElement>("#cwi-edit-alias")!, "renamed"); });
  await act(async () => { container.querySelector<HTMLButtonElement>("#cwi-edit-save")!.click(); });

  expect(bodies).toHaveLength(1);
  expect(bodies[0]!.combo.alias).toBe("renamed");
  expect(bodies[0]!.combo).not.toHaveProperty("allowMeteredTargets");
  expect(bodies[0]!.combo.targets).toEqual([{ provider: "openai", model: "gpt-5" }]);

  await act(async () => { root.unmount(); });
  container.remove();
});

test("remote changes merge untouched fields and retain conflicting draft edits", async () => {
  const { createRoot } = await import("react-dom/client");
  const container = document.createElement("div");
  document.body.append(container);
  const loaded = { ...combos[0]!, displayName: "original", allowMeteredTargets: true };
  const root = createRoot(container);
  const render = (item: ComboItem) => root.render(<LanguageProvider><ComboWorkspace
    combos={[item, combos[1]!]} providerQuotaStates={{ openai: "available" }}
    providers={[{ name: "openai" }]} models={[{ provider: "openai", id: "gpt-5" }]}
    loading={false} onRefresh={() => {}} onSave={async () => ({ ok: true })}
    onRemove={async () => ({ ok: true })} onAdd={() => {}} adding={false}
    onCloseAdd={() => {}} onCreated={() => {}} /></LanguageProvider>);
  try {
    await act(async () => { render(loaded); });
    await act(async () => { railButton(container, "combo/alpha").click(); });
    await act(async () => { setInputValue(container.querySelector<HTMLInputElement>("#cwi-edit-display-name")!, "my edit"); });
    await act(async () => { render({ ...loaded, allowMeteredTargets: undefined }); });
    await flushTimers();
    expect(container.querySelector<HTMLInputElement>("#cwi-edit-display-name")!.value).toBe("my edit");
    expect(container.querySelector<HTMLButtonElement>("#cwi-edit-save")!.disabled).toBe(false);
    await act(async () => { render({ ...loaded, allowMeteredTargets: undefined, displayName: "remote edit" }); });
    await flushTimers();
    expect(container.querySelector<HTMLInputElement>("#cwi-edit-display-name")!.value).toBe("my edit");
    expect(container.textContent).toContain("These fields changed on both sides");
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
  }
});

test("save adopts the server combo when refresh does not arrive", async () => {
  const { createRoot } = await import("react-dom/client");
  const container = document.createElement("div");
  document.body.append(container);
  const loaded = { ...combos[0]!, allowMeteredTargets: true };
  const root = createRoot(container);
  try {
    await act(async () => { root.render(<LanguageProvider><ComboWorkspace
      combos={[loaded]} providerQuotaStates={{ openai: "available" }} providers={[{ name: "openai" }]}
      models={[{ provider: "openai", id: "gpt-5" }]} loading={false} onRefresh={() => {}}
      onSave={async (item) => ({ ok: true, item: { ...item, allowMeteredTargets: undefined } })}
      onRemove={async () => ({ ok: true })} onAdd={() => {}} adding={false} onCloseAdd={() => {}} onCreated={() => {}} />
    </LanguageProvider>); });
    await act(async () => { railButton(container, "combo/alpha").click(); });
    await act(async () => { setInputValue(container.querySelector<HTMLInputElement>("#cwi-edit-display-name")!, "saved"); });
    await act(async () => { container.querySelector<HTMLButtonElement>("#cwi-edit-save")!.click(); });
    await flushTimers();
    const paidSwitch = [...container.querySelectorAll<HTMLButtonElement>('[role="switch"]')]
      .find(button => button.textContent?.includes("Allow paid"));
    expect(paidSwitch?.getAttribute("aria-checked") ?? "false").toBe("false");
    expect(container.querySelector<HTMLInputElement>("#cwi-edit-display-name")!.value).toBe("saved");
    expect(container.querySelector<HTMLButtonElement>("#cwi-edit-save")!.disabled).toBe(true);
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
  }
});
