import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act, useEffect } from "react";
import type { Root } from "react-dom/client";
import {
  buildComboSuggestions,
  channelTier,
  extendedCombo,
  freeComboId,
  normalizeModelName,
  orderMembers,
  suggestionDraft,
  type ChannelTier,
  type SuggestionInput,
  type SuggestionProvider,
} from "../src/combo-suggestions";
import { isValidComboId, toPutBody, type ComboItem } from "../src/combo-workspace-data";
import { ComboSuggestions, type ComboSuggestionsProps } from "../src/components/route-board/ComboSuggestions";
import { useSuggestionExclusions, type SuggestionExclusions } from "../src/components/route-board/use-suggestion-exclusions";
import { WorkspaceSuggestions } from "../src/components/route-board/WorkspaceSuggestions";
import { LanguageProvider } from "../src/i18n/provider";

const combo = (id: string, targets: Array<[string, string]>, extra: Partial<ComboItem> = {}): ComboItem => ({
  id,
  model: `combo/${id}`,
  alias: null,
  nativeAlias: false,
  displayName: null,
  strategy: "failover",
  stickyLimit: 1,
  defaultEffort: null,
  imageInput: "auto",
  reasoningEffortMode: "strict",
  targets: targets.map(([provider, model]) => ({ provider, model })),
  ...extra,
});

const PROVIDERS: SuggestionProvider[] = [
  { name: "anthropic-apikey", authMode: "key", baseUrl: "https://api.anthropic.com" },
  { name: "cursor", authMode: "oauth", baseUrl: "https://api2.cursor.sh" },
  { name: "anthropic", authMode: "oauth", baseUrl: "https://api.anthropic.com" },
  { name: "google-vertex", baseUrl: "https://aiplatform.googleapis.com" },
  { name: "google-antigravity", authMode: "oauth", baseUrl: "https://daily-cloudcode-pa.googleapis.com" },
  { name: "openai", adapter: "openai-responses", authMode: "forward", baseUrl: "https://chatgpt.com/backend-api/codex" },
  { name: "zayu-claude", authMode: "key", baseUrl: "https://relay.example" },
  { name: "qoder", authMode: "key", disabled: true },
  { name: "jev", authMode: "key", hiddenFromPicker: true },
];

const models = (rows: Array<[string, string]>) => rows.map(([provider, id]) => ({ provider, id }));
const suggest = (input: Partial<SuggestionInput> & Pick<SuggestionInput, "models">) =>
  buildComboSuggestions({ combos: [], providers: PROVIDERS, ...input });
const summary = (input: Partial<SuggestionInput> & Pick<SuggestionInput, "models">) =>
  suggest(input).map((s) => `${s.kind} ${s.comboId}: ${s.members.map((m) => m.provider).join(" > ")}`);

describe("normalizeModelName", () => {
  test("folds case, provider prefix, version dots, gaps and a trailing effort suffix", () => {
    expect(normalizeModelName("Claude-Opus-5.5")).toBe("claude-opus-5-5");
    expect(normalizeModelName("anthropic/claude-opus-5-5")).toBe("claude-opus-5-5");
    expect(normalizeModelName("deepseek-ai/DeepSeek-V4.1-Flash")).toBe("deepseek-v4-1-flash");
    expect(normalizeModelName("GPT 6.1 Sol")).toBe("gpt-6-1-sol");
    expect(normalizeModelName("gpt-6.1-sol-xhigh")).toBe("gpt-6-1-sol");
    expect(normalizeModelName("gemini_3.8__flash-low")).toBe("gemini-3-8-flash");
  });

  test("keeps snapshot dates and other variants apart", () => {
    expect(normalizeModelName("claude-opus-5-5-20260801")).not.toBe(normalizeModelName("claude-opus-5-5"));
    expect(normalizeModelName("gemini-3.8-flash-thinking")).toBe("gemini-3-8-flash-thinking");
  });

  test("max names a model, not an effort: codex-max stays apart from codex", () => {
    expect(normalizeModelName("gpt-5.1-codex-max")).toBe("gpt-5-1-codex-max");
    expect(normalizeModelName("gpt-5.1-codex-max-high")).toBe("gpt-5-1-codex-max");
    expect(suggest({ models: models([["openai", "gpt-5.1-codex"], ["cursor", "gpt-5.1-codex-max"]]) })).toEqual([]);
  });
});

