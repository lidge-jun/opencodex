import { describe, expect, test } from "bun:test";
import { createAnthropicAdapter as createAnthropicAdapterProduction } from "../src/adapters/anthropic";
import { withTestTranslatorBudget } from "./helpers/translator-budget";
import type { OcxMessage, OcxParsedRequest, OcxProviderConfig } from "../src/types";

const createAnthropicAdapter = (...args: Parameters<typeof createAnthropicAdapterProduction>) =>
  withTestTranslatorBudget(createAnthropicAdapterProduction(...args));

const PREAMBLE = "[Instruction: Process the user request below and respond in the appropriate language.]";
const PORTUGUESE = "responda apenas: OK";

interface TextBlock { type: string; text?: string }
interface WireMessage { role: string; content: string | TextBlock[] }
interface WireBody { messages: WireMessage[] }

function providerAt(baseUrl: string): OcxProviderConfig {
  return { adapter: "anthropic", baseUrl, apiKey: "key", authMode: "key" };
}

function requestWith(messages: OcxMessage[]): OcxParsedRequest {
  return {
    modelId: "claude-opus-4-6",
    stream: false,
    context: { messages, tools: [] },
    options: {},
  };
}

async function bodyFor(baseUrl: string, messages: OcxMessage[]): Promise<WireBody> {
  const req = await createAnthropicAdapter(providerAt(baseUrl)).buildRequest(requestWith(messages));
  return JSON.parse(req.body as string) as WireBody;
}

/**
 * The adapter also stamps `cache_control` onto the trailing block, which is orthogonal to this
 * fix. Comparing the text sequence keeps these assertions about the framing and stops them from
 * going red the next time the cache policy is tuned.
 */
function texts(message: WireMessage | undefined): (string | undefined)[] {
  if (!message) throw new Error("expected a message at that index");
  if (typeof message.content === "string") return [message.content];
  return message.content.map(block => block.text);
}

// AgentRouter answers 400 content-blocked when the first user message is not in English
// (#2074) while the identical English request returns 200. The gateway reads the opening user
// content, so the framing has to live in that turn -- an Anthropic `system` string never
// reaches the filter. Absorbed from #2082 by @yzxcj797.
describe("AgentRouter language framing", () => {
  test("frames the first user turn without touching the user's own text", async () => {
    const body = await bodyFor("https://agentrouter.org/v1", [{ role: "user", content: PORTUGUESE }]);
    // The framing is its OWN block. Splicing it into the user's string would make every
    // downstream reader -- logs, retries, an upstream that echoes the turn -- attribute a
    // sentence to the user that they never typed.
    expect(texts(body.messages[0])).toEqual([PREAMBLE, PORTUGUESE]);
  });

  test("an existing block array keeps every original block, in order, after the preamble", async () => {
    const body = await bodyFor("https://agentrouter.org/v1", [
      { role: "user", content: [{ type: "text", text: "primeiro" }, { type: "text", text: "segundo" }] },
    ]);
    expect(texts(body.messages[0])).toEqual([PREAMBLE, "primeiro", "segundo"]);
  });

  test("only the first user turn is framed", async () => {
    const body = await bodyFor("https://agentrouter.org/v1", [
      { role: "user", content: PORTUGUESE },
      { role: "assistant", content: "OK" },
      { role: "user", content: "e agora?" },
    ]);
    expect(texts(body.messages[0])).toEqual([PREAMBLE, PORTUGUESE]);
    // Index-free on purpose: the adapter may coalesce adjacent turns, so the invariant is
    // "exactly one preamble, on the opening turn", not "the preamble is absent at index 2".
    const userTurns = body.messages.filter(m => m.role === "user");
    expect(texts(userTurns.at(-1))).toEqual(["e agora?"]);
    expect(JSON.stringify(body.messages).split(PREAMBLE)).toHaveLength(2);
  });

  test("direct Anthropic is untouched", async () => {
    const body = await bodyFor("https://api.anthropic.com/v1", [{ role: "user", content: PORTUGUESE }]);
    expect(texts(body.messages[0])).toEqual([PORTUGUESE]);
    expect(JSON.stringify(body)).not.toContain(PREAMBLE);
  });

  // A hostname.includes("agentrouter") test would match both of these, quietly injecting an
  // instruction block into a destination that never asked for one.
  test.each([
    "https://notagentrouter.example/v1",
    "https://agentrouter.org.attacker.example/v1",
  ])("a lookalike host is not treated as AgentRouter: %s", async baseUrl => {
    const body = await bodyFor(baseUrl, [{ role: "user", content: PORTUGUESE }]);
    expect(texts(body.messages[0])).toEqual([PORTUGUESE]);
    expect(JSON.stringify(body)).not.toContain(PREAMBLE);
  });

  test("a real AgentRouter subdomain is still AgentRouter", async () => {
    const body = await bodyFor("https://api.agentrouter.org/v1", [{ role: "user", content: PORTUGUESE }]);
    expect(texts(body.messages[0])).toEqual([PREAMBLE, PORTUGUESE]);
  });

  test("building twice yields exactly one preamble each time", async () => {
    const adapter = createAnthropicAdapter(providerAt("https://agentrouter.org/v1"));
    for (const attempt of [0, 1]) {
      const req = await adapter.buildRequest(requestWith([{ role: "user", content: PORTUGUESE }]));
      const body = JSON.parse(req.body as string) as WireBody;
      expect(texts(body.messages[0]).filter(t => t === PREAMBLE)).toHaveLength(1);
      expect(attempt).toBeLessThan(2);
    }
  });

  // Idempotence keyed on a substring would let a user who quotes the marker mid-prompt
  // suppress their own framing, which is the failure the workaround exists to prevent.
  test("a user quoting the marker later still gets the leading preamble", async () => {
    const quoted = `o servidor respondeu ${PREAMBLE} e falhou`;
    const body = await bodyFor("https://agentrouter.org/v1", [{ role: "user", content: quoted }]);
    expect(texts(body.messages[0])).toEqual([PREAMBLE, quoted]);
  });

  // An assistant-only request is synthesized into a "(continue)" user turn upstream of this
  // code, so the framing lands on that synthetic turn rather than on nothing. Pinned because it
  // is the one case where the preamble is attached to text the user did not send.
  test("an assistant-only request frames the synthesized continue turn", async () => {
    const body = await bodyFor("https://agentrouter.org/v1", [{ role: "assistant", content: "só isso" }]);
    expect(texts(body.messages[0])).toEqual([PREAMBLE, "(continue)"]);
  });
});
