import { describe, expect, test } from "bun:test";
import { patchYamlFragmentSource } from "../src/integrations/omp-yaml-source";

const DSH_PATH = ["llm-pi-ai", "providers", "opencodex"] as const;
const VALUE = { api: "openai-responses", baseURL: "http://127.0.0.1:10100/v1" };

function upsert(text: string, expected: unknown) {
  return patchYamlFragmentSource(text, DSH_PATH, { kind: "upsert", value: VALUE }, expected);
}

describe("generic source-preserving YAML fragment mutation", () => {
  test("inserts below the deepest existing container without changing siblings or comments", () => {
    const source = [
      "# header",
      "agent-default-model: deepseek-official/deepseek-chat",
      "llm-pi-ai:",
      "  providers:",
      "    native:",
      "      api: openai-completions # keep",
      "# tail",
      "",
    ].join("\n");
    const expected = Bun.YAML.parse(source) as Record<string, unknown>;
    ((expected["llm-pi-ai"] as { providers: Record<string, unknown> }).providers).opencodex = VALUE;

    const patched = upsert(source, expected);
    expect(patched).not.toBeNull();
    expect(patched).toContain("agent-default-model: deepseek-official/deepseek-chat\n");
    expect(patched).toContain("      api: openai-completions # keep\n");
    expect(patched).toStartWith("# header\n");
    expect(patched).toEndWith("# tail\n");
  });

  test("creates every missing container and preserves CRLF plus missing final newline", () => {
    const source = "agent-default-model: native\r\nother: keep";
    const expected = {
      "agent-default-model": "native",
      other: "keep",
      "llm-pi-ai": { providers: { opencodex: VALUE } },
    };
    const patched = upsert(source, expected);
    expect(patched).not.toBeNull();
    expect(patched!.replaceAll("\r\n", "")).not.toContain("\n");
    expect(patched).not.toEndWith("\n");
    expect(Bun.YAML.parse(patched!)).toEqual(expected);
  });

  test("refuses duplicate keys, tabs, flow/quoted containers, and comments inside the owned leaf", () => {
    const unsafe = [
      "llm-pi-ai:\n  providers:\n    opencodex:\n      api: one\n    opencodex:\n      api: two\n",
      "llm-pi-ai:\n\tproviders: {}\n",
      "llm-pi-ai: { providers: {} }\n",
      "\"llm-pi-ai\":\n  providers: {}\n",
      "llm-pi-ai:\n  providers:\n    opencodex:\n      # owned comment\n      api: one\n",
    ];
    for (const source of unsafe) {
      expect(upsert(source, { "llm-pi-ai": { providers: { opencodex: VALUE } } })).toBeNull();
    }
  });

  test("remove prunes only recorded, source-empty ancestors", () => {
    const generated = [
      "llm-pi-ai:",
      "  providers:",
      "    opencodex:",
      "      api: openai-responses",
      "",
    ].join("\n");
    const removed = patchYamlFragmentSource(generated, DSH_PATH, {
      kind: "remove",
      createdContainers: ["llm-pi-ai", "llm-pi-ai\0providers"],
    }, {});
    expect(removed).toBe("");

    const userContainer = "llm-pi-ai:\n  providers: {}\n";
    expect(patchYamlFragmentSource(userContainer, DSH_PATH, {
      kind: "remove",
      createdContainers: [],
    }, Bun.YAML.parse(userContainer))).toBeNull();
  });

  test("remove keeps a created ancestor after a user adds a sibling", () => {
    const source = [
      "llm-pi-ai:",
      "  providers:",
      "    opencodex:",
      "      api: openai-responses",
      "    later-user-provider:",
      "      api: openai-completions # keep",
      "",
    ].join("\n");
    const expected = {
      "llm-pi-ai": { providers: { "later-user-provider": { api: "openai-completions" } } },
    };
    const patched = patchYamlFragmentSource(source, DSH_PATH, {
      kind: "remove",
      createdContainers: ["llm-pi-ai", "llm-pi-ai\0providers"],
    }, expected);
    expect(patched).toBe([
      "llm-pi-ai:",
      "  providers:",
      "    later-user-provider:",
      "      api: openai-completions # keep",
      "",
    ].join("\n"));
  });

  test("never accepts a candidate whose complete parsed document differs from expected", () => {
    const source = "other: keep\n";
    expect(upsert(source, { other: "different", "llm-pi-ai": { providers: { opencodex: VALUE } } })).toBeNull();
  });
});
