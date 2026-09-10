import { describe, test, expect } from "bun:test";
import { codexCompatibleUrl, contextEndpoint, contextCompatibleBaseLine } from "../../src/codex/context-compat";

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
