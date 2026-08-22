import { describe, expect, test } from "bun:test";
import {
  applyRoutedCodexToolMode,
  normalizeRoutedCatalogEntry,
  ROUTED_CODEX_TOOL_MODE,
  type RawEntry,
} from "../src/codex/catalog/parsing";
import { buildCatalogEntries } from "../src/codex/catalog";
import {
  collectDeclaredWireToolNames,
  undeclaredToolCallName,
} from "../src/server/responses-undeclared-tool-guard";

describe("Codex tool mode configuration (#2106)", () => {
  test("applyRoutedCodexToolMode defaults to code_mode_only", () => {
    const entry: RawEntry = { slug: "deepseek/deepseek-v4-flash" };
    applyRoutedCodexToolMode(entry);
    expect(entry.tool_mode).toBe(ROUTED_CODEX_TOOL_MODE);

    const explicitCodeMode: RawEntry = { slug: "deepseek/deepseek-v4-flash" };
    applyRoutedCodexToolMode(explicitCodeMode, "code_mode_only");
    expect(explicitCodeMode.tool_mode).toBe(ROUTED_CODEX_TOOL_MODE);
  });

  test("applyRoutedCodexToolMode deletes tool_mode when toolMode is shell", () => {
    const entry: RawEntry = {
      slug: "deepseek/deepseek-v4-flash",
      tool_mode: "code_mode_only",
    };
    applyRoutedCodexToolMode(entry, "shell");
    expect(entry.tool_mode).toBeUndefined();
    expect(Object.hasOwn(entry, "tool_mode")).toBe(false);
  });

  test("normalizeRoutedCatalogEntry respects toolMode", () => {
    const defaultEntry: RawEntry = {
      slug: "deepseek/deepseek-v4-flash",
      model_messages: { input: [] },
    };
    normalizeRoutedCatalogEntry(defaultEntry);
    expect(defaultEntry.tool_mode).toBe("code_mode_only");

    const shellEntry: RawEntry = {
      slug: "deepseek/deepseek-v4-flash",
      model_messages: { input: [] },
    };
    normalizeRoutedCatalogEntry(shellEntry, false, "shell");
    expect(shellEntry.tool_mode).toBeUndefined();
    expect(Object.hasOwn(shellEntry, "tool_mode")).toBe(false);
  });

  test("buildCatalogEntries preserves tool_mode = code_mode_only by default", () => {
    const entries = buildCatalogEntries(null, [], [
      { id: "deepseek-v4-flash", provider: "deepseek" },
    ]);
    const deepseekEntry = entries.find(e => e.slug === "deepseek/deepseek-v4-flash");
    expect(deepseekEntry).toBeDefined();
    expect(deepseekEntry?.tool_mode).toBe("code_mode_only");
    expect(deepseekEntry?.shell_type).toBe("shell_command");
  });

  test("buildCatalogEntries leaves tool_mode unset when codexToolMode is shell", () => {
    const entries = buildCatalogEntries(null, [], [
      {
        id: "deepseek-v4-flash",
        provider: "deepseek",
        codexToolMode: "shell",
      },
    ]);
    const deepseekEntry = entries.find(e => e.slug === "deepseek/deepseek-v4-flash");
    expect(deepseekEntry).toBeDefined();
    expect(deepseekEntry?.tool_mode).toBeUndefined();
    expect(deepseekEntry?.shell_type).toBe("shell_command");
  });

  test("under shell mode with declared exec_command, undeclared-tool-guard allows exec_command", () => {
    // When Codex operates under flat shell mode (tool_mode omitted), it declares exec_command on the wire:
    const wireBody = {
      tools: [
        {
          type: "function",
          name: "exec_command",
          description: "Execute a shell command",
        },
      ],
    };
    const declaredTools = collectDeclaredWireToolNames(wireBody);
    expect(declaredTools.has("exec_command")).toBe(true);

    const sseEvent = {
      type: "response.output_item.added",
      item: {
        type: "function_call",
        name: "exec_command",
        call_id: "call_abc",
      },
    };
    const undeclared = undeclaredToolCallName(sseEvent, declaredTools);
    expect(undeclared).toBeUndefined();
  });

  test("catalogHintsFromProviderConfig propagates codexToolMode", () => {
    const { catalogHintsFromProviderConfig } = require("../src/codex/catalog/provider-fetch");
    const hints = catalogHintsFromProviderConfig(
      "deepseek",
      {
        adapter: "openai-responses",
        baseUrl: "https://api.deepseek.com",
        codexToolMode: "shell",
      },
      "deepseek-v4-flash",
    );
    expect(hints.codexToolMode).toBe("shell");
  });

  test("deriveComboCatalogModel sets codexToolMode = shell when all members specify shell", () => {
    const { deriveComboCatalogModel } = require("../src/codex/catalog/aggregation");
    const combo = {
      name: "all-shell-combo",
      targets: [
        { provider: "deepseek", model: "v4" },
        { provider: "qwen", model: "max" },
      ],
    };
    const members = [
      { id: "v4", provider: "deepseek", contextWindow: 128000, codexToolMode: "shell" as const },
      { id: "max", provider: "qwen", contextWindow: 128000, codexToolMode: "shell" as const },
    ];
    const derived = deriveComboCatalogModel("all-shell-combo", combo, members);
    expect(derived?.codexToolMode).toBe("shell");

    const mixedMembers = [
      { id: "v4", provider: "deepseek", contextWindow: 128000, codexToolMode: "shell" as const },
      { id: "max", provider: "qwen", contextWindow: 128000 },
    ];
    const mixedDerived = deriveComboCatalogModel("all-shell-combo", combo, mixedMembers);
    expect(mixedDerived?.codexToolMode).toBeUndefined();
  });

  test("gatherRoutedModels custom model inherits provider codexToolMode when undiscovered", async () => {
    const { gatherRoutedModels } = require("../src/codex/catalog");
    const { withStubbedProviderFetch } = require("./helpers/catalog-provider-fetch");
    const config = {
      providers: {
        customprov: {
          adapter: "openai-responses",
          baseUrl: "https://api.custom.com",
          codexToolMode: "shell",
          liveModels: false,
        },
      },
      customModels: [
        {
          provider: "customprov",
          modelId: "undiscovered-model",
        },
      ],
    };
    const models = await gatherRoutedModels(withStubbedProviderFetch(config as any));
    const model = models.find((m: any) => m.id === "undiscovered-model");
    expect(model).toBeDefined();
    expect(model.codexToolMode).toBe("shell");
  });

  test("gatherRoutedModels custom model explicit codexToolMode overrides provider setting", async () => {
    const { gatherRoutedModels } = require("../src/codex/catalog");
    const { withStubbedProviderFetch } = require("./helpers/catalog-provider-fetch");
    const config = {
      providers: {
        customprov: {
          adapter: "openai-responses",
          baseUrl: "https://api.custom.com",
          codexToolMode: "shell",
          liveModels: false,
        },
      },
      customModels: [
        {
          provider: "customprov",
          modelId: "override-model",
          codexToolMode: "code_mode_only",
        },
      ],
    };
    const models = await gatherRoutedModels(withStubbedProviderFetch(config as any));
    const model = models.find((m: any) => m.id === "override-model");
    expect(model).toBeDefined();
    expect(model.codexToolMode).toBe("code_mode_only");
  });

  test("buildCatalogEntries with codexForwardNativeCapabilityAlias applies codexToolMode = shell", () => {
    const { buildCatalogEntries, NATIVE_DAYBREAK_BLUE_MODEL, upstreamNativeEntry } = require("../src/codex/catalog");
    const { CODEX_CUSTOM_MODEL_CATALOG_KIND, findNativeTemplate } = require("../src/codex/catalog/parsing");
    const nativeTemplate = () => findNativeTemplate({ models: [upstreamNativeEntry("gpt-5.6-sol")!] });
    const models = [{
      id: NATIVE_DAYBREAK_BLUE_MODEL,
      provider: "openai",
      catalogKind: CODEX_CUSTOM_MODEL_CATALOG_KIND,
      codexForwardNativeCapabilityAlias: true,
      codexToolMode: "shell" as const,
    }];
    const entries = buildCatalogEntries(nativeTemplate(), [], models);
    const daybreak = entries.find((entry: any) => entry.slug === `openai/${NATIVE_DAYBREAK_BLUE_MODEL}`);
    expect(daybreak).toBeDefined();
    expect(daybreak?.tool_mode).toBeUndefined();
    expect(daybreak?.use_responses_lite).toBe(true);
  });
});


