/**
 * The Anthropic adapter honours the shared strip flag for replayed opaque thinking state: when
 * the request's serving identity changed (or the blob was already rejected), signed thinking and
 * redacted_thinking blocks are not replayed. Without the flag they replay verbatim.
 */
import { describe, expect, test } from "bun:test";
import { createAnthropicAdapter as createAnthropicAdapterProduction } from "../../../src/adapters/anthropic";
import { parseRequest } from "../../../src/responses/parser";
import { encodeReasoningEnvelope } from "../../../src/responses/reasoning-envelope";
import type { OcxProviderConfig } from "../../../src/types";
import { withTestTranslatorBudget } from "../../helpers/translator-budget";

const createAnthropicAdapter = (...args: Parameters<typeof createAnthropicAdapterProduction>) =>
  withTestTranslatorBudget(createAnthropicAdapterProduction(...args));

const provider: OcxProviderConfig = {
  adapter: "anthropic",
  baseUrl: "https://anthropic-compatible.example",
  apiKey: "sk-test",
};

function signedHistory() {
  return parseRequest({
    model: "anthropic/claude-x",
    input: [
      { type: "reasoning", id: "rs_1", summary: [{ type: "summary_text", text: "chain" }],
        encrypted_content: encodeReasoningEnvelope({ sig: "RealSig1234567890==", red: ["REDDATA"] }) },
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "answer" }] },
      { type: "message", role: "user", content: [{ type: "input_text", text: "next" }] },
    ],
  });
}

async function wireBody(strip: boolean): Promise<string> {
  const parsed = signedHistory();
  if (strip) parsed._stripReasoningEncryptedContent = true;
  const request = await createAnthropicAdapter(provider).buildRequest(parsed) as { body: string };
  return request.body;
}

describe("anthropic adapter: replayed opaque thinking state", () => {
  test("replays signed and redacted blocks when the serving identity is unchanged", async () => {
    const body = await wireBody(false);
    expect(body).toContain("RealSig1234567890==");
    expect(body).toContain("REDDATA");
  });

  test("drops signed and redacted blocks when the strip flag is set, keeping the rest", async () => {
    const body = await wireBody(true);
    expect(body).not.toContain("RealSig1234567890==");
    expect(body).not.toContain("REDDATA");
    expect(body).not.toContain("redacted_thinking");
    expect(body).toContain("answer");
    expect(body).toContain("next");
  });
});
