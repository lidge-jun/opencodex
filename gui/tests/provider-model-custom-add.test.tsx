import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act, useEffect, useState } from "react";
import type { Root } from "react-dom/client";
import { LanguageProvider } from "../src/i18n/provider";
import ProviderModels from "../src/components/provider-workspace/ProviderModels";
import type { WorkspaceItem } from "../src/provider-workspace/catalog";
import type { ModelRow } from "../src/pages/models-shared";

const globals = ["document", "window", "navigator", "localStorage", "IS_REACT_ACT_ENVIRONMENT"] as const;
const originalFetch = globalThis.fetch;
let previousGlobals: Record<(typeof globals)[number], unknown>;
let testWindow: Window;
let root: Root | undefined;
let container: HTMLElement;
let custom: Array<{ id: string; provider: string; modelId: string }>;
let rows: ModelRow[];
let posts: Array<{ provider: string; modelId: string }>;
let postReply: ((record: { id: string; provider: string; modelId: string }) => Response) | undefined;
let getReply: (() => Response | Promise<Response>) | undefined;
let refreshes: number;
let ready: boolean;
const unmountedControl = () => { throw new Error("Provider model harness is not mounted"); };
let rerender: () => void = unmountedControl;
const committed = { status: "committed", changed: true, degraded: false, notices: [] };
const item: WorkspaceItem = { name: "AiCodeWith", adapter: "openai-chat", baseUrl: "https://example.invalid/v1", models: ["claude-opus-5"], defaultModel: "claude-opus-5" };
const row = (id: string, overrides: Partial<ModelRow> = {}): ModelRow => ({ provider: "AiCodeWith", id, namespaced: `AiCodeWith/${id}`, disabled: false, ...overrides });

beforeEach(() => {
  previousGlobals = Object.fromEntries(globals.map(key => [key, Reflect.get(globalThis, key)])) as typeof previousGlobals;
  testWindow = new Window({ url: "http://localhost/#providers/workspace" });
  Object.defineProperty(testWindow.navigator, "language", { configurable: true, value: "en-US" });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: testWindow.document },
    window: { configurable: true, value: testWindow },
    navigator: { configurable: true, value: testWindow.navigator },
    localStorage: { configurable: true, value: testWindow.localStorage },
    IS_REACT_ACT_ENVIRONMENT: { configurable: true, value: true },
  });
  custom = []; rows = [row("claude-opus-5")]; posts = []; refreshes = 0; ready = true;
  postReply = undefined; getReply = undefined;
  globalThis.fetch = (async (input, init) => {
    expect(String(input)).toBe("http://localhost:10100/api/custom-models");
    if (!init?.method || init.method === "GET") return getReply ? getReply() : Response.json(custom);
    expect(init.method).toBe("POST");
    const body = JSON.parse(String(init.body)) as { provider: string; modelId: string };
    posts.push(body);
    const record = { id: `custom-${posts.length}`, ...body };
    if (postReply) return postReply(record);
    custom.push(record);
    rows.push(row(record.modelId, { provider: record.provider, namespaced: `${record.provider}/${record.modelId}`, custom: true, customId: record.id }));
    return Response.json({ ...record, catalogRefresh: committed }, { status: 201 });
  }) as typeof fetch;
});

afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  root = undefined;
  globalThis.fetch = originalFetch;
  testWindow.close();
  for (const key of globals) Object.defineProperty(globalThis, key, { configurable: true, value: previousGlobals[key] });
});

