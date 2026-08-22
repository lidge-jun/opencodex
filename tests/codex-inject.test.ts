import { describe, expect, test } from "bun:test";
import {
  applyEol,
  buildOpenaiBaseUrlLine,
  buildProfileFile,
  buildProviderTableBlock,
  chooseCatalogPathForInjection,
  dominantEol,
  setRootOpenaiBaseUrl,
  stripInjectedOpenaiBaseUrl,
  stripOpencodexConfig,
  stripRootContextWindowOverrides,
} from "../src/codex/inject";
import {
  MANAGED_AGENTS_TABLE_MARKER,
  MANAGED_SUBAGENT_DEFAULT_MARKER,
} from "../src/codex/subagent-defaults";

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

  test("non-loopback proxy mode injects the modern env_key admission line (#2073)", () => {
    const block = buildProviderTableBlock(10100, false, true);

    expect(block).toContain('env_key = "OPENCODEX_API_AUTH_TOKEN"');
    // The legacy header table must not come back: codex 0.146+ documents env_key as
    // the bearer form, and #1686's server-side substitution is keyed to it.
    expect(block).not.toContain("env_http_headers");
  });

  test("injected base_url matches the actual bind: literal 127.0.0.1 for loopback/wildcard (Windows resolves localhost to ::1 first)", () => {
    expect(buildProviderTableBlock(10100, false, false, undefined)).toContain('base_url = "http://127.0.0.1:10100/v1"');
    expect(buildProviderTableBlock(10100, false, false, "localhost")).toContain('base_url = "http://127.0.0.1:10100/v1"');
    expect(buildProviderTableBlock(10100, false, false, "0.0.0.0")).toContain('base_url = "http://127.0.0.1:10100/v1"');
    expect(buildProviderTableBlock(10100, false, false, "::")).toContain('base_url = "http://127.0.0.1:10100/v1"');
    expect(buildProviderTableBlock(10100, false, false, "::1")).toContain('base_url = "http://[::1]:10100/v1"');
    expect(buildProviderTableBlock(10100, false, false, "[::1]")).toContain('base_url = "http://[::1]:10100/v1"');
    expect(buildProviderTableBlock(10100, false, false, "192.168.1.20")).toContain('base_url = "http://192.168.1.20:10100/v1"');
    expect(buildProviderTableBlock(10100, false, false, "2001:db8::5")).toContain('base_url = "http://[2001:db8::5]:10100/v1"');
  });

  test("strips stale root context-window overrides on injection so the catalog drives model context (gpt-5.5 regression)", () => {
    const cleaned = stripRootContextWindowOverrides([
      'model_provider = "opencodex"',
      "model_context_window = 1000000",
      "model_auto_compact_token_limit = 900000",
      'model_auto_compact_token_limit_scope = "total"',
      'model = "gpt-5.5"',
      "",
      "[model_providers.opencodex]",
      "# a nested table key must survive",
      "model_context_window = 272000",
      "",
    ].join("\n"));

    // Only the stale root context-window override is removed. Compaction is a user-owned limit.
    expect(cleaned).not.toMatch(/^model_context_window = 1000000$/m);
    expect(cleaned).toContain("model_auto_compact_token_limit = 900000");
    expect(cleaned).toContain('model_auto_compact_token_limit_scope = "total"');
    // Non-context-window root keys are untouched.
    expect(cleaned).toContain('model_provider = "opencodex"');
    expect(cleaned).toContain('model = "gpt-5.5"');
    // Table-nested keys (after the first [table]) are preserved.
    expect(cleaned).toContain("model_context_window = 272000");
  });

  test("preserves user root context-window overrides when restoring native Codex", () => {
    const stripped = stripOpencodexConfig([
      'model = "gpt-5.5"',
      'model_context_window = 1000000',
      'model_auto_compact_token_limit = 900000',
      'model_catalog_json = "/tmp/opencodex-catalog.json"',
      'model_provider = "opencodex"',
      "",
      "[features]",
      "fast_mode = true",
      "",
    ].join("\n"));

    expect(stripped).toContain('model = "gpt-5.5"');
    expect(stripped).toContain("model_context_window = 1000000");
    expect(stripped).toContain("model_auto_compact_token_limit = 900000");
    expect(stripped).not.toContain("model_provider");
    expect(stripped).not.toContain("model_catalog_json");
  });

  test("removes root routed model names when restoring native Codex", () => {
    const stripped = stripOpencodexConfig([
      'model_provider = "opencodex"',
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

  test("malformed quoted root values cannot wedge restore transforms", () => {
    const slashRun = "\\".repeat(64);
    const stripped = stripOpencodexConfig([
      'model_provider = "opencodex"',
      `model = "${slashRun}`,
      `model_catalog_json = "${slashRun}`,
      "",
    ].join("\n"));

    expect(stripped).toContain(`model = "${slashRun}`);
    expect(stripped).toContain(`model_catalog_json = "${slashRun}`);
  }, 2_000);

  test("preserves non-opencodex routed model names during fallback restore", () => {
    const stripped = stripOpencodexConfig([
      'model_provider = "proxy"',
      'model = "openrouter/foo"',
      "",
      "[model_providers.proxy]",
      'name = "Existing Proxy"',
      'base_url = "https://proxy.example.test/v1"',
      'wire_api = "responses"',
      "",
    ].join("\n"));

    expect(stripped).toContain('model_provider = "proxy"');
    expect(stripped).toContain('model = "openrouter/foo"');
    expect(stripped).toContain("[model_providers.proxy]");
  });

  test("loopback fallback file uses the Design B root override (no provider table)", () => {
    const profile = buildProfileFile(10100, null);

    expect(profile).toContain('openai_base_url = "http://127.0.0.1:10100/v1"');
    expect(profile).not.toContain('model_provider = "opencodex"');
    expect(profile).not.toContain("[model_providers.opencodex]");
    expect(profile).not.toContain("model_catalog_json");
  });

  test("fallback profile does not force fast_mode when fastMode is unset", () => {
    expect(buildProfileFile(10100, null)).not.toContain("fast_mode");
    expect(buildProfileFile(10100, null, false, true, "192.168.1.20")).not.toContain("fast_mode");
  });

  test("fallback profile mirrors an explicit fastMode=true override", () => {
    const loopback = buildProfileFile(10100, null, false, false, undefined, true);

    expect(loopback).toContain("fast_mode = true");
    expect(loopback).not.toContain("fast_mode = false");
  });

  test("fallback profile mirrors an explicit fastMode=false override", () => {
    const loopback = buildProfileFile(10100, null, false, false, undefined, false);

    expect(loopback).toContain("fast_mode = false");
    expect(loopback).not.toContain("fast_mode = true");

    const legacy = buildProfileFile(10100, null, false, true, "192.168.1.20", false);
    expect(legacy).toContain("fast_mode = false");
    expect(legacy).not.toContain("fast_mode = true");
  });

  test("non-loopback fallback profile keeps the legacy provider-table shape with the injected host", () => {
    const profile = buildProfileFile(10100, null, false, true, "192.168.1.20");

    expect(profile).toContain("proxy at 192.168.1.20:10100");
    expect(profile).toContain('base_url = "http://192.168.1.20:10100/v1"');
    expect(profile).toContain('model_provider = "opencodex"');
    expect(profile).toContain("[model_providers.opencodex]");
  });

  test("non-loopback fallback profile mirrors websocket and API auth provider options", () => {
    const profile = buildProfileFile(10100, "/tmp/opencodex-catalog.json", true, true);

    expect(profile).toContain('model_catalog_json = "/tmp/opencodex-catalog.json"');
    expect(profile).toContain("supports_websockets = true");
    expect(profile).toContain('env_key = "OPENCODEX_API_AUTH_TOKEN"');
    expect(profile).not.toContain("env_http_headers");
  });

  test("honors an explicit unavailable catalog decision", () => {
    const path = chooseCatalogPathForInjection('model_catalog_json = "/tmp/opencodex-catalog.json"\n', null);

    expect(path).toBeNull();
  });

  test("strips injected TOML sections without swallowing later indented tables", () => {
    const stripped = stripOpencodexConfig([
      'model_provider = "opencodex"',
      "",
      "# Auto-injected by opencodex",
      " [model_providers.opencodex]",
      'name = "OpenCodex Proxy"',
      'base_url = "http://localhost:10100/v1"',
      " [plugins.safe]",
      "enabled = true",
      "",
      " [profiles.opencodex]",
      'model_provider = "opencodex"',
      " [profiles.work]",
      'model = "gpt-5.5"',
      "",
    ].join("\n"));

    expect(stripped).toContain("[plugins.safe]");
    expect(stripped).toContain("enabled = true");
    expect(stripped).toContain("[profiles.work]");
    expect(stripped).toContain('model = "gpt-5.5"');
    expect(stripped).not.toContain("[model_providers.opencodex]");
    expect(stripped).not.toContain("[profiles.opencodex]");
  });

  test("strip removes only marker-owned native subagent defaults", () => {
    const stripped = stripOpencodexConfig([
      MANAGED_AGENTS_TABLE_MARKER,
      "[agents]",
      MANAGED_SUBAGENT_DEFAULT_MARKER,
      'default_subagent_model = "gpt-5.6-sol"',
      MANAGED_SUBAGENT_DEFAULT_MARKER,
      'default_subagent_reasoning_effort = "high"',
      "max_threads = 8",
      "",
    ].join("\n"));

    expect(stripped).toContain("[agents]");
    expect(stripped).toContain("max_threads = 8");
    expect(stripped).not.toContain(MANAGED_AGENTS_TABLE_MARKER);
    expect(stripped).not.toContain(MANAGED_SUBAGENT_DEFAULT_MARKER);
    expect(stripped).not.toContain("default_subagent_model");
    expect(stripped).not.toContain("default_subagent_reasoning_effort");
  });
});

describe("Design B openai_base_url injection", () => {
  test("buildOpenaiBaseUrlLine matches the actual bind host", () => {
    expect(buildOpenaiBaseUrlLine(10100)).toBe('openai_base_url = "http://127.0.0.1:10100/v1"');
    expect(buildOpenaiBaseUrlLine(10100, "localhost")).toBe('openai_base_url = "http://127.0.0.1:10100/v1"');
    expect(buildOpenaiBaseUrlLine(10100, "::1")).toBe('openai_base_url = "http://[::1]:10100/v1"');
  });

  test("inserts marker + root key before the first table header", () => {
    const { content, keptUserBaseUrl } = setRootOpenaiBaseUrl([
      'model = "gpt-5.5"',
      "",
      "[features]",
      "fast_mode = true",
      "",
    ].join("\n"), 10100);

    expect(keptUserBaseUrl).toBe(false);
    const lines = content.split("\n");
    const markerIdx = lines.findIndex(l => l.includes("Auto-injected by opencodex"));
    const keyIdx = lines.findIndex(l => l.startsWith("openai_base_url"));
    const tableIdx = lines.findIndex(l => l.trim() === "[features]");
    expect(markerIdx).toBeGreaterThanOrEqual(0);
    expect(keyIdx).toBe(markerIdx + 1);
    expect(keyIdx).toBeLessThan(tableIdx);
  });

  test("re-inject is idempotent and rewrites the marker-owned line on port change", () => {
    const first = setRootOpenaiBaseUrl("model = \"gpt-5.5\"\n\n[features]\nfast_mode = true\n", 10100).content;
    const second = setRootOpenaiBaseUrl(first, 10190).content;

    expect(second.match(/openai_base_url/g)?.length).toBe(1);
    expect(second.match(/Auto-injected by opencodex/g)?.length).toBe(1);
    expect(second).toContain('openai_base_url = "http://127.0.0.1:10190/v1"');
  });

  test("keeps a user's own root openai_base_url and injects nothing", () => {
    const original = [
      'openai_base_url = "https://my-own-gateway.example/v1"',
      "",
      "[features]",
      "fast_mode = true",
      "",
    ].join("\n");
    const { content, keptUserBaseUrl } = setRootOpenaiBaseUrl(original, 10100);

    expect(keptUserBaseUrl).toBe(true);
    expect(content).toBe(original);
  });

  test("strip removes only the marker-owned pair; a user's own line survives", () => {
    const injected = setRootOpenaiBaseUrl("model = \"gpt-5.5\"\n\n[features]\nfast_mode = true\n", 10100).content;
    const stripped = stripInjectedOpenaiBaseUrl(injected);
    expect(stripped).not.toContain("openai_base_url");
    expect(stripped).not.toContain("Auto-injected by opencodex");

    const userOwned = 'openai_base_url = "https://my-own-gateway.example/v1"\n\n[features]\n';
    expect(stripInjectedOpenaiBaseUrl(userOwned)).toBe(userOwned);
  });

  test("stripOpencodexConfig removes the Design B form including routed root models", () => {
    const injected = setRootOpenaiBaseUrl([
      'model = "opencode-go/minimax-m3"',
      'model_verbosity = "high"',
      'model_catalog_json = "/tmp/opencodex-catalog.json"',
      "",
      "[features]",
      "fast_mode = true",
      "",
    ].join("\n"), 10100).content;
    const stripped = stripOpencodexConfig(injected);

    expect(stripped).not.toContain("openai_base_url");
    expect(stripped).not.toContain('model = "opencode-go/minimax-m3"'); // routed id useless without proxy
    expect(stripped).toContain('model_verbosity = "high"');
    expect(stripped).not.toContain("model_catalog_json");
    expect(stripped).toContain("[features]");
  });

  test("upgrade path: legacy table + root re-tag coexisting with Design B form all strip cleanly", () => {
    const legacy = [
      'model_provider = "opencodex"',
      "# Auto-injected by opencodex",
      'openai_base_url = "http://127.0.0.1:10100/v1"',
      'model = "gpt-5.5"',
      "",
      "# Auto-injected by opencodex",
      "[model_providers.opencodex]",
      'name = "OpenCodex Proxy"',
      'base_url = "http://127.0.0.1:10100/v1"',
      "",
    ].join("\n");
    const stripped = stripOpencodexConfig(legacy);

    expect(stripped).not.toContain("opencodex");
    expect(stripped).not.toContain("openai_base_url");
    expect(stripped).toContain('model = "gpt-5.5"');
  });

  test("legacy marker directly before the provider table survives the root strip order (removeOcxSection keeps its anchor)", () => {
    // No Design B form present — stripInjectedOpenaiBaseUrl must not eat the legacy EOF marker
    // in a way that leaves the [model_providers.opencodex] table behind.
    const legacyOnly = [
      'model_provider = "opencodex"',
      'model = "gpt-5.5"',
      "",
      "# Auto-injected by opencodex",
      "[model_providers.opencodex]",
      'name = "OpenCodex Proxy"',
      'base_url = "http://127.0.0.1:10100/v1"',
      'wire_api = "responses"',
      "",
    ].join("\n");
    const stripped = stripOpencodexConfig(legacyOnly);

    expect(stripped).not.toContain("opencodex");
    expect(stripped).not.toContain("[model_providers.opencodex]");
    expect(stripped).toContain('model = "gpt-5.5"');
  });

  test("app-rewritten env_http_headers sub-table strips fully: no nameless provider survives", () => {
    // A Codex app config rewrite re-serializes the provider's inline env_http_headers table
    // into a separate [model_providers.opencodex.env_http_headers] sub-table. Cleanup must
    // remove the provider table AND its sub-table, or the provider survives with no `name`
    // and Codex rejects the whole config ("provider name must not be empty").
    const rewritten = [
      'model = "gpt-5.5"',
      "",
      "[model_providers.opencodex]",
      'name = "OpenCodex Proxy"',
      'base_url = "http://127.0.0.1:10100/v1"',
      'wire_api = "responses"',
      "",
      "[model_providers.opencodex.env_http_headers]",
      '"x-opencodex-api-key" = "OPENCODEX_API_AUTH_TOKEN"',
      "",
      "[agents]",
      "max_concurrent_threads_per_session = 8",
      "",
    ].join("\n");
    const stripped = stripOpencodexConfig(rewritten);

    expect(stripped).not.toContain("opencodex");
    expect(stripped).toContain("[agents]");
    expect(stripped).toContain('model = "gpt-5.5"');
  });

  test("an orphaned env_http_headers sub-table alone is removed (recurrence breaker)", () => {
    // Once the main table is gone, only the sub-table header defines the provider. The old
    // exact-match guards never matched that form, so the orphan was journaled as baseline and
    // re-persisted on every inject/restore cycle while Codex kept failing on startup.
    const orphan = [
      'model = "gpt-5.5"',
      "",
      "[agents]",
      "max_concurrent_threads_per_session = 8",
      "",
      "[model_providers.opencodex.env_http_headers]",
      '"x-opencodex-api-key" = "OPENCODEX_API_AUTH_TOKEN"',
      '"CF-Access-Client-Id" = "CF_ACCESS_CLIENT_ID"',
      "",
    ].join("\n");
    const stripped = stripOpencodexConfig(orphan);

    expect(stripped).not.toContain("opencodex");
    expect(stripped).not.toContain("CF-Access-Client-Id");
    expect(stripped).toContain('model = "gpt-5.5"');
    expect(stripped).toContain("[agents]");
  });

  test("a user's similarly named provider table is preserved while opencodex sub-tables strip", () => {
    const content = [
      "[model_providers.opencodex.env_http_headers]",
      '"x-opencodex-api-key" = "OPENCODEX_API_AUTH_TOKEN"',
      "",
      "[model_providers.opencodex_backup]",
      'name = "user backup"',
      "",
    ].join("\n");
    const stripped = stripOpencodexConfig(content);

    expect(stripped).not.toContain("env_http_headers");
    expect(stripped).toContain("[model_providers.opencodex_backup]");
    expect(stripped).toContain('name = "user backup"');
  });

  test("a trailing comment on the root provider header is still recognized (TOML allows `[table] # comment`)", () => {
    const commented = [
      'model = "gpt-5.5"',
      "",
      "[model_providers.opencodex] # managed provider",
      'name = "OpenCodex Proxy"',
      'base_url = "http://127.0.0.1:10100/v1"',
      "",
    ].join("\n");
    const stripped = stripOpencodexConfig(commented);

    expect(stripped).not.toContain("model_providers.opencodex");
    expect(stripped).not.toContain("OpenCodex Proxy");
    expect(stripped).toContain('model = "gpt-5.5"');
  });

  test("a trailing comment on the sub-table header is still recognized", () => {
    const commented = [
      'model = "gpt-5.5"',
      "",
      "[model_providers.opencodex.env_http_headers] # managed sub-table",
      '"x-opencodex-api-key" = "OPENCODEX_API_AUTH_TOKEN"',
      "",
    ].join("\n");
    const stripped = stripOpencodexConfig(commented);

    expect(stripped).not.toContain("opencodex");
    expect(stripped).toContain('model = "gpt-5.5"');
  });
});

describe("EOL boundary helpers (Windows CRLF configs)", () => {
  test("dominantEol picks LF for LF-only and empty content", () => {
    expect(dominantEol("")).toBe("\n");
    expect(dominantEol("a = 1\nb = 2\n")).toBe("\n");
  });

  test("dominantEol picks CRLF for CRLF-only content", () => {
    expect(dominantEol("a = 1\r\nb = 2\r\n")).toBe("\r\n");
  });

  test("dominantEol follows the majority in mixed content", () => {
    expect(dominantEol("a = 1\r\nb = 2\r\nc = 3\n")).toBe("\r\n");
    expect(dominantEol("a = 1\r\nb = 2\nc = 3\n")).toBe("\n");
  });

  test("applyEol round-trips CRLF -> LF -> CRLF without doubling CRs", () => {
    const crlf = "a = 1\r\n\r\n[t]\r\nk = 2\r\n";
    const lf = applyEol(crlf, "\n");
    expect(lf).toBe("a = 1\n\n[t]\nk = 2\n");
    expect(applyEol(lf, "\r\n")).toBe(crlf);
    // Idempotent on already-normalized input.
    expect(applyEol(crlf, "\r\n")).toBe(crlf);
  });
});
