import { describe, expect, test } from "bun:test";
import { estimateKiroWireTokens, KIRO_LATIN_WIRE_EXPANSION, kiroCjkCount } from "../../../src/adapters/kiro/usage";
import { estimateTokens } from "../../../src/lib/token-estimate";
import { createKiroAdapter } from "../../../src/adapters/kiro";
import { encodeMessage } from "../../../src/lib/eventstream-decoder";
import type { OcxParsedRequest, OcxProviderConfig } from "../../../src/types";
import { withTestTranslatorBudget } from "../../helpers/translator-budget";

describe("kiro wire token estimate", () => {
  const model = "claude-opus-5";

  // The mixed-script path must produce the same estimate as materializing per-script
  // replacement strings did, without allocating them.
  test("mixed-script estimate matches the replacement-string formula", () => {
    const text = "const x = fetch(url); // 요청을 보내고 응답을 파싱한다".repeat(50);
    const cjk = kiroCjkCount(text);
    const prefixed = `kiro/${model}`;
    const expected = Math.ceil(
      estimateTokens("x".repeat(text.length - cjk), prefixed) * KIRO_LATIN_WIRE_EXPANSION
      + estimateTokens("\uac00".repeat(cjk), prefixed),
    );
    expect(estimateKiroWireTokens(text, model)).toBe(expected);
  });

  test("pure-Latin text keeps the wire expansion on the whole estimate", () => {
    const english = "console.log(\"hello world\");".repeat(20);
    expect(estimateKiroWireTokens(english, model))
      .toBe(Math.ceil(estimateTokens(english, `kiro/${model}`) * KIRO_LATIN_WIRE_EXPANSION));
  });

  test("empty text estimates to zero", () => {
    expect(estimateKiroWireTokens("", model)).toBe(0);
  });

  test("pure-CJK text and an empty model id keep the replacement-string results", () => {
    const korean = "요청을보내고응답을파싱한다".repeat(30);
    const cjk = kiroCjkCount(korean);
    const latin = korean.length - cjk;
    expect(latin).toBe(0);
    const expectedFor = (prefixed: string) => Math.ceil(
      estimateTokens("x".repeat(latin), prefixed) * KIRO_LATIN_WIRE_EXPANSION
      + estimateTokens("\uac00".repeat(cjk), prefixed),
    );
    expect(estimateKiroWireTokens(korean, model)).toBe(expectedFor(`kiro/${model}`));
    // The old path fell back to the bare "kiro" id for an empty model; both select the Kiro ratio.
    expect(estimateKiroWireTokens(korean, "")).toBe(expectedFor("kiro"));
  });

  test("empty model id uses the Kiro ratio for Latin text", () => {
    const latin = "command code".repeat(30);
    expect(estimateKiroWireTokens(latin, ""))
      .toBe(Math.ceil(estimateTokens(latin, "kiro") * KIRO_LATIN_WIRE_EXPANSION));
  });

  test("supplementary Han stays in the CJK bucket when BMP CJK or Latin is added", () => {
    const han = "𠀀".repeat(100);
    expect(kiroCjkCount(han)).toBe(200);
    expect(estimateKiroWireTokens(han, model)).toBe(134);
    expect(estimateKiroWireTokens(han + "한", model)).toBe(134);
    expect(estimateKiroWireTokens(han + "abcd", model)).toBe(137);
    expect(estimateKiroWireTokens(han + "😀", model)).toBe(136);
    expect(estimateKiroWireTokens(han + "\ud800", model)).toBe(136);
  });

  test("adding Hangul to supplementary Han does not reduce streamed context usage", async () => {
    const provider = { adapter: "kiro", baseUrl: "https://runtime.us-east-1.kiro.dev", authMode: "oauth", apiKey: "test" } as OcxProviderConfig;
    const contextFor = async (content: string) => {
      const adapter = withTestTranslatorBudget(createKiroAdapter(provider));
      const parsed = { modelId: model, stream: true, options: {}, context: { messages: [{ role: "user", content }] } } as OcxParsedRequest;
      await adapter.buildRequest(parsed);
      const frame = encodeMessage({ ":message-type": "event", ":event-type": "assistantResponseEvent" }, new TextEncoder().encode(JSON.stringify({ content: "ok" })));
      const response = new Response(new ReadableStream({ start(controller) { controller.enqueue(frame); controller.close(); } }));
      for await (const event of adapter.parseStream(response)) {
        if (event.type === "done") return event.usage.contextTotalTokens;
      }
      throw new Error("Kiro stream did not complete");
    };
    const han = "𠀀".repeat(100);
    const baseline = await contextFor(han);
    const mixed = await contextFor(han + "한");
    expect(baseline).toBeDefined();
    expect(mixed).toBeGreaterThanOrEqual(baseline!);
  });
});