describe("buildComboSuggestions", () => {
  test("suggests a model two providers serve under different spellings, once per provider", () => {
    expect(summary({
      models: models([
        ["cursor", "Gemini-3.8-Flash"],
        ["google-antigravity", "gemini-3.8-flash"],
        ["google-antigravity", "gemini-3.8-flash-high"],
        ["openai", "gpt-6-luna"],
      ]),
    })).toEqual(["create gemini-3.8-flash: google-antigravity > cursor"]);
  });

  test("custom forward gateways stay out of drafts and require consent on append", () => {
    const model = "gpt-6-luna";
    const input = {
      providers: [...PROVIDERS, { name: "gateway", adapter: "openai-responses", authMode: "forward", baseUrl: "https://gateway.example/v1" }],
      models: models([["openai", model], ["cursor", model], ["gateway", model]]),
    };
    expect(summary(input)).toEqual(["create gpt-6-luna: openai > cursor"]);
    expect(summary({ ...input, combos: [combo(model, [["openai", model], ["cursor", model]])] })).toEqual([]);
    expect(summary({ ...input, combos: [combo(model, [["openai", model], ["cursor", model]], { allowMeteredTargets: true })] }))
      .toEqual(["extend gpt-6-luna: gateway"]);
  });

  test("a sanitized forward URL cannot override the server's destination classification", () => {
    const model = "gpt-6-luna";
    const gateway = { ...PROVIDERS.find((provider) => provider.name === "openai")!, name: "gateway", canonicalOpenAiForward: false };
    expect(summary({
      providers: [...PROVIDERS, gateway],
      models: models([["openai", model], ["cursor", model], ["gateway", model]]),
    })).toEqual(["create gpt-6-luna: openai > cursor"]);
  });

  test("a model only one provider serves is no suggestion", () => {
    expect(suggest({ models: models([["openai", "gpt-6-luna"], ["openai", "gpt-6-luna-high"]]) })).toEqual([]);
  });

  test("disabled and picker-hidden providers do not count", () => {
    expect(suggest({ models: models([["anthropic", "claude-x"], ["qoder", "claude-x"], ["jev", "claude-x"]]) })).toEqual([]);
  });

  test("models hidden from the catalog still count, but suggestions with a listed member come first", () => {
    const hiddenModels = new Set(["openai/gpt-5.5", "cursor/gpt-5.5", "cursor/gpt-5.6-luna"]);
    const result = suggest({
      models: models([["openai", "gpt-5.5"], ["cursor", "gpt-5.5"], ["openai", "gpt-5.6-luna"], ["cursor", "gpt-5.6-luna"]]),
      hiddenModels,
    });
    expect(result.map((s) => [s.comboId, s.kind === "create" && s.listed])).toEqual([["gpt-5.6-luna", true], ["gpt-5.5", false]]);
  });

  test("consented extensions order subscriptions before Vertex, keys and relays", () => {
    expect(summary({
      combos: [combo("opus", [["openai", "claude-opus-5-5"]], { allowMeteredTargets: true })],
      models: models([
        ["zayu-claude", "claude-opus-5-5"],
        ["anthropic-apikey", "claude-opus-5-5"],
        ["google-vertex", "claude-opus-5-5"],
        ["cursor", "claude-opus-5.5"],
        ["anthropic", "claude-opus-5-5"],
      ]),
    })).toEqual(["extend opus: anthropic > cursor > google-vertex > zayu-claude > anthropic-apikey"]);
  });

  test("within a tier, more quota left goes first and unknown quota last", () => {
    const remaining: Record<string, number> = { anthropic: 10, "google-antigravity": 80 };
    const result = suggest({
      models: models([["cursor", "claude-sonnet-5-5"], ["anthropic", "claude-sonnet-5-5"], ["google-antigravity", "claude-sonnet-5-5"]]),
      remainingPercent: (provider) => remaining[provider],
    });
    // anthropic is the maker's own subscription, so it leads despite its lower quota.
    expect(result[0]!.members.map((m) => [m.provider, m.remainingPercent])).toEqual([
      ["anthropic", 10], ["google-antigravity", 80], ["cursor", undefined],
    ]);
  });

  test("a combo already about the model is not suggested again; a missing provider becomes an extend hint", () => {
    const combos = [combo("claude-opus-5-5", [["anthropic", "claude-opus-5-5"], ["zayu-claude", "claude-opus-5-5"]])];
    const rows = models([["anthropic", "claude-opus-5-5"], ["zayu-claude", "claude-opus-5-5"], ["cursor", "claude-opus-5.5"]]);
    expect(summary({ combos, models: rows })).toEqual(["extend claude-opus-5-5: cursor"]);
    expect(summary({ combos, models: rows.slice(0, 2) })).toEqual([]);
  });

  test("hints for existing combos come before suggestions whose members are all hidden", () => {
    const combos = [combo("gemini", [["google-antigravity", "gemini-3.8-flash"]])];
    const result = suggest({
      combos,
      models: models([["google-antigravity", "gemini-3.8-flash"], ["cursor", "gemini-3.8-flash"], ["openai", "gpt-5.5"], ["cursor", "gpt-5.5"], ["openai", "gpt-6-luna"], ["cursor", "gpt-6-luna"]]),
      hiddenModels: new Set(["openai/gpt-5.5", "cursor/gpt-5.5"]),
    });
    expect(result.map((s) => `${s.kind} ${s.comboId}`)).toEqual(["create gpt-6-luna", "extend gemini", "create gpt-5.5"]);
  });

  test("a combo whose members all serve the model covers it whatever its id", () => {
    const combos = [combo("opus", [["anthropic", "claude-opus-5-5"], ["cursor", "claude-opus-5.5"]])];
    expect(suggest({ combos, models: models([["anthropic", "claude-opus-5-5"], ["cursor", "claude-opus-5.5"]]) })).toEqual([]);
  });

  test("a mixed combo that does not name the model does not cover it", () => {
    const combos = [combo("Reviewer", [["anthropic", "claude-sonnet-5-5"], ["google-antigravity", "gemini-3.8-flash"]])];
    expect(summary({ combos, models: models([["google-antigravity", "gemini-3.8-flash"], ["cursor", "gemini-3.8-flash"]]) }))
      .toEqual(["create gemini-3.8-flash: google-antigravity > cursor"]);
  });

  test("a taken combo id or alias gets -2, -3", () => {
    const combos = [combo("gpt-5.5", [["openai", "gpt-6-luna"], ["anthropic", "claude-x"]]), combo("other", [["openai", "x"]], { alias: "gpt-5.5-2" })];
    expect(freeComboId("gpt-5.5", combos)).toBe("gpt-5.5-3");
    expect(freeComboId("GPT-5.5", [])).toBe("GPT-5.5");
    expect(suggest({ combos, models: models([["openai", "gpt-5.5"], ["cursor", "gpt-5.5"]]) })[0]!.comboId).toBe("gpt-5.5-3");
  });

  test("dismissed suggestions stay out, other ones stay in", () => {
    const rows = models([["openai", "gpt-5.5"], ["cursor", "gpt-5.5"], ["openai", "gpt-5.6-sol"], ["cursor", "gpt-5.6-sol"]]);
    const all = suggest({ models: rows });
    expect(all.map((s) => s.key)).toEqual(["create:gpt-5-5", "create:gpt-5-6-sol"]);
    expect(suggest({ models: rows, dismissed: new Set(["create:gpt-5-5"]) }).map((s) => s.comboId)).toEqual(["gpt-5.6-sol"]);
  });

  test("an excluded provider joins no suggested combo, new or existing", () => {
    const rows = models([["openai", "gpt-5.5"], ["cursor", "gpt-5.5"], ["anthropic", "claude-x"], ["cursor", "claude-x"], ["google-antigravity", "claude-x"]]);
    const excludedProviders = new Set(["cursor"]);
    expect(summary({ models: rows, excludedProviders })).toEqual(["create claude-x: anthropic > google-antigravity"]);
    const combos = [combo("claude-x", [["anthropic", "claude-x"]])];
    expect(summary({ combos, models: rows, excludedProviders })).toEqual(["extend claude-x: google-antigravity"]);
  });

  test("an existing combo whose own provider is excluded still offers the one eligible provider left", () => {
    const combos = [combo("claude-x", [["anthropic", "claude-x"]])];
    const rows = models([["anthropic", "claude-x"], ["google-antigravity", "claude-x"]]);
    expect(summary({ combos, models: rows, excludedProviders: new Set(["anthropic"]) })).toEqual(["extend claude-x: google-antigravity"]);
    expect(summary({ combos, models: rows.slice(0, 1) })).toEqual([]);
    expect(summary({ models: rows, excludedProviders: new Set(["anthropic"]) })).toEqual([]);
  });
});

