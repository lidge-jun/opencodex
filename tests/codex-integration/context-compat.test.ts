import { describe, test, expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  codexCompatibleUrl, contextEndpoint, contextCompatibleBaseLine,
  contextExperimentalEnabled, contextRelayActivated, resetContextRelayActivationForTests,
} from "../../src/codex/context-compat";

describe("route and config isolation", () => {
  test("aliases data-plane routes and preserves query; never aliases management", () => {
    for (const route of ["responses", "responses/compact", "models", "alpha/search", "live", "realtime/calls"]) {
      expect(codexCompatibleUrl(`http://127.0.0.1:10100/backend-api/codex/${route}?a=1`).pathname).toBe(`/v1/${route}`);
    }
    expect(codexCompatibleUrl("http://127.0.0.1:10100/v1/responses?a=1").href).toBe("http://127.0.0.1:10100/v1/responses?a=1");
    expect(codexCompatibleUrl("http://127.0.0.1:10100/backend-api/codex/api/config").pathname).toBe("/v1/api/config");
    expect(contextEndpoint("/v1/alpha/notes/v2/write_file")).toBe("alpha/notes/v2/write_file");
    expect(contextEndpoint("/v1/alpha/notes/v2/delete_file")).toBeUndefined();
    expect(contextEndpoint("/v1/alpha/notes/v2/../write_file")).toBeUndefined();
  });
  test("opt-in changes only the built-in loopback base URL", () => {
    const line='openai_base_url = "http://127.0.0.1:10100/v1"';
    expect(contextCompatibleBaseLine('[features]\ncontext_management.experimental_mode = true\n',line)).toBe('openai_base_url = "http://127.0.0.1:10100/backend-api/codex"');
    for(const content of ['','[features]\ncontext_management.experimental_mode = false\n']) expect(contextCompatibleBaseLine(content,line)).toBe(line);
    const remote='openai_base_url = "https://example.com/v1"';
    expect(contextCompatibleBaseLine('[features.context_management]\nexperimental_mode=true\n',remote)).toBe(remote);
  });
});

describe("native context opt-in forms", () => {
  const cases: Array<[string, string, boolean]> = [
    ["boolean true", "[features]\ncontext_management = true\n", true],
    ["root dotted boolean", "features.context_management = true\n", true],
    ["inline feature table", "features = { context_management = true }\n", true],
    ["dotted experimental mode", "[features]\ncontext_management.experimental_mode = true\n", true],
    ["nested experimental mode", "[features.context_management]\nexperimental_mode = true\n", true],
    ["inline experimental mode", "[features]\ncontext_management = { experimental_mode = true }\n", true],
    ["absent feature", "model = 'gpt-6-astra'\n", false],
    ["boolean false", "[features]\ncontext_management = false\n", false],
    ["experimental mode false", "[features.context_management]\nexperimental_mode = false\n", false],
    ["empty table", "[features.context_management]\n", false],
    ["unsupported enabled field", "[features.context_management]\nenabled = true\n", false],
    ["string true", "[features]\ncontext_management = 'true'\n", false],
    ["numeric true", "[features]\ncontext_management = 1\n", false],
    ["array true", "[features]\ncontext_management = [true]\n", false],
    ["string experimental mode", "[features.context_management]\nexperimental_mode = 'true'\n", false],
    ["malformed TOML", "[features\ncontext_management = true\n", false],
    ["conflicting forms", "[features]\ncontext_management = true\ncontext_management.experimental_mode = true\n", false],
    ["profile-only opt-in", "[profiles.trial.features]\ncontext_management = true\n", false],
  ];

  for (const [name, content, expected] of cases) {
    test(name, () => {
      expect(contextExperimentalEnabled(content)).toBe(expected);
      const original = 'openai_base_url = "http://127.0.0.1:10100/v1"';
      expect(contextCompatibleBaseLine(content, original)).toBe(expected
        ? 'openai_base_url = "http://127.0.0.1:10100/backend-api/codex"'
        : original);
    });
  }

  test("boolean opt-in preserves remote, custom-provider and unrelated paths", () => {
    const content = "[features]\ncontext_management = true\n";
    for (const line of [
      'openai_base_url = "https://example.com/v1"',
      'openai_base_url = "http://192.0.2.1:10100/v1"',
      'openai_base_url = "http://127.0.0.1:10100/custom/v1"',
      'base_url = "http://127.0.0.1:10100/v1"',
      'experimental_realtime_ws_base_url = "http://127.0.0.1:10100/v1"',
    ]) {
      expect(contextCompatibleBaseLine(content, line)).toBe(line);
    }
  });

  test("runtime gate follows boolean opt-in and revocation without restart", () => {
    const home = mkdtempSync(join(tmpdir(), "ocx-context-opt-in-"));
    const path = join(home, "config.toml");
    resetContextRelayActivationForTests();
    try {
      expect(contextRelayActivated(path)).toBe(false);
      writeFileSync(path, "[features]\ncontext_management = true\n");
      expect(contextRelayActivated(path)).toBe(true);
      expect(contextRelayActivated(path)).toBe(true); // Exercise the unchanged-file cache.
      // Different content sizes invalidate the stat cache even on coarse-mtime filesystems.
      writeFileSync(path, "[features]\ncontext_management = false\n");
      expect(contextRelayActivated(path)).toBe(false);
      writeFileSync(path, "[features.context_management]\nexperimental_mode = true\n");
      expect(contextRelayActivated(path)).toBe(true);
      writeFileSync(path, "[features\ncontext_management = true\n");
      expect(contextRelayActivated(path)).toBe(false);
    } finally {
      resetContextRelayActivationForTests();
      rmSync(home, { recursive: true, force: true });
    }
  });
});
