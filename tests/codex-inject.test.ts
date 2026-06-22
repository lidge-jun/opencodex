import { describe, expect, test } from "bun:test";
import { buildProfileFile, buildProviderTableBlock, chooseCatalogPathForInjection, stripOpencodexConfig } from "../src/codex-inject";

describe("Codex config injection", () => {
  test("omits provider-level Responses WebSocket support by default", () => {
    const block = buildProviderTableBlock(10100);

    expect(block).toContain("[model_providers.opencodex]");
    expect(block).toContain('wire_api = "responses"');
    expect(block).toContain("requires_openai_auth = true");
    expect(block).not.toContain("supports_websockets");
  });

  test("can suppress provider-level Responses WebSocket support for explicit opt-out", () => {
    const block = buildProviderTableBlock(10100, false);

    expect(block).not.toContain("supports_websockets");
  });

  test("can advertise provider-level Responses WebSocket support for explicit opt-in", () => {
    const block = buildProviderTableBlock(10100, true);

    expect(block).toContain("supports_websockets = true");
  });

  test("removes stale root context-window overrides so catalog limits drive Codex", () => {
    const stripped = stripOpencodexConfig([
      'model = "gpt-5.5"',
      'model_context_window = 1000000',
      'model_auto_compact_token_limit = 900000',
      'model_catalog_json = "/Users/jun/.codex/opencodex-catalog.json"',
      'model_provider = "opencodex"',
      "",
      "[features]",
      "fast_mode = true",
      "",
    ].join("\n"));

    expect(stripped).toContain('model = "gpt-5.5"');
    expect(stripped).not.toContain("model_context_window");
    expect(stripped).not.toContain("model_auto_compact_token_limit");
    expect(stripped).not.toContain("model_provider");
    expect(stripped).not.toContain("model_catalog_json");
  });

  test("removes root routed model names when restoring native Codex", () => {
    const stripped = stripOpencodexConfig([
      'model = "opencode-go/minimax-m3"',
      'model_verbosity = "high"',
      "",
      "[features]",
      "fast_mode = true",
      "",
    ].join("\n"));

    expect(stripped).not.toContain('model = "opencode-go/minimax-m3"');
    expect(stripped).toContain('model_verbosity = "high"');
  });

  test("can build fallback profile without a model catalog path", () => {
    const profile = buildProfileFile(10100, null);

    expect(profile).toContain('model_provider = "opencodex"');
    expect(profile).not.toContain("model_catalog_json");
  });

  test("honors an explicit unavailable catalog decision", () => {
    const path = chooseCatalogPathForInjection('model_catalog_json = "/tmp/opencodex-catalog.json"\n', null);

    expect(path).toBeNull();
  });
});