describe("drafts", () => {
  test("a create draft is a failover combo with the members in the order given", () => {
    const members = orderMembers([
      { provider: "cursor", model: "gpt-5.5", tier: "subscription" },
      { provider: "openai", model: "gpt-5.5", tier: "own-subscription" },
    ]);
    const draft = suggestionDraft("gpt-5.5", members);
    expect([draft.id, draft.model, draft.strategy]).toEqual(["gpt-5.5", "combo/gpt-5.5", "failover"]);
    expect(draft.targets.map((t) => `${t.provider}/${t.model}`)).toEqual(["openai/gpt-5.5", "cursor/gpt-5.5"]);
  });

  test("extending puts a member ahead of the first lower-tier one and keeps the combo's own order", () => {
    const tiers: Record<string, ChannelTier> = { anthropic: "own-subscription", "anthropic-apikey": "metered", "zayu-claude": "metered" };
    const tierOf = (provider: string) => tiers[provider]!;
    const base = combo("opus", [["anthropic", "claude-opus-5-5"], ["zayu-claude", "claude-opus-5-5"], ["anthropic-apikey", "claude-opus-5-5"]], { allowMeteredTargets: true });
    const next = extendedCombo(base, [
      { provider: "cursor", model: "claude-opus-5.5", tier: "subscription" },
      { provider: "relay-2", model: "claude-opus-5-5", tier: "metered" },
    ], tierOf);
    expect(next.targets.map((t) => t.provider)).toEqual(["anthropic", "cursor", "zayu-claude", "anthropic-apikey", "relay-2"]);
    const relayFirst = combo("opus", [["zayu-claude", "claude-opus-5-5"], ["anthropic", "claude-opus-5-5"]]);
    expect(extendedCombo(relayFirst, [{ provider: "cursor", model: "claude-opus-5.5", tier: "subscription" }], tierOf).targets.map((t) => t.provider))
      .toEqual(["cursor", "zayu-claude", "anthropic"]);
  });

  test("tiers read the provider, not its name", () => {
    expect(channelTier({ name: "my-vertex-2", baseUrl: "https://x.example" }, "gemini-4-argon")).toBe("vertex");
    expect(channelTier({ name: "anything", adapter: "openai-responses", authMode: "forward", baseUrl: "https://chatgpt.com/backend-api/codex" }, "gpt-6-luna")).toBe("own-subscription");
    expect(channelTier({ name: "xai", authMode: "oauth", baseUrl: "https://api.x.ai/v1" }, "grok-4.7")).toBe("own-subscription");
    expect(channelTier({ name: "zed", authMode: "oauth", baseUrl: "https://cloud.zed.dev" }, "grok-4.7")).toBe("subscription");
    expect(channelTier({ name: "ollama", baseUrl: "http://localhost:11434" }, "llama")).toBe("metered");
  });
});

