import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
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
import type { ComboItem } from "../src/combo-workspace-data";
import { ComboSuggestions } from "../src/components/route-board/ComboSuggestions";
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
  { name: "openai", authMode: "forward", baseUrl: "https://chatgpt.com/backend-api/codex" },
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

  test("orders members: maker's subscription, other subscriptions, Vertex, then keys and relays", () => {
    expect(summary({
      models: models([
        ["zayu-claude", "claude-opus-5-5"],
        ["anthropic-apikey", "claude-opus-5-5"],
        ["google-vertex", "claude-opus-5-5"],
        ["cursor", "claude-opus-5.5"],
        ["anthropic", "claude-opus-5-5"],
      ]),
    })).toEqual(["create claude-opus-5-5: anthropic > cursor > google-vertex > zayu-claude > anthropic-apikey"]);
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
    const rows = models([["openai", "gpt-5.5"], ["cursor", "gpt-5.5"], ["anthropic", "claude-x"], ["cursor", "claude-x"], ["zayu-claude", "claude-x"]]);
    const excludedProviders = new Set(["cursor"]);
    expect(summary({ models: rows, excludedProviders })).toEqual(["create claude-x: anthropic > zayu-claude"]);
    const combos = [combo("claude-x", [["anthropic", "claude-x"]])];
    expect(summary({ combos, models: rows, excludedProviders })).toEqual(["extend claude-x: zayu-claude"]);
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
    const base = combo("opus", [["anthropic", "claude-opus-5-5"], ["zayu-claude", "claude-opus-5-5"], ["anthropic-apikey", "claude-opus-5-5"]]);
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
    expect(channelTier({ name: "anything", authMode: "forward", baseUrl: "https://chatgpt.com" }, "gpt-6-luna")).toBe("own-subscription");
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
          models={models([["google-antigravity", "gemini-3.8-flash"], ["cursor", "gemini-3.8-flash"], ["google-vertex", "gemini-3.8-flash"]])}
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

  test("without an exclusion handler there is no exclude control", async () => {
    await render();
    expect(host.querySelector(".rb-suggest-exclude")).toBeNull();
  });
});
