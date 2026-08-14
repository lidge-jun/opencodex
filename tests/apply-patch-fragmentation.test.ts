import { expect, test } from "bun:test";
import { bridgeToResponsesSSE } from "../src/bridge";
import { createRegisteredAdapter } from "../src/adapters/registry";
import type { AdapterWire } from "../src/adapters/contracts";
import { parseRequest } from "../src/responses/parser";
import { buildToolBridgeMaps } from "../src/server/responses";
import type { OcxParsedRequest, OcxProviderConfig } from "../src/types";
import { APPLY_PATCH_FIXTURE } from "./helpers/apply-patch-conformance/contracts";
import { TOOL_WIRE_DRIVERS } from "./helpers/apply-patch-conformance/wire-drivers";
import { createTestTranslatorBudget } from "./helpers/translator-budget";

const FRAGMENTABLE_WIRES = ["openai-chat", "anthropic", "kiro"] as const satisfies readonly AdapterWire[];

const WIRE_MODELS: Record<(typeof FRAGMENTABLE_WIRES)[number], string> = {
  "openai-chat": "grok-4.6",
  anthropic: "claude-haiku-4-5",
  kiro: "claude-sonnet-4.5",
};

function providerFixture(wire: (typeof FRAGMENTABLE_WIRES)[number]): OcxProviderConfig {
  if (wire === "openai-chat") {
    return {
      adapter: wire,
      baseUrl: "https://api.x.ai/v1",
      authMode: "key",
      apiKey: "test-key",
      defaultMaxOutputTokens: 64_000,
    } as OcxProviderConfig;
  }
  if (wire === "anthropic") {
    return {
      adapter: wire,
      baseUrl: "https://api.anthropic.com",
      authMode: "oauth",
      apiKey: "test-key",
      defaultMaxOutputTokens: 64_000,
    } as OcxProviderConfig;
  }
  return {
    adapter: wire,
    baseUrl: "https://runtime.us-east-1.kiro.dev",
    authMode: "key",
    apiKey: "ksk_test",
    defaultMaxOutputTokens: 64_000,
  } as OcxProviderConfig;
}

function freeformParsed(wire: (typeof FRAGMENTABLE_WIRES)[number]): OcxParsedRequest {
  const parsed = parseRequest({
    model: WIRE_MODELS[wire],
    input: "Apply the exact patch.",
    stream: true,
    tools: [{ type: "custom", name: "apply_patch", description: "Apply a patch" }],
  });
  if (wire === "kiro") parsed._kiroAuthContext = { apiRegion: "us-east-1" };
  return parsed;
}

function parseResponsesFrames(text: string): Array<{ event?: string; data: Record<string, unknown> }> {
  return text.split("\n\n")
    .map(frame => frame.trim())
    .filter(frame => frame.length > 0 && frame !== "data: [DONE]")
    .map(frame => {
      const lines = frame.split("\n");
      const event = lines.find(line => line.startsWith("event: "))?.slice(7);
      const data = lines.find(line => line.startsWith("data: "))?.slice(6) ?? "{}";
      return { event, data: JSON.parse(data) as Record<string, unknown> };
    });
}

async function restoredInput(
  wire: (typeof FRAGMENTABLE_WIRES)[number],
  fragments: readonly string[],
): Promise<string | undefined> {
  const driver = TOOL_WIRE_DRIVERS[wire];
  if (!driver.streamingToolCallFragments) {
    throw new Error(`${wire} must expose fragmentable streaming fixtures`);
  }

  const parsed = freeformParsed(wire);
  const adapter = createRegisteredAdapter(providerFixture(wire));
  const outbound = await driver.observeOutbound(adapter, parsed);
  const wireToolName = driver.extractWireToolName?.(outbound, "apply_patch") ?? "apply_patch";
  const upstream = driver.streamingToolCallFragments(wireToolName, fragments);
  const maps = buildToolBridgeMaps(parsed);
  const bridged = bridgeToResponsesSSE(
    adapter.parseStream(upstream, createTestTranslatorBudget()),
    parsed.modelId,
    maps.toolNsMap,
    maps.freeformToolNames,
    maps.toolSearchToolNames,
    undefined,
    2_000,
    { declaredToolNames: maps.declaredToolNames },
  );
  const frames = parseResponsesFrames(await new Response(bridged).text());
  return frames.find(frame => frame.event === "response.custom_tool_call_input.done")?.data.input as
    | string
    | undefined;
}

function fixedWidthFragments(input: string, width: number): string[] {
  const fragments: string[] = [];
  for (let index = 0; index < input.length; index += width) {
    fragments.push(input.slice(index, index + width));
  }
  return fragments;
}

for (const wire of FRAGMENTABLE_WIRES) {
  test(`${wire} restores apply_patch across every two-way argument split`, async () => {
    const encoded = JSON.stringify({ input: APPLY_PATCH_FIXTURE });
    for (let split = 1; split < encoded.length; split += 1) {
      const actual = await restoredInput(wire, [encoded.slice(0, split), encoded.slice(split)]);
      expect(actual, `${wire} split ${split}/${encoded.length}`).toBe(APPLY_PATCH_FIXTURE);
    }
  });

  test(`${wire} restores apply_patch across repeated small argument fragments`, async () => {
    const encoded = JSON.stringify({ input: APPLY_PATCH_FIXTURE });
    for (const width of [1, 2, 3, 7, 13]) {
      const actual = await restoredInput(wire, fixedWidthFragments(encoded, width));
      expect(actual, `${wire} fragment width ${width}`).toBe(APPLY_PATCH_FIXTURE);
    }
  });
}
