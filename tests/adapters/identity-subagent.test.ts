import { afterEach, describe, expect, test } from "bun:test";
import {
  CODEX_GPT5_IDENTITY_LINE,
  identifyRoutedModel,
  nameRoutedIdentity,
  NEUTRAL_IDENTITY_LINE,
  renameRoutedIdentityInContext,
  repairIdentityInResponsesBody,
  repairRoutedIdentity,
  stripRoutedIdentity,
} from "../../src/adapters/identity";
import { createOpenAIChatAdapter } from "../../src/adapters/openai-chat";
import { createResponsesPassthroughAdapter } from "../../src/adapters/openai-responses";
import { parseRequest } from "../../src/responses/parser";
import type { OcxConfig, OcxProviderConfig, OcxTextContent } from "../../src/types";
import { handleResponses } from "../../src/server/responses/core";
import type { RequestLogContext } from "../../src/server/request-log";
import { withTestTranslatorBudget } from "../helpers/translator-budget";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";

const originalFetch = globalThis.fetch;
let releaseSpendHome: (() => void) | undefined;

afterEach(() => {
  // Release the ledger lease before later teardown can replace the preload sandbox home.
  releaseSpendHome?.();
  releaseSpendHome = undefined;
  globalThis.fetch = originalFetch;
});

/** The sentence the proxy generated for the PARENT session, which a spawned worker inherits (#5217). */
const PARENT_IDENTITY = "You are a coding agent powered by the deepseek-v4.1-flash. If asked which model you are, identify as deepseek-v4.1-flash. Do not claim to be a different model or to have a different creator.";

const WORKER_MODEL = "gpt-6-astra";

function developerItem(text: string) {
  return { type: "message", role: "developer", content: [{ type: "input_text", text }] };
}

function systemPromptOf(instructions: string): string {
  return parseRequest({ model: WORKER_MODEL, instructions, input: [] }).context.systemPrompt!.join("\n\n");
}

function textOf(content: unknown): string {
  return typeof content === "string"
    ? content
    : (content as OcxTextContent[]).map(part => part.text).join("");
}

/** The Responses passthrough forwards `_rawBody` mostly verbatim, so identity repair is its own step. */
function passthroughBody(
  provider: OcxProviderConfig,
  instructions: string,
  input: unknown = "ping",
): Record<string, unknown> {
  const request = withTestTranslatorBudget(createResponsesPassthroughAdapter(provider)).buildRequest({
    modelId: WORKER_MODEL,
    context: { messages: [] },
    stream: true,
    options: {},
    _rawBody: { model: WORKER_MODEL, instructions, input },
  }, { headers: new Headers() });
  return JSON.parse(request.body) as Record<string, unknown>;
}

/** A first-party destination: Codex's own model_switch identity is authoritative there. */
function forwardProvider(): OcxProviderConfig {
  return {
    adapter: "openai-responses",
    baseUrl: "https://chatgpt.com/backend-api/codex",
    authMode: "forward",
  } as unknown as OcxProviderConfig;
}