async function mount(options: { item?: WorkspaceItem; available?: string[]; live?: boolean; selected?: string[] } = {}) {
  container = document.createElement("div"); document.body.append(container);
  const { createRoot } = await import("react-dom/client");
  function Harness() {
    const [epoch, setEpoch] = useState(0);
    useEffect(() => {
      const committedRerender = () => setEpoch(value => value + 1);
      rerender = committedRerender;
      return () => { if (rerender === committedRerender) rerender = unmountedControl; };
    }, []);
    return <ProviderModels item={options.item ?? item} availableModels={options.available ?? ["claude-opus-5"]}
      selectedModels={options.selected ?? []} hasLiveModels={options.live ?? true}
      modelRows={[...rows]} modelRevision={String(epoch)} modelRowsReady={ready}
      apiBase="http://localhost:10100" onOpenModels={() => {}}
      onRetryModels={() => { refreshes += 1; setEpoch(value => value + 1); }} />;
  }
  await act(async () => { root = createRoot(container); root.render(<LanguageProvider><Harness /></LanguageProvider>); });
}
const input = () => container.querySelector<HTMLInputElement>('input[aria-label="Add custom model"]')!;
const add = () => [...container.querySelectorAll("button")].find(button => /^(Add|Saving…)$/.test(button.textContent?.trim() ?? ""))!;
const feedback = () => [...container.querySelectorAll('[role="alert"], [role="status"]')].map(node => node.textContent).join(" ");
async function enter(value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(testWindow.HTMLInputElement.prototype, "value")!.set!.call(input(), value);
    input().dispatchEvent(new testWindow.Event("input", { bubbles: true }));
  });
}
async function submit(value: string) { await enter(value); await act(async () => { add().click(); }); }

// Successful fixtures carry the same id/provider/modelId identity as the real 201 endpoint.
test("quick-add trims, persists and refreshes exactly one definition", async () => {
  await mount(); await submit("  claude-opus-5.1  ");
  expect(posts).toEqual([{ provider: "AiCodeWith", modelId: "claude-opus-5.1" }]);
  expect(refreshes).toBe(1); expect(input().value).toBe("");
  expect(custom).toEqual([{ id: "custom-1", provider: "AiCodeWith", modelId: "claude-opus-5.1" }]);
  expect(feedback()).toContain("definition saved");
  expect(container.querySelectorAll(".pws-model-id")).toHaveLength(2);
});

test("configured and discovered ids are duplicates but a new slash id is allowed", async () => {
  await mount(); await enter("claude-opus-5"); expect(add().disabled).toBe(true);
  await enter("vendor/model"); expect(add().disabled).toBe(false); expect(posts).toEqual([]);
});

test("encoded collisions remain blocked", async () => {
  await mount({ item: { ...item, models: ["openai-gpt-5.5"], defaultModel: undefined }, available: ["openai-gpt-5.5"] });
  await enter("openai/gpt-5.5"); expect(add().disabled).toBe(true); expect(posts).toEqual([]);
});

test("a native-only DTO does not block a valid manual OpenAI override", async () => {
  rows = [row("gpt-5.5", { provider: "openai", namespaced: "gpt-5.5", native: true })];
  await mount({ item: { ...item, name: "openai", models: [], defaultModel: undefined }, available: [] });
  await enter("gpt-5.5"); expect(add().disabled).toBe(false);
  await act(async () => { add().click(); });
  expect(posts).toEqual([{ provider: "openai", modelId: "gpt-5.5" }]);
});

test("a hidden custom definition stays a duplicate and cannot be implicitly unhidden", async () => {
  custom = [{ id: "hidden-1", provider: item.name, modelId: "hidden" }];
  rows = [row("hidden", { custom: true, customId: "hidden-1", disabled: true })];
  await mount({ available: ["hidden"] }); await enter("hidden");
  expect(add().disabled).toBe(true); expect(posts).toEqual([]);
  expect(container.querySelectorAll(".pws-model-chip")).toHaveLength(0);
});

test("hidden discovered rows remain duplicate knowledge even when no chip is visible", async () => {
  rows = [row("discovered-hidden", { disabled: true })];
  await mount({ available: ["discovered-hidden"] }); await enter("discovered-hidden");
  expect(add().disabled).toBe(true); expect(posts).toEqual([]);
});

test("confirmed Add preserves independently hidden policy and reports the hidden save", async () => {
  postReply = record => {
    custom.push(record); rows = [row(record.modelId, { custom: true, customId: record.id, disabled: true })];
    return Response.json({ ...record, catalogRefresh: committed }, { status: 201 });
  };
  await mount({ selected: ["another-model"] }); await submit("new-hidden");
  expect(posts).toHaveLength(1); expect(rows[0]?.disabled).toBe(true);
  expect(container.querySelectorAll(".pws-model-chip")).toHaveLength(0);
  expect(feedback()).toContain("hidden");
});

