import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createKiroAdapter } from "../../../src/adapters/kiro";
import { KIRO_TOOL_BUDGET_ENV, KIRO_TOOL_DESCRIPTION_LIMIT_ENV, MAX_KIRO_TOOL_CATALOG_BYTES, MAX_KIRO_TOOL_COUNT } from "../../../src/adapters/kiro-tools";
import type { OcxParsedRequest, OcxProviderConfig } from "../../../src/types";
import { removeTreeWithRetry } from "../../helpers/remove-tree";

// The catalog budget, the description cap, the Anthropic-surface nudge and the per-family schema
// policy all shape the tools Kiro receives. They live apart from kiro-adapter.test.ts so that file
// stays under its file-size cap; the isolation below still mirrors it, because buildRequest reads
// the native kiro-cli store from HOME and from the platform-specific profile roots.
const origHome = process.env.HOME;
const origLocalAppData = process.env.LOCALAPPDATA;
const origUserProfile = process.env.USERPROFILE;
const origRegion = process.env.KIRO_REGION;
const origOcxHome = process.env.OPENCODEX_HOME;
let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "kiro-tool-catalog-"));
  process.env.HOME = tmp;
  process.env.LOCALAPPDATA = join(tmp, "AppData", "Local");
  process.env.USERPROFILE = tmp;
  process.env.OPENCODEX_HOME = tmp;
  process.env.KIRO_REGION = "us-east-1";
});
afterEach(() => {
  if (origHome === undefined) delete process.env.HOME; else process.env.HOME = origHome;
  if (origLocalAppData === undefined) delete process.env.LOCALAPPDATA; else process.env.LOCALAPPDATA = origLocalAppData;
  if (origUserProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = origUserProfile;
  if (origRegion === undefined) delete process.env.KIRO_REGION; else process.env.KIRO_REGION = origRegion;
  if (origOcxHome === undefined) delete process.env.OPENCODEX_HOME; else process.env.OPENCODEX_HOME = origOcxHome;
  removeTreeWithRetry(tmp);
});

const provider = { adapter: "kiro", baseUrl: "https://runtime.us-east-1.kiro.dev", authMode: "oauth", apiKey: "tok-123" } as unknown as OcxProviderConfig;
const bashTool = { name: "bash", description: "Run a shell command", parameters: { type: "object" } };

function parsedWith(messages: unknown[], tools?: unknown[], modelId = "claude-sonnet-4.5"): OcxParsedRequest {
  return { modelId, stream: true, options: {}, context: { messages, tools } } as unknown as OcxParsedRequest;
}

describe("kiro catalog budget opt-out", () => {
  const origBudget = process.env[KIRO_TOOL_BUDGET_ENV];
  afterEach(() => {
    if (origBudget === undefined) delete process.env[KIRO_TOOL_BUDGET_ENV];
    else process.env[KIRO_TOOL_BUDGET_ENV] = origBudget;
  });

  // Claude Desktop declares its own tools last, so a budgeted catalog drops them first.
  const catalog = [
    ...Array.from({ length: MAX_KIRO_TOOL_COUNT + 60 }, (_, index) => ({
      name: `mcp__filler__tool_${String(index).padStart(3, "0")}`,
      description: `Filler ${index} ${"x".repeat(900)}`,
      parameters: { type: "object", properties: { value: { type: "string", description: "y".repeat(200) } } },
    })),
    { name: "mcp__ccd_turn__update_plan", description: "Update the plan", parameters: { type: "object" } },
    { name: "mcp__ccd_turn__wrap_up", description: "Wrap up the turn", parameters: { type: "object" } },
  ];

  async function emitted(): Promise<{ names: string[]; content: string }> {
    const { body } = await createKiroAdapter(provider).buildRequest(parsedWith([{ role: "user", content: "hi" }], catalog));
    const current = JSON.parse(body).conversationState.currentMessage.userInputMessage;
    return {
      names: current.userInputMessageContext.tools.slice(0, -1).map((tool: { toolSpecification: { name: string } }) => tool.toolSpecification.name),
      content: current.content,
    };
  }

  test("default keeps both budgets and drops the last-declared tools", async () => {
    delete process.env[KIRO_TOOL_BUDGET_ENV];
    const { names, content } = await emitted();

    expect(names.length).toBeLessThanOrEqual(MAX_KIRO_TOOL_COUNT);
    expect(names).not.toContain("mcp__ccd_turn__wrap_up");
    expect(content).toContain("Kiro's outbound catalog budget allows");
  });

  test("off sends the whole catalog in declared order without a notice", async () => {
    process.env[KIRO_TOOL_BUDGET_ENV] = "off";
    const { names, content } = await emitted();

    expect(new TextEncoder().encode(JSON.stringify(catalog)).byteLength).toBeGreaterThan(MAX_KIRO_TOOL_CATALOG_BYTES);
    expect(names).toEqual(catalog.map(tool => tool.name));
    expect(content).not.toContain("Kiro's outbound catalog budget allows");
  });

  test("any other value keeps the budget", async () => {
    process.env[KIRO_TOOL_BUDGET_ENV] = "0";
    const { names } = await emitted();

    expect(names.length).toBeLessThanOrEqual(MAX_KIRO_TOOL_COUNT);
  });
});

describe("kiro tool description limit opt-out", () => {
  const origLimit = process.env[KIRO_TOOL_DESCRIPTION_LIMIT_ENV];
  afterEach(() => {
    if (origLimit === undefined) delete process.env[KIRO_TOOL_DESCRIPTION_LIMIT_ENV];
    else process.env[KIRO_TOOL_DESCRIPTION_LIMIT_ENV] = origLimit;
  });

  const longDescription = `Long docs ${"x".repeat(5_000)} keep this tail.`;

  async function emittedDescription(modelId?: string): Promise<string> {
    const { body } = await createKiroAdapter(provider).buildRequest(
      parsedWith([{ role: "user", content: "hi" }], [{ name: "longtool", description: longDescription, parameters: { type: "object" } }], modelId),
    );
    return JSON.parse(body).conversationState.currentMessage.userInputMessage.userInputMessageContext.tools[0].toolSpecification.description;
  }

  test("default keeps the 1024-character cap", async () => {
    delete process.env[KIRO_TOOL_DESCRIPTION_LIMIT_ENV];

    expect(await emittedDescription()).toHaveLength(1024);
  });

  test("off sends every description whole, whatever the model", async () => {
    process.env[KIRO_TOOL_DESCRIPTION_LIMIT_ENV] = "off";

    expect(await emittedDescription()).toBe(longDescription);
    expect(await emittedDescription("gpt-5.6-sol")).toBe(longDescription);
  });

  test("any other value keeps the cap", async () => {
    process.env[KIRO_TOOL_DESCRIPTION_LIMIT_ENV] = "0";

    expect(await emittedDescription()).toHaveLength(1024);
  });
});

describe("kiro tool-catalog nudge and the Anthropic Messages surface", () => {
  // Claude Code and Claude Desktop send their own tool rules with the full catalog; the
  // Codex-oriented nudge (neighbour-tool bans, code-mode guidance) only repeats it.
  async function currentContent(anthropicInbound: boolean, modelId?: string): Promise<string> {
    const parsed = parsedWith([{ role: "user", content: "hi" }], [bashTool], modelId);
    if (anthropicInbound) parsed._anthropicInbound = true;
    const { body } = await createKiroAdapter(provider).buildRequest(parsed);
    return JSON.parse(body).conversationState.currentMessage.userInputMessage.content;
  }

  test("a Codex request keeps the nudge", async () => {
    expect(await currentContent(false)).toContain("Tool contract: use the current tool catalog as ground truth.");
  });

  test("a Claude request drops the nudge and keeps the completion contract", async () => {
    const content = await currentContent(true);

    expect(content).not.toContain("Tool contract:");
    expect(content).not.toContain("neighboring-agent tool names");
    expect(content).toContain("call codex_kiro_final_answer exactly once");
  });

  test("a non-Claude model on the Messages surface drops the nudge too", async () => {
    // The nudge is scoped to the inbound surface, not the routed model: it names Codex-only
    // concepts (code mode, neighbour-tool bans), and every Messages client ships its own tool
    // rules. A model-conditional rule would hand a routed DeepSeek or MiniMax turn guidance about
    // a harness whose tools that turn does not have.
    const content = await currentContent(true, "deepseek-3.2");

    expect(content).not.toContain("Tool contract:");
    expect(content).toContain("call codex_kiro_final_answer exactly once");
    // The Codex surface still carries it for that same model.
    expect(await currentContent(false, "deepseek-3.2")).toContain("Tool contract:");
  });
});

describe("kiro tool schemas by model family", () => {
  // PR #8451 reports individual opus-4.5 keyword probes and names pattern and maximum
  // in a constrained-tool probe for the two 5.5 models. Other keys remain stripped.
  const constrained = {
    $schema: "http://json-schema.org/draft-07/schema#",
    type: "object",
    additionalProperties: false,
    properties: {
      city: { type: "string", pattern: "^[A-Z][a-z]+$", maxLength: 20, format: "hostname" },
      days: { type: "integer", minimum: 1, maximum: 7 },
      tags: { type: "array", items: { type: "string" }, maxItems: 3, uniqueItems: true },
    },
    required: ["city", "days"],
  };
  // The same schema after the two 5.5 ids' measured keywords survive and the rest are stripped.
  const constrainedMeasuredOn55 = {
    type: "object",
    properties: {
      city: { type: "string", pattern: "^[A-Z][a-z]+$" },
      days: { type: "integer", maximum: 7 },
      tags: { type: "array", items: { type: "string" } },
    },
    required: ["city", "days"],
  };
  const stripped = {
    type: "object",
    properties: {
      city: { type: "string" },
      days: { type: "integer" },
      tags: { type: "array", items: { type: "string" } },
    },
    required: ["city", "days"],
  };

  async function emittedSchema(modelId: string): Promise<Record<string, any>> {
    const { body } = await createKiroAdapter(provider).buildRequest(
      parsedWith([{ role: "user", content: "hi" }], [{ name: "forecast", description: "Forecast", parameters: constrained }], modelId),
    );
    return JSON.parse(body).conversationState.currentMessage.userInputMessage.userInputMessageContext.tools[0].toolSpecification.inputSchema.json;
  }

  test("claude-opus-4.5 receives the schema with every keyword, the id probed one per request", async () => {
    expect(await emittedSchema("claude-opus-4.5")).toEqual(constrained);
  });

  test("the two 5.5 ids keep only the keywords their probe covered", async () => {
    // The PR only names two tested keywords for these ids; other constraints stay stripped.
    for (const modelId of ["claude-opus-5.5", "claude-sonnet-5.5"]) {
      expect(await emittedSchema(modelId)).toEqual(constrainedMeasuredOn55);
    }
  });

  test("an unmeasured Claude model keeps the strip instead of inheriting the measurement", async () => {
    // Haiku 5.5 is in KIRO_MODELS and shares the Claude wire, but the PR reports no keyword probe for it.
    // Guessing wide turns an unmeasured keyword into an upstream ValidationException.
    for (const modelId of ["claude-haiku-5.5", "claude-sonnet-4.5", "claude-opus-4.8"]) {
      expect(await emittedSchema(modelId)).toEqual(stripped);
    }
  });

  test("a non-Claude model still receives the stripped schema", async () => {
    const schema = await emittedSchema("gpt-5.6-sol");
    expect(schema.$schema).toBeUndefined();
    expect(schema.additionalProperties).toBeUndefined();
    expect(schema.properties.city).toEqual({ type: "string" });
    expect(schema.properties.days).toEqual({ type: "integer" });
    expect(schema.properties.tags).toEqual({ type: "array", items: { type: "string" } });
    expect(schema.required).toEqual(["city", "days"]);
  });

  test("a Claude root composition is still flattened to an object", async () => {
    const { body } = await createKiroAdapter(provider).buildRequest(
      parsedWith([{ role: "user", content: "hi" }], [{
        name: "either", description: "Either", parameters: { oneOf: [{ type: "object", properties: { a: { type: "string", maxLength: 3 } } }] },
        // opus-4.5, because `maxLength` is only measured to survive on that id: this case checks
        // flattening, not the keyword exception.
      }], "claude-opus-4.5"),
    );
    const schema = JSON.parse(body).conversationState.currentMessage.userInputMessage.userInputMessageContext.tools[0].toolSpecification.inputSchema.json;
    expect(schema.type).toBe("object");
    expect(schema.oneOf).toBeUndefined();
    expect(schema.properties.a).toEqual({ type: "string", maxLength: 3 });
  });
});

describe("Kiro effort fallback", () => {
  test("the minimal fallback is that one value, not any effort the ladder does not know", async () => {
    // The legacy outside-ladder value is `minimal`; `ultra` is folded to `max`. If the
    // fallback keyed on "not in KIRO_NATIVE_EFFORTS" instead of the value, a future rung would
    // silently lose reasoning here instead of failing where the operator can see it.
    for (const modelId of ["claude-opus-4.8", "claude-sonnet-5.5"]) {
      await expect(createKiroAdapter(provider).buildRequest({
        ...parsedWith([{ role: "user", content: "solve" }], undefined, modelId),
        options: { reasoning: "unheard-of" },
      })).rejects.toThrow(`Kiro ${modelId} does not support reasoning effort "unheard-of"`);
    }
  });
});
