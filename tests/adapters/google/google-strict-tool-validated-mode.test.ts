import { describe, expect, test } from "bun:test";
import { createGoogleAdapter } from "../../../src/adapters/google";
import type { OcxParsedRequest, OcxProviderConfig } from "../../../src/types";

/**
 * #5210 case 3. Gemini expresses schema-enforced function calling as
 * `functionCallingConfig.mode: "VALIDATED"`. The mode was plumbed all the way to the wire
 * compiler but was only reachable by matching a model name, so a caller that declared strict
 * tools got an ordinary AUTO turn and a normal answer. These assertions read the compiled
 * request body, which is the only place the difference is visible.
 */

const provider = {
  adapter: "google",
  baseUrl: "https://generativelanguage.googleapis.com",
  apiKey: "key",
} as unknown as OcxProviderConfig;

const STRICT_TOOLS = [
  { name: "get_weather", description: "", parameters: { type: "object", properties: {} }, strict: true },
  { name: "shot", description: "", parameters: { type: "object", properties: {} } },
];
const LOOSE_TOOLS = STRICT_TOOLS.map(({ strict: _strict, ...rest }) => rest);

async function toolConfig(tools: unknown[], toolChoice?: unknown): Promise<unknown> {
  const parsed = {
    modelId: "gemini-3-pro",
    stream: false,
    options: toolChoice === undefined ? {} : { toolChoice },
    context: { messages: [{ role: "user", content: "hi" }], tools },
  } as unknown as OcxParsedRequest;
  const { body } = await createGoogleAdapter(provider).buildRequest(parsed);
  return (JSON.parse(body) as Record<string, unknown>).toolConfig;
}

describe("strict tool declarations select Gemini VALIDATED function calling", () => {
  test("a strict declaration turns the absent-choice default into VALIDATED", async () => {
    expect(await toolConfig(STRICT_TOOLS)).toEqual({ functionCallingConfig: { mode: "VALIDATED" } });
    expect(await toolConfig(STRICT_TOOLS, "auto")).toEqual({ functionCallingConfig: { mode: "VALIDATED" } });
  });

  test("an allowed-tools subset in auto mode keeps VALIDATED when the subset is strict", async () => {
    expect(await toolConfig(STRICT_TOOLS, { allowedTools: ["get_weather"], mode: "auto" }))
      .toEqual({ functionCallingConfig: { mode: "VALIDATED" } });
  });

  test("a subset that excludes the strict tool does not claim validation", async () => {
    expect(await toolConfig(STRICT_TOOLS, { allowedTools: ["shot"], mode: "auto" })).toBeUndefined();
  });

  test("without a strict declaration the wire is unchanged", async () => {
    expect(await toolConfig(LOOSE_TOOLS)).toBeUndefined();
    expect(await toolConfig(LOOSE_TOOLS, "auto")).toBeUndefined();
    expect(await toolConfig(LOOSE_TOOLS, { allowedTools: ["get_weather"], mode: "auto" })).toBeUndefined();
  });

  test("a stronger caller-chosen mode is never overwritten by VALIDATED", async () => {
    expect(await toolConfig(STRICT_TOOLS, "none")).toEqual({ functionCallingConfig: { mode: "NONE" } });
    expect(await toolConfig(STRICT_TOOLS, "required")).toEqual({ functionCallingConfig: { mode: "ANY" } });
    expect(await toolConfig(STRICT_TOOLS, { allowedTools: ["get_weather"], mode: "required" }))
      .toEqual({ functionCallingConfig: { mode: "ANY" } });
    expect(await toolConfig(STRICT_TOOLS, { name: "get_weather" }))
      .toEqual({ functionCallingConfig: { mode: "ANY", allowedFunctionNames: ["get_weather"] } });
  });

  test("a request with no declared tools gains no toolConfig", async () => {
    expect(await toolConfig([])).toBeUndefined();
  });
});