describe("ComboSuggestions card", () => {
  let testWindow: Window;
  let root: Root | null = null;
  let host: HTMLElement;
  const globals = ["document", "window", "navigator", "localStorage"] as const;
  let previous: Record<(typeof globals)[number], unknown>;

  beforeEach(() => {
    previous = Object.fromEntries(globals.map((key) => [key, Reflect.get(globalThis, key)])) as typeof previous;
    testWindow = new Window({ url: "http://localhost/#models/combos" });
    Object.defineProperty(testWindow.navigator, "language", { configurable: true, value: "en-US" });
    Object.defineProperties(globalThis, {
      document: { configurable: true, value: testWindow.document },
      window: { configurable: true, value: testWindow },
      navigator: { configurable: true, value: testWindow.navigator },
      localStorage: { configurable: true, value: testWindow.localStorage },
    });
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterEach(async () => {
    if (root) await act(async () => { root?.unmount(); });
    root = null;
    testWindow.close();
    for (const key of globals) Object.defineProperty(globalThis, key, { configurable: true, value: previous[key] });
  });

  const saved: Array<{ kind: string; item: ComboItem }> = [];
  const exclusionWrites: string[][] = [];
  async function render(combos: ComboItem[] = [], excluded?: string[]) {
    saved.length = 0;
    const { createRoot } = await import("react-dom/client");
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    await act(async () => {
      root!.render(
        <LanguageProvider>
          <ComboSuggestions
            combos={combos}
            models={models([["google-antigravity", "gemini-3.8-flash"], ["cursor", "gemini-3.8-flash"], ["anthropic", "claude-opus-5-5"], ["cursor", "claude-opus-5.5"]])}
            hiddenModels={new Set()}
            providers={PROVIDERS}
            remainingPercent={() => undefined}
            validate={() => null}
            errorText={() => "bad"}
            onCreate={async (item) => { saved.push({ kind: "create", item }); return { ok: true }; }}
            onExtend={async (item) => { saved.push({ kind: "extend", item }); return { ok: true }; }}
            {...(excluded ? {
              excludedProviders: excluded,
              onExcludedChange: async (next: readonly string[]) => { exclusionWrites.push([...next]); return true; },
            } : {})}
          />
        </LanguageProvider>,
      );
    });
  }
  const button = (scope: ParentNode, name: string) => {
    const found = [...scope.querySelectorAll<HTMLButtonElement>("button")]
      .find((item) => item.textContent?.trim() === name || item.getAttribute("aria-label") === name);
    if (!found) throw new Error(`button not found: ${name}`);
    return found;
  };
  const card = (title: string) => {
    const found = [...host.querySelectorAll<HTMLElement>(".rb-suggest-card")].find((item) => item.querySelector("strong")?.textContent === title);
    if (!found) throw new Error(`card not found: ${title}`);
    return found;
  };

  test("generate opens a draft; reordering and saving sends that order", async () => {
    await render();
    expect(host.querySelector(".rb-suggest-head strong")?.textContent).toBe("Suggested combos");
    const gemini = card("gemini-3.8-flash");
    expect(gemini.querySelector(".rb-order")?.textContent).toContain("→");
    await act(async () => { button(gemini, "Generate").click(); });
    const draft = gemini.querySelector<HTMLElement>(".rb-suggest-draft")!;
    await act(async () => { button(draft.querySelectorAll("li")[0]!, "Move Google Antigravity gemini-3.8-flash down").click(); });
    await act(async () => { button(draft, "Save combo").click(); });
    expect(saved.map(({ kind, item }) => [kind, item.id, item.strategy, item.targets.map((t) => t.provider)])).toEqual([
      ["create", "gemini-3.8-flash", "failover", ["cursor", "google-antigravity"]],
    ]);
  });

  test("dismiss hides the card and the choice survives a remount", async () => {
    await render();
    await act(async () => { button(card("claude-opus-5-5"), "Dismiss").click(); });
    expect(() => card("claude-opus-5-5")).toThrow();
    await act(async () => { root?.unmount(); });
    await render();
    expect(() => card("claude-opus-5-5")).toThrow();
    expect(card("gemini-3.8-flash")).toBeTruthy();
  });

  test("an existing combo missing a provider offers to add it", async () => {
    await render([combo("gemini", [["google-antigravity", "gemini-3.8-flash"]])]);
    const extend = card("gemini");
    expect(extend.textContent).toContain("can also use");
    await act(async () => { button(extend, "Add to combo").click(); });
    expect(saved.map(({ kind, item }) => [kind, item.id, item.targets.map((t) => t.provider)])).toEqual([
      ["extend", "gemini", ["google-antigravity", "cursor"]],
    ]);
  });

  test("excluding a provider is offered under the title and unticking restores it", async () => {
    exclusionWrites.length = 0;
    await render([], ["cursor"]);
    // Every suggestion here needs cursor, so only the exclusion control and the empty note show.
    expect(host.querySelectorAll(".rb-suggest-card")).toHaveLength(0);
    const toggle = button(host, "Excluded: Cursor");
    await act(async () => { toggle.click(); });
    const panel = host.querySelector<HTMLElement>(".rb-suggest-exclude-panel")!;
    const cursor = panel.querySelector<HTMLInputElement>("input[type=checkbox]:checked")!;
    await act(async () => { cursor.click(); });
    expect(exclusionWrites).toEqual([[]]);
  });

  test("excluding a provider while its draft is open drops it from the draft", async () => {
    const { createRoot } = await import("react-dom/client");
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    const view = (excluded: string[]) => (
      <LanguageProvider>
        <ComboSuggestions
          combos={[]}
          models={models([["google-antigravity", "gemini-3.8-flash"], ["cursor", "gemini-3.8-flash"], ["anthropic", "gemini-3.8-flash"]])}
          hiddenModels={new Set()}
          providers={PROVIDERS}
          remainingPercent={() => undefined}
          validate={() => null}
          errorText={() => "bad"}
          onCreate={async () => ({ ok: true })}
          onExtend={async () => ({ ok: true })}
          excludedProviders={excluded}
          onExcludedChange={async () => true}
        />
      </LanguageProvider>
    );
    await act(async () => { root!.render(view([])); });
    await act(async () => { button(card("gemini-3.8-flash"), "Generate").click(); });
    const draftProviders = () => [...card("gemini-3.8-flash").querySelectorAll(".rb-suggest-draft li")].map((row) => row.textContent ?? "");
    expect(draftProviders().some((row) => row.includes("Cursor"))).toBe(true);
    await act(async () => { root!.render(view(["cursor"])); });
    expect(draftProviders().length).toBe(2);
    expect(draftProviders().some((row) => row.includes("Cursor"))).toBe(false);
  });

  async function mount(node: React.ReactNode) {
    const { createRoot } = await import("react-dom/client");
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    await act(async () => { root!.render(node); });
  }
  const sonnet = (overrides: Partial<ComboSuggestionsProps>) => (
    <LanguageProvider>
      <ComboSuggestions
        combos={[]}
        models={models([["cursor", "claude-sonnet-5-5"], ["google-antigravity", "claude-sonnet-5-5"]])}
        hiddenModels={new Set()}
        providers={PROVIDERS}
        remainingPercent={() => undefined}
        validate={() => null}
        errorText={() => "bad"}
        onCreate={async () => ({ ok: true })}
        onExtend={async () => ({ ok: true })}
        {...overrides}
      />
    </LanguageProvider>
  );

  test("quota reordering the same members keeps an open draft's edits", async () => {
    const leading = (first: string) => (provider: string) => (provider === first ? 90 : 10);
    await mount(sonnet({ remainingPercent: leading("cursor") }));
    await act(async () => { button(card("claude-sonnet-5-5"), "Generate").click(); });
    const draft = () => card("claude-sonnet-5-5").querySelector<HTMLElement>(".rb-suggest-draft")!;
    const idInput = () => draft().querySelector<HTMLInputElement>("input.rb-suggest-id")!;
    await act(async () => {
      const setValue = Object.getOwnPropertyDescriptor(testWindow.HTMLInputElement.prototype, "value")!.set!;
      setValue.call(idInput(), "my-sonnet");
      idInput().dispatchEvent(new testWindow.Event("input", { bubbles: true }) as unknown as Event);
    });
    await act(async () => { button(draft().querySelectorAll("li")[0]!, "Move Cursor claude-sonnet-5-5 down").click(); });
    await act(async () => { root!.render(sonnet({ remainingPercent: leading("google-antigravity") })); });
    expect(idInput().value).toBe("my-sonnet");
    expect([...draft().querySelectorAll("li code")].length).toBe(2);
    expect(draft().querySelectorAll("li")[0]!.textContent).toContain("Google Antigravity");
  });

  test("adding to a combo with unsaved workspace edits is held", async () => {
    const extended: string[] = [];
    const existing = [combo("gemini", [["google-antigravity", "gemini-3.8-flash"]])];
    const view = (locked: string | null) => sonnet({
      combos: existing,
      models: models([["google-antigravity", "gemini-3.8-flash"], ["cursor", "gemini-3.8-flash"]]),
      onExtend: async (item) => { extended.push(item.id); return { ok: true }; },
      lockedComboId: locked,
    });
    await mount(view("gemini"));
    const add = button(card("gemini"), "Add to combo");
    expect(add.disabled).toBe(true);
    await act(async () => { add.click(); });
    expect(extended).toEqual([]);
    await act(async () => { root!.render(view(null)); });
    await act(async () => { button(card("gemini"), "Add to combo").click(); });
    expect(extended).toEqual(["gemini"]);
  });

  test("changing proxy hides the old list and blocks writes until the new list loads", async () => {
    const realFetch = globalThis.fetch;
    const pending: Array<(body: unknown) => void> = [];
    const puts: unknown[] = [];
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      if (init?.method === "PUT") {
        const body = JSON.parse(String(init.body));
        puts.push(body);
        return new Response(JSON.stringify(body));
      }
      return new Promise<Response>((resolve) => pending.push((body) => resolve(new Response(JSON.stringify(body)))));
    }) as typeof fetch;
    try {
      let state: SuggestionExclusions | null = null;
      const Probe = ({ base }: { base: string }) => {
        const exclusions = useSuggestionExclusions(base);
        useEffect(() => { state = exclusions; }, [exclusions]);
        return null;
      };
      await mount(<Probe base="" />);
      expect(state!.ready).toBe(false);
      await act(async () => { pending.shift()!({ excludedProviders: ["anthropic"] }); });
      expect([state!.ready, state!.excluded]).toEqual([true, ["anthropic"]]);

      await act(async () => { root!.render(<Probe base="/x" />); });
      expect([state!.ready, state!.excluded]).toEqual([false, []]);
      expect(await state!.save(["cursor"])).toBe(false);
      expect(puts).toEqual([]);
      await act(async () => { pending.shift()!({ excludedProviders: ["relay"] }); });
      await act(async () => { await state!.save(["cursor"]); });
      expect(puts).toEqual([{ excludedProviders: ["cursor"] }]);
      expect(state!.excluded).toEqual(["cursor"]);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test("new cards and drafts omit paid Vertex and API-key members", async () => {
    const name = "claude-opus-5-5";
    await mount(<LanguageProvider><ComboSuggestions
      combos={[]} models={models(["anthropic", "cursor", "google-vertex", "anthropic-apikey"].map((provider) => [provider, name]))}
      providers={PROVIDERS} hiddenModels={new Set()} remainingPercent={() => undefined}
      validate={() => null} errorText={() => "bad"}
      onCreate={async () => ({ ok: true })} onExtend={async () => ({ ok: true })}
    /></LanguageProvider>);
    const suggestion = card(name);
    expect(suggestion.querySelectorAll(".rb-order-item")).toHaveLength(2);
    await act(async () => { button(suggestion, "Generate").click(); });
    expect(suggestion.querySelectorAll(".rb-suggest-members li")).toHaveLength(2);
  });

  test("revoked metered consent blocks Add to combo and shows an error", async () => {
    const originalFetch = globalThis.fetch;
    const name = "claude-opus-5-5";
    const existing = combo("opus", [["anthropic", name]], { allowMeteredTargets: true });
    let refreshCount = 0;
    let exclusionReads = 0;
    globalThis.fetch = (async (url: string) => {
      if (url.endsWith("/api/combo-suggestions/save")) {
        return Response.json({ code: "suggestion_consent_required" }, { status: 409 });
      }
      exclusionReads += 1;
      return Response.json({ excludedProviders: exclusionReads > 1 ? ["google-vertex"] : [] });
    }) as typeof fetch;
    try {
      await mount(<LanguageProvider><WorkspaceSuggestions
        active apiBase="/test" combos={[existing]} providers={PROVIDERS}
        models={models([["anthropic", name], ["google-vertex", name]])}
        quotaReports={null} quotaNow={0} lockedComboId={null}
        onRefresh={() => { refreshCount += 1; }}
      /></LanguageProvider>);
      const extension = card("opus");
      expect(extension.textContent).toContain("Vertex");
      await act(async () => { button(extension, "Add to combo").click(); });
      expect(host.querySelector('[role="alert"]')?.textContent).toContain("Suggestion settings changed");
      expect(host.textContent).not.toContain("Add to combo");
      expect(refreshCount).toBe(1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("failed exclusions hide actions until a successful retry", async () => {
    const originalFetch = globalThis.fetch;
    const pending: Array<(response: Response) => void> = [];
    globalThis.fetch = (() => new Promise<Response>((resolve) => pending.push(resolve))) as typeof fetch;
    try {
      await mount(<LanguageProvider><WorkspaceSuggestions
        active apiBase="/test" combos={[]} providers={PROVIDERS}
        models={models([["anthropic", "claude-x"], ["cursor", "claude-x"]])}
        quotaReports={null} quotaNow={0} lockedComboId={null} onRefresh={() => {}}
      /></LanguageProvider>);
      const visibleButtons = () => [...host.querySelectorAll("button")].map((item) => item.textContent?.trim());
      expect(visibleButtons()).not.toContain("Generate");
      await act(async () => { pending.shift()!(new Response(null, { status: 500 })); });
      expect(visibleButtons()).not.toContain("Generate");
      expect(host.querySelector('[role="alert"]')?.textContent).toContain("Could not load");
      await act(async () => { button(host, "Retry").click(); });
      await act(async () => { pending.shift()!(Response.json({ excludedProviders: [] })); });
      expect(visibleButtons()).toContain("Generate");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("after dismissing the last card the exclusion control still works", async () => {
    exclusionWrites.length = 0;
    await render([], []);
    await act(async () => { button(card("claude-opus-5-5"), "Dismiss").click(); });
    await act(async () => { button(card("gemini-3.8-flash"), "Dismiss").click(); });
    expect(host.querySelectorAll(".rb-suggest-card")).toHaveLength(0);
    await act(async () => { button(host, "Exclude providers…").click(); });
    await act(async () => { host.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click(); });
    expect(exclusionWrites[0]).toHaveLength(1);
  });

  test("without an exclusion handler there is no exclude control", async () => {
    await render();
    expect(host.querySelector(".rb-suggest-exclude")).toBeNull();
  });
});

test("generated ids remain valid when a long model name collides", () => {
  const base = "a".repeat(64);
  const generated = freeComboId(base + "b", [combo(base, [])]);
  expect(isValidComboId(generated)).toBe(true);
  expect(generated).toBe("a".repeat(62) + "-2");
});

test("another model on the same provider does not hide a missing channel", () => {
  const name = "claude-opus-5-5";
  const [suggestion] = suggest({
    combos: [combo(name, [["anthropic", name], ["cursor", "gpt-6-luna"]])],
    models: models([["anthropic", name], ["cursor", name]]),
  });
  expect(suggestion?.kind).toBe("extend");
  expect(suggestion?.members.map(({ provider, model }) => [provider, model])).toEqual([["cursor", name]]);
});

test("only consented extensions serialize paid targets, without writing consent", () => {
  const member = { provider: "google-vertex", model: "claude-opus-5-5", tier: "vertex" } as const;
  expect(suggestionDraft("opus", [member]).targets).toEqual([]);
  const current = combo("opus", [["anthropic", member.model]]);
  expect(extendedCombo(current, [member], () => "own-subscription").targets).toEqual(current.targets);
  const body = toPutBody(extendedCombo({ ...current, allowMeteredTargets: true }, [member], () => "own-subscription")).combo;
  expect(body.targets.map(({ metered }) => metered)).toEqual([undefined, true]);
  expect(body).not.toHaveProperty("allowMeteredTargets");
});