test("409 preserves the draft and reconciliation does not erase the failure", async () => {
  postReply = () => Response.json({ error: "duplicate model" }, { status: 409 });
  await mount(); await submit("new-model");
  expect(input().value).toBe("new-model"); expect(posts).toHaveLength(1);
  expect(refreshes).toBe(1); expect(container.querySelector('[role="alert"]')).not.toBeNull();
});

for (const failure of ["missing-id", "wrong-provider", "wrong-model", "wrong-status", "invalid-json", "transport"] as const) {
  test(`unconfirmed POST (${failure}) reconciles without repeating the write`, async () => {
    postReply = record => {
      // Server can save before the client loses or rejects its response.
      custom.push(record); rows.push(row(record.modelId, { custom: true, customId: record.id }));
      if (failure === "transport") throw new Error("connection lost after commit");
      if (failure === "invalid-json") return new Response("{", { status: 201 });
      return Response.json({ ...record, catalogRefresh: committed,
        ...(failure === "missing-id" ? { id: "" } : {}),
        ...(failure === "wrong-provider" ? { provider: "other" } : {}),
        ...(failure === "wrong-model" ? { modelId: "other" } : {}),
      }, { status: failure === "wrong-status" ? 200 : 201 });
    };
    await mount(); await submit("new-model");
    expect(posts).toHaveLength(1); expect(refreshes).toBe(1);
    expect(feedback()).toContain("could not be confirmed");
    expect(add().disabled).toBe(true);
    expect(custom).toHaveLength(1);
  });
}

test("a confirmed save with unavailable catalog is not advertised as ready or automatically retried", async () => {
  postReply = record => {
    custom.push(record);
    return Response.json({ ...record, catalogRefresh: { status: "failed", reason: "disk", phase: "commit", retryable: false, partialWrite: true } }, { status: 201 });
  };
  await mount(); await submit("new-model");
  expect(posts).toHaveLength(1); expect(input().value).toBe("");
  expect(feedback()).toContain("could not be refreshed");
  expect(feedback()).toContain("Definition saved");
});

test("a successful empty inventory never revives configured fallback chips", async () => {
  rows = []; await mount({ available: [], live: false });
  expect(container.querySelectorAll(".pws-model-chip")).toHaveLength(0);
  expect(container.textContent).toContain("Manage visibility in Models");
});

test("canonical static and custom DTOs both render without live provenance", async () => {
  custom = [{ id: "custom-1", provider: item.name, modelId: "custom-only" }];
  rows.push(row("custom-only", { custom: true, customId: "custom-1" }));
  await mount({ available: ["custom-only"], live: false });
  expect([...container.querySelectorAll(".pws-model-id")].map(node => node.textContent)).toEqual(["claude-opus-5", "custom-only"]);
});

test("Add requires both current custom ownership and parent row readiness", async () => {
  let resolve!: (response: Response) => void;
  getReply = () => new Promise<Response>(done => { resolve = done; });
  ready = false; await mount(); await enter("new-model"); expect(add().disabled).toBe(true);
  await act(async () => { resolve(Response.json([])); }); expect(add().disabled).toBe(true);
  getReply = undefined; ready = true;
  await act(async () => { rerender(); }); expect(add().disabled).toBe(false);
  expect(posts).toEqual([]);
});

for (const body of [{}, [{ provider: "AiCodeWith", modelId: "bad-no-id" }], [{ id: "x", provider: "AiCodeWith", modelId: 3 }]]) {
  test(`malformed custom GET blocks Add (${JSON.stringify(body)})`, async () => {
    getReply = () => Response.json(body); await mount(); await enter("new-model");
    expect(add().disabled).toBe(true); expect(posts).toEqual([]);
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
  });
}

test("failed ownership lookup recovers through Retry in the same mount", async () => {
  getReply = () => { throw new Error("offline"); };
  await mount(); await enter("new-model"); expect(add().disabled).toBe(true);
  getReply = undefined;
  const retry = [...container.querySelectorAll("button")].find(button => button.textContent?.trim() === "Retry")!;
  expect(retry).toBeDefined(); await act(async () => { retry.click(); });
  expect(add().disabled).toBe(false); await act(async () => { add().click(); });
  expect(posts).toHaveLength(1);
});

