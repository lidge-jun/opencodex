# 100.53 — E2E-Style Verification Gap Closure Plan

## Objective

Close the final review gap: Phase 100 has unit/integration coverage, but no explicit
`tests/e2e-style/` artifact. Add a local e2e-style smoke test that exercises the Codex-native parity
path across catalog metadata, Responses request parsing, web-search sidecar planning, and bridge
failure output.

No runtime source changes are planned.

## Files

### NEW

```text
/Users/jun/Developer/new/700_projects/opencodex/tests/e2e-style/phase100-native-parity.test.ts
```

Complete content:

```ts
import { describe, expect, test } from "bun:test";
import { bridgeToResponsesSSE } from "../../src/bridge";
import { buildCatalogEntries } from "../../src/codex-catalog";
import { parseRequest } from "../../src/responses/parser";
import { planWebSearch } from "../../src/web-search";
import type { AdapterEvent, OcxConfig, OcxProviderConfig } from "../../src/types";

function nativeTemplate(): Record<string, unknown> {
  return {
    slug: "gpt-5.5",
    display_name: "gpt-5.5",
    description: "Native GPT model",
    priority: 1,
    visibility: "list",
    base_instructions: "You are Codex, a coding agent based on GPT-5.",
    model_messages: { instructions_template: "You are Codex, a coding agent based on GPT-5." },
    tool_mode: "code",
    multi_agent_version: "v2",
    use_responses_lite: true,
    supports_websockets: true,
    web_search_tool_type: "text_and_image",
    supports_search_tool: true,
    supported_reasoning_levels: [
      { effort: "low", description: "native low" },
      { effort: "medium", description: "native medium" },
      { effort: "high", description: "native high" },
      { effort: "xhigh", description: "native xhigh" },
    ],
  };
}

async function* replay(events: AdapterEvent[]): AsyncGenerator<AdapterEvent> {
  for (const event of events) yield event;
}

async function collectSse(stream: ReadableStream<Uint8Array>): Promise<{ event?: string; data: Record<string, unknown> }[]> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  return text.split("\n\n")
    .map(frame => frame.trim())
    .filter(frame => frame.length > 0 && frame !== "data: [DONE]")
    .map(frame => {
      const lines = frame.split("\n");
      const event = lines.find(line => line.startsWith("event: "))?.slice(7);
      const dataLine = lines.find(line => line.startsWith("data: "));
      return { event, data: JSON.parse(dataLine?.slice(6) ?? "{}") as Record<string, unknown> };
    });
}

describe("Phase 100 Codex-native parity smoke", () => {
  test("routed model keeps native-like catalog affordances while runtime routes through opencodex sidecars and bridge errors", async () => {
    const routedProvider: OcxProviderConfig = {
      adapter: "openai-chat",
      baseUrl: "https://routed.example/v1",
      apiKey: "routed-key",
      noVisionModels: ["deepseek-v4-pro"],
    };
    const forwardProvider: OcxProviderConfig = {
      adapter: "openai-responses",
      baseUrl: "https://chatgpt.example/v1",
      authMode: "forward",
    };
    const config: OcxConfig = {
      port: 10100,
      defaultProvider: "opencode-go",
      providers: {
        "opencode-go": routedProvider,
        chatgpt: forwardProvider,
      },
    };

    const catalog = buildCatalogEntries(nativeTemplate(), ["gpt-5.5"], [
      { provider: "opencode-go", id: "deepseek-v4-pro" },
    ]);
    const routed = catalog.find(entry => entry.slug === "opencode-go/deepseek-v4-pro");
    expect(routed).toMatchObject({
      web_search_tool_type: "text_and_image",
      supports_search_tool: true,
      context_window: 1_000_000,
      auto_compact_token_limit: 900_000,
    });
    expect(routed).not.toHaveProperty("model_messages");
    expect(routed).not.toHaveProperty("use_responses_lite");
    expect(routed).not.toHaveProperty("supports_websockets");

    const parsed = parseRequest({
      model: "opencode-go/deepseek-v4-pro",
      stream: true,
      input: "Search current docs, then answer.",
      tools: [
        { type: "web_search", search_context_size: "medium" },
        { type: "tool_search", description: "Load extra tools" },
      ],
    });
    expect(parsed._webSearch).toMatchObject({ type: "web_search", search_context_size: "medium" });
    expect(parsed.context.tools?.some(tool => tool.toolSearch)).toBe(true);

    const searchPlan = planWebSearch(
      config,
      parsed,
      false,
      new Headers({ authorization: "Bearer forwarded-chatgpt" }),
      routedProvider,
      "deepseek-v4-pro",
    );
    expect(searchPlan).toMatchObject({
      forwardProvider,
      settings: {
        model: "gpt-5.4-mini",
        describeImages: true,
      },
    });

    const frames = await collectSse(bridgeToResponsesSSE(replay([
      { type: "error", message: "Your input exceeds the context window" },
    ]), "deepseek-v4-pro"));
    const failed = frames.find(frame => frame.event === "response.failed")?.data.response as Record<string, unknown>;
    expect(failed.error).toMatchObject({
      code: "context_length_exceeded",
      type: "invalid_request_error",
    });
  });
});
```

## Verification

Run:

```bash
bun test tests/e2e-style/phase100-native-parity.test.ts
bun test tests
bun x tsc --noEmit
git diff --check
```

Expected result:

```text
e2e-style smoke test passes
full test suite passes
typecheck passes
diff whitespace check passes
```

## Commit

Commit as:

```text
[agent] test: add phase 100 parity smoke
```
