import { describe, expect, test } from "bun:test";
import {
  EXPORT_CLIENT_IDS,
  OPENCODE_PROVIDER_ID,
  buildClientConfig,
  buildClientContribution,
  type ExportContext,
  type PiProviderBlock,
} from "../../src/clients/config-export";

/*
 * Every client whose document is Pi's models.json must tell its runtime to send the system prompt
 * as `system` (#5664, #8864). Pi sends `developer` for reasoning rows by default, the native Chat
 * route forwards roles as sent, and upstreams such as DashScope compatible-mode reject the role with
 * a 400. Prime and Aside reuse Pi's builder and missed this for months because the option is passed
 * per call site, so the clients are discovered by document shape rather than listed by hand: a new
 * client that reuses the builder without the option fails here.
 *
 * Limit: discovery keys on `thinkingLevelMap`, which the builder writes only for reasoning rows, so
 * the context below always carries one. The floor assertion keeps the known clients covered.
 */
const ctx: ExportContext = {
  baseUrl: "http://127.0.0.1:10100/v1",
  models: [
    { namespaced: "openai/gpt-5.6-sol", provider: "openai", id: "gpt-5.6-sol", contextWindow: 922_000, reasoningEfforts: ["low", "high"] },
  ],
};

function piBlock(value: unknown): PiProviderBlock | undefined {
  const block = (value as { providers?: Record<string, PiProviderBlock> } | undefined)?.providers?.[OPENCODE_PROVIDER_ID];
  if (!block || typeof block.api !== "string" || !block.api.startsWith("openai-") || !Array.isArray(block.models)) return undefined;
  return block.models.some(model => model.thinkingLevelMap !== undefined) ? block : undefined;
}

const family = EXPORT_CLIENT_IDS.filter(id => piBlock(buildClientConfig(id, ctx)) !== undefined);

describe("Pi-family clients send system instead of developer", () => {
  test("discovery finds at least the known Pi-runtime clients", () => {
    expect(family).toEqual(expect.arrayContaining(["pi", "prime", "aside", "omo", "gentle-shell"]));
  });

  test.each(family)("%s writes supportsDeveloperRole: false on export and managed contribution", id => {
    expect(piBlock(buildClientConfig(id, ctx))!.compat?.supportsDeveloperRole).toBe(false);
    const fragment = buildClientContribution(id, ctx).fragments
      .find(candidate => candidate.path.join(".") === `providers.${OPENCODE_PROVIDER_ID}`);
    expect((fragment?.value as PiProviderBlock | undefined)?.compat?.supportsDeveloperRole).toBe(false);
  });
});