test("a POST cannot adopt a stable id already owned by another definition", async () => {
  custom = [{ id: "occupied", provider: "other", modelId: "other-model" }];
  postReply = record => Response.json({ ...record, id: "occupied", catalogRefresh: committed }, { status: 201 });
  await mount(); await submit("new-model");
  expect(posts).toHaveLength(1); expect(feedback()).toContain("could not be confirmed");
  expect(custom).toEqual([{ id: "occupied", provider: "other", modelId: "other-model" }]);
});

test("ordinary model copy preserves the raw slash id instead of its encoded selector", async () => {
  const copied: string[] = [];
  Object.defineProperty(testWindow.navigator, "clipboard", { configurable: true,
    value: { writeText: async (text: string) => { copied.push(text); } } });
  rows = [row("vendor/model", { namespaced: "AiCodeWith/vendor-model" })];
  await mount({ available: ["vendor/model"] });
  const copy = container.querySelector<HTMLButtonElement>(".pws-model-chip-main")!;
  expect(copy.textContent).toBe("vendor/model");
  await act(async () => { copy.click(); });
  expect(copied).toEqual(["vendor/model"]);
  expect(copy.getAttribute("aria-label")).toBe("Copied!");
  expect(posts).toEqual([]);
});

for (const nativeHidden of [false, true]) {
  test(`copy disambiguates only visible same-label identities (native hidden=${nativeHidden})`, async () => {
    const copied: string[] = [];
    Object.defineProperty(testWindow.navigator, "clipboard", { configurable: true,
      value: { writeText: async (text: string) => { copied.push(text); } } });
    // The server retains account-qualified native rows alongside manual definitions.
    const raw = "account-work/gpt-5.5";
    custom = [{ id: "override", provider: "openai", modelId: raw }];
    rows = [row(raw, { provider: "openai", namespaced: raw, native: true, disabled: nativeHidden }),
      row(raw, { provider: "openai", namespaced: "openai/account-work-gpt-5.5", custom: true, customId: "override" })];
    await mount({ item: { ...item, name: "openai", models: [], defaultModel: undefined }, available: [raw] });
    const copies = [...container.querySelectorAll<HTMLButtonElement>(".pws-model-chip-main")];
    expect(copies.map(button => button.textContent)).toEqual(nativeHidden
      ? [raw] : [raw, "openai/account-work-gpt-5.5"]);
    for (const button of copies) await act(async () => { button.click(); });
    expect(copied).toEqual(nativeHidden ? [raw] : [raw, "openai/account-work-gpt-5.5"]);
    expect(posts).toEqual([]);
  });
}

test("native raw default identity gets Default without borrowing routed Selected", async () => {
  rows = [row("gpt-5.5", { provider: "openai", namespaced: "gpt-5.5", native: true }),
    row("gpt-5.6", { provider: "openai", namespaced: "gpt-5.6", native: true })];
  await mount({ item: { ...item, name: "openai", models: [], defaultModel: "gpt-5.5" },
    available: [], selected: ["gpt-5.5"] });
  const chips = [...container.querySelectorAll(".pws-model-chip")];
  expect(chips[0]?.querySelector(".pws-model-flag")?.textContent).toBe("Default");
  expect(chips[0]?.querySelector(".badge-accent")).toBeNull();
  expect(chips[1]?.querySelector(".pws-model-flag")).toBeNull();
});

for (const available of [["claude-opus-5"], []]) {
  test(`configured fallback hint depends on missing available rows, not static provenance (${available.length})`, async () => {
    await mount({ item: { ...item, liveModels: false }, available, live: false });
    expect([...container.querySelectorAll(".pws-model-id")].map(node => node.textContent)).toEqual(["claude-opus-5"]);
    const hint = "Showing configured models (live discovery unavailable).";
    if (available.length === 0) expect(container.textContent).toContain(hint);
    else expect(container.textContent).not.toContain(hint);
    expect(posts).toEqual([]);
  });
}