describe("sub-agent identity inheritance (#5217)", () => {
  test("a stale routed identity sentence is rewritten to the destination model", () => {
    const out = repairRoutedIdentity(`${PARENT_IDENTITY}\n\nUse tools carefully.`, WORKER_MODEL);
    expect(out).toContain(`identify as ${WORKER_MODEL}`);
    expect(out).not.toContain("deepseek-v4.1-flash");
    expect(out).toContain("Use tools carefully.");
  });

  test("identifyRoutedModel also repairs a stale sentence and the neutral catalog line", () => {
    expect(identifyRoutedModel(PARENT_IDENTITY, WORKER_MODEL)).toContain(`identify as ${WORKER_MODEL}`);
    expect(identifyRoutedModel(NEUTRAL_IDENTITY_LINE, WORKER_MODEL)).toContain(`identify as ${WORKER_MODEL}`);
  });

  test("nameRoutedIdentity names the model-neutral catalog line", () => {
    // The catalog block is model-neutral on disk (#5217), so a routed adapter that builds its own
    // system text has to be given the destination id here — the neutral text alone names no model.
    const out = nameRoutedIdentity(`${NEUTRAL_IDENTITY_LINE}\n\nUse tools carefully.`, WORKER_MODEL);
    expect(out).toContain(`powered by the ${WORKER_MODEL}`);
    expect(out).toContain(`identify as ${WORKER_MODEL}`);
    expect(out).not.toContain(NEUTRAL_IDENTITY_LINE);
    expect(out).toContain("Use tools carefully.");
  });

  test("a native destination drops the routed sentence instead of renaming it", () => {
    const out = stripRoutedIdentity(`${PARENT_IDENTITY}\n\nYou and the user share one workspace.`);
    expect(out).not.toContain("powered by the");
    expect(out).not.toContain("deepseek-v4.1-flash");
    expect(out).toBe("You and the user share one workspace.");
  });

  test("a native destination drops the model-neutral catalog line too", () => {
    // Since #5217 the on-disk catalog block carries this line, so it reaches a native worker with
    // no routed parent involved — and there it contradicts the identity Codex sends itself.
    const out = stripRoutedIdentity(`${NEUTRAL_IDENTITY_LINE}\n\nYou and the user share one workspace.`);
    expect(out).not.toContain("Do not claim to be GPT-5");
    expect(out).not.toContain(NEUTRAL_IDENTITY_LINE);
    expect(out).toBe("You and the user share one workspace.");
  });

  test("text the proxy did not generate is never rewritten", () => {
    for (const text of [
      "The user asked: which model are you?",
      "```\nYou are a coding agent powered by the thing I wrote myself.\n```",
      "You are a Claude agent built by Anthropic.",
      CODEX_GPT5_IDENTITY_LINE,
    ]) {
      expect(repairRoutedIdentity(text, WORKER_MODEL)).toBe(text);
      expect(nameRoutedIdentity(text, WORKER_MODEL)).toBe(text);
      expect(stripRoutedIdentity(text)).toBe(text.trim());
    }
  });

  test("the parser names the destination in the top-level instructions block", () => {
    // This is a routed adapter's path: some never call identifyRoutedModel, so the stored block
    // reaches the wire as-is unless the parser names the model the request is going to.
    expect(systemPromptOf(PARENT_IDENTITY)).toContain(`identify as ${WORKER_MODEL}`);
    expect(systemPromptOf(PARENT_IDENTITY)).not.toContain("deepseek-v4.1-flash");
    expect(systemPromptOf(NEUTRAL_IDENTITY_LINE)).toContain(`identify as ${WORKER_MODEL}`);
  });

  test("the parser leaves Codex's own GPT identity line alone", () => {
    // Adapters handle that line; naming a routed model is this layer's job only.
    expect(systemPromptOf(CODEX_GPT5_IDENTITY_LINE)).toBe(CODEX_GPT5_IDENTITY_LINE);
  });

  test("the parser repairs the worker's developer item and leaves user turns alone", () => {
    const parsed = parseRequest({
      model: WORKER_MODEL,
      input: [
        developerItem(PARENT_IDENTITY),
        developerItem(NEUTRAL_IDENTITY_LINE),
        { type: "message", role: "user", content: [{ type: "input_text", text: PARENT_IDENTITY }] },
      ],
    });
    const [developer, neutralDeveloper, user] = parsed.context.messages;
    expect(textOf(developer!.content)).toContain(`identify as ${WORKER_MODEL}`);
    expect(textOf(developer!.content)).not.toContain("deepseek-v4.1-flash");
    expect(textOf(neutralDeveloper!.content)).toContain(`identify as ${WORKER_MODEL}`);
    // A user turn is the caller's own content; it stays byte-identical.
    expect(textOf(user!.content)).toBe(PARENT_IDENTITY);
  });

  test("the parser names a system-role instruction item too", () => {
    // A system-role item is instruction text on the same terms as `instructions` and a developer
    // item: the parser flattens it into the system block, which a sub-agent then inherits.
    const parsed = parseRequest({
      model: WORKER_MODEL,
      input: [
        { type: "message", role: "system", content: [{ type: "input_text", text: PARENT_IDENTITY }] },
        { type: "message", role: "system", content: NEUTRAL_IDENTITY_LINE },
        { type: "message", role: "system", content: "Keep this line." },
      ],
    });
    const system = parsed.context.systemPrompt!.join("\n");
    expect(system).toContain(`identify as ${WORKER_MODEL}`);
    expect(system).not.toContain("deepseek-v4.1-flash");
    expect(system).not.toContain(NEUTRAL_IDENTITY_LINE);
    expect(system).toContain("Keep this line.");
  });

  test("the request-time rename rewrites every instruction carrier and nothing else", () => {
    const parsed = parseRequest({
      model: WORKER_MODEL,
      instructions: PARENT_IDENTITY,
      input: [
        developerItem(PARENT_IDENTITY),
        { type: "message", role: "system", content: [{ type: "input_text", text: PARENT_IDENTITY }] },
        { type: "message", role: "user", content: [{ type: "input_text", text: PARENT_IDENTITY }] },
      ],
    });
    // The parser named the CLIENT-side model; the route owner settles the id that is really sent.
    const renamed = renameRoutedIdentityInContext(parsed.context, "wire-model-9");
    expect(renamed).not.toBe(parsed.context);
    expect(renamed.systemPrompt!.join("\n")).toContain("identify as wire-model-9");
    expect(textOf(renamed.messages[0]!.content)).toContain("identify as wire-model-9");
    // A user turn is the caller's own content, so it stays byte-identical — and the context the
    // caller passed in is left as it was rather than mutated under it.
    expect(textOf(renamed.messages[1]!.content)).toBe(PARENT_IDENTITY);
    expect(parsed.context.systemPrompt!.join("\n")).toContain(`identify as ${WORKER_MODEL}`);
  });

  test("a context with no sentence of ours is returned by reference", () => {
    const parsed = parseRequest({ model: WORKER_MODEL, input: [developerItem("plain instructions")] });
    expect(renameRoutedIdentityInContext(parsed.context, "wire-model-9")).toBe(parsed.context);
  });

  test("a routed chat destination sends the worker's own model in the system message", async () => {
    const provider = {
      adapter: "openai-chat",
      baseUrl: "https://api.example.invalid",
      apiKey: "key",
    } as unknown as OcxProviderConfig;
    const parsed = parseRequest({
      model: "some/routed-worker",
      input: [
        developerItem(PARENT_IDENTITY),
        { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
      ],
    });
    const { body } = await createOpenAIChatAdapter(provider).buildRequest(parsed);
    const system = (JSON.parse(body).messages as { role: string; content: string }[])
      .find(message => message.role === "system")!;
    expect(system.content).toContain("identify as some/routed-worker");
    expect(system.content).not.toContain("deepseek-v4.1-flash");
  });

  test("the Responses body repair covers instructions and developer items only", () => {
    const body = {
      model: WORKER_MODEL,
      instructions: PARENT_IDENTITY,
      input: [
        developerItem(PARENT_IDENTITY),
        { type: "message", role: "user", content: [{ type: "input_text", text: PARENT_IDENTITY }] },
      ],
    };
    const routed = repairIdentityInResponsesBody(body, text => nameRoutedIdentity(text, WORKER_MODEL)) as typeof body;
    expect(routed.instructions).toContain(`identify as ${WORKER_MODEL}`);
    expect((routed.input[0]!.content as { text: string }[])[0]!.text).toContain(`identify as ${WORKER_MODEL}`);
    expect((routed.input[1]!.content as { text: string }[])[0]!.text).toBe(PARENT_IDENTITY);
  });

  test("a forward destination drops a stripped instructions value instead of sending it empty", () => {
    const body = { model: WORKER_MODEL, instructions: PARENT_IDENTITY, input: [developerItem(PARENT_IDENTITY)] };
    const native = repairIdentityInResponsesBody(body, stripRoutedIdentity) as {
      instructions?: string;
      input: { content: { text: string }[] }[];
    };
    // `""` is a different request from an absent key, and an instruction item that held only our
    // sentence is a message the caller never wrote.
    expect(native).not.toHaveProperty("instructions");
    expect(native.input).toHaveLength(0);

    const kept = repairIdentityInResponsesBody({
      model: WORKER_MODEL,
      instructions: `${PARENT_IDENTITY}\n\nKeep this.`,
      input: [{
        type: "message",
        role: "developer",
        content: [{ type: "input_text", text: PARENT_IDENTITY }, { type: "input_image", image_url: "data:x" }],
      }],
    }, stripRoutedIdentity) as { instructions: string; input: { content: { type: string }[] }[] };
    expect(kept.instructions).toBe("Keep this.");
    // The image part is content, so an item holding one is not empty and stays.
    expect(kept.input).toHaveLength(1);
  });

  test("a body with no proxy identity is returned unchanged", () => {
    const body = { model: WORKER_MODEL, input: [developerItem("plain instructions")] };
    expect(repairIdentityInResponsesBody(body, text => nameRoutedIdentity(text, WORKER_MODEL))).toBe(body);
    expect(repairIdentityInResponsesBody(body, stripRoutedIdentity)).toBe(body);
  });

  test("the Responses passthrough names the destination on a routed destination", () => {
    const provider = {
      adapter: "openai-responses",
      baseUrl: "https://api.example.invalid/v1",
      authMode: "key",
      apiKey: "key",
    } as unknown as OcxProviderConfig;
    const body = passthroughBody(provider, `${NEUTRAL_IDENTITY_LINE}\n\nUse tools carefully.`);
    expect(body.instructions).toContain(`identify as ${WORKER_MODEL}`);
    expect(body.instructions).not.toContain(NEUTRAL_IDENTITY_LINE);
    expect(body.instructions).toContain("Use tools carefully.");
  });

  test("the Responses passthrough drops our sentence on a forward destination", () => {
    const provider = forwardProvider();
    // Codex's own identity wording is the correct one at a first-party destination, and an empty
    // instruction string is a different payload from an absent key.
    expect(passthroughBody(provider, `${PARENT_IDENTITY}\n\nKeep this.`).instructions).toBe("Keep this.");
    expect(passthroughBody(provider, PARENT_IDENTITY)).not.toHaveProperty("instructions");
  });

  test("the Responses passthrough drops the neutral line from instructions and developer items", () => {
    const body = passthroughBody(forwardProvider(), `${NEUTRAL_IDENTITY_LINE}\n\nKeep this.`, [
      {
        type: "message",
        role: "developer",
        content: [{ type: "input_text", text: `${NEUTRAL_IDENTITY_LINE}\n\nAlso keep this.` }],
      },
    ]);
    expect(body.instructions).toBe("Keep this.");
    const item = (body.input as { content: { text: string }[] }[])[0]!;
    expect(item.content[0]!.text).toBe("Also keep this.");
  });

  test("the Responses passthrough drops an instructions value that was only the neutral line", () => {
    expect(passthroughBody(forwardProvider(), NEUTRAL_IDENTITY_LINE)).not.toHaveProperty("instructions");
  });
});

/**
 * A routed destination whose adapter never calls `identifyRoutedModel`: the parsed context is the
 * wire payload, so the sentence the parser wrote is the sentence the provider reads.
 */
function nativeWireConfig(): OcxConfig {
  return {
    port: 0,
    defaultProvider: "local-llm",
    providers: {
      "local-llm": {
        adapter: "ollama-native",
        baseUrl: "http://127.0.0.1:11434",
        authMode: "local",
        allowPrivateNetwork: true,
      },
    },
  } as unknown as OcxConfig;
}

describe("routed identity names the wire model, not the client selector (#5221)", () => {
  test("a namespaced client selector is settled on the routed model id before the send", async () => {
    let upstreamSystem = "";
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      // A native Ollama provider with live models enabled probes `/api/tags` while routing; only
      // the chat call carries the context under test.
      if (!request.url.includes("/api/chat")) {
        return new Response(JSON.stringify({ models: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      const body = await request.clone().json() as {
        stream?: boolean;
        messages?: { role: string; content: string }[];
      };
      upstreamSystem = body.messages?.find(message => message.role === "system")?.content ?? "";
      const summary = {
        model: "llama3.1:8b",
        message: { role: "assistant", content: "ok" },
        done: true,
        done_reason: "stop",
        prompt_eval_count: 1,
        eval_count: 1,
      };
      return new Response(JSON.stringify(summary), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    // Direct dispatch needs the writer lease that prevents spend-ledger ownership failures.
    releaseSpendHome = acquireOwnedSpendHome();
    const response = await handleResponses(
      new Request("http://localhost/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "local-llm/llama3.1:8b",
          instructions: PARENT_IDENTITY,
          input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }],
        }),
      }),
      nativeWireConfig(),
      { model: "", provider: "" } as RequestLogContext,
      {},
    );

    expect(response.status).toBe(200);
    // The parser could only name the CLIENT selector — routing had not run. The id that reaches
    // the provider is the routed one, so that is the id the identity sentence must name.
    expect(upstreamSystem).toContain("identify as llama3.1:8b");
    expect(upstreamSystem).not.toContain("local-llm/llama3.1:8b");
    expect(upstreamSystem).not.toContain("deepseek-v4.1-flash");
  });
});
