import { describe, expect, test } from "bun:test";
import { createAnthropicAdapter } from "../../src/adapters/anthropic";
import { parseRequest } from "../../src/responses/parser";
import {
  normalizeVisualizationContext,
  normalizeVisualizationText,
} from "../../src/responses/visualization-directives";
import type { OcxContext, OcxProviderConfig } from "../../src/types";

/**
 * Codex App visualization references (\uE200visualize\uE202{...}\uE201) are invisible to models whose
 * provider drops private-use characters, so the parser hands every routed model the app's own ASCII
 * directive instead. The expected strings below are what the app's renderer (26.924.22138, `f2`)
 * produces for the same payloads.
 */

const S = "\uE200";
const P = "\uE202";
const E = "\uE201";
const ref = (payload: string): string => `${S}visualize${P}${payload}${E}`;
const json = (value: unknown): string => ref(JSON.stringify(value));
const hasPrivateUse = (text: string): boolean => /[\uE000-\uF8FF]/.test(text);

describe("visualization reference rewrite", () => {
  test("an absolute path becomes the inline directive", () => {
    expect(normalizeVisualizationText(`see\n${json({ path: "/workspace/viz/chart.html" })}\nend`))
      .toBe('see\n::codex-inline-vis{path="/workspace/viz/chart.html"}\nend');
  });

  test("title and wide mode are carried in the app's attribute order", () => {
    expect(normalizeVisualizationText(json({ mode: "wide", title: "Q3 sales", path: "/v/q3-sales.html" })))
      .toBe('::codex-inline-vis{path="/v/q3-sales.html" title="Q3 sales" mode="wide"}');
  });

  test("a title with a quote is dropped, the directive is kept", () => {
    expect(normalizeVisualizationText(json({ path: "/v/a.html", title: 'say "hi"' })))
      .toBe('::codex-inline-vis{path="/v/a.html"}');
  });

  test("live references use the live directive and never carry mode", () => {
    expect(normalizeVisualizationText(json({ type: "live", path: "/v/live-a.html", mode: "wide" })))
      .toBe('::codex-live-vis{path="/v/live-a.html"}');
    expect(normalizeVisualizationText(json({ type: "live", path: null, title: "ignored" }))).toBe("::codex-live-vis{}");
  });

  test("wide:true is validated but does not select wide mode", () => {
    expect(normalizeVisualizationText(json({ path: "/v/a.html", wide: true }))).toBe('::codex-inline-vis{path="/v/a.html"}');
  });

  test("a bare path payload and a bare basename follow the app's path/file choice", () => {
    expect(normalizeVisualizationText(ref("/v/bare-path.html"))).toBe('::codex-inline-vis{path="/v/bare-path.html"}');
    expect(normalizeVisualizationText(ref("chart.html"))).toBe('::codex-inline-vis{file="chart.html"}');
  });

  test("Windows drive and UNC paths count as absolute", () => {
    expect(normalizeVisualizationText(json({ path: "C:\\viz\\chart.html" })))
      .toBe('::codex-inline-vis{path="C:\\viz\\chart.html"}');
    expect(normalizeVisualizationText(json({ path: "\\\\host\\share\\chart.html" })))
      .toBe('::codex-inline-vis{path="\\\\host\\share\\chart.html"}');
    expect(normalizeVisualizationText(json({ path: "//host/share/chart.html" })))
      .toBe('::codex-inline-vis{path="//host/share/chart.html"}');
  });

  test("both Visualize skill templates become readable ASCII templates", () => {
    const fenced = [
      "```text",
      ref('{"path":"<absolute-path>/<title>.html"}'),
      "```",
      "",
      "```text",
      ref('{"path":"<absolute-path>/<title>.html","mode":"wide"}'),
      "```",
    ].join("\n");
    expect(normalizeVisualizationText(fenced)).toBe([
      "```text",
      '::codex-inline-vis{path="<absolute-path>/<title>.html"}',
      "```",
      "",
      "```text",
      '::codex-inline-vis{path="<absolute-path>/<title>.html" mode="wide"}',
      "```",
    ].join("\n"));
  });

  test("payloads the app would reject stay exactly as written", () => {
    const kept = [
      ref("{not json"),
      json({ path: "relative/chart.html" }),
      json({ path: "/v/../chart.html" }),
      json({ path: '/v/a"b.html' }),
      json({ path: "/v/Chart.html" }),
      json({ path: "/v/chart.htm" }),
      json({ title: "no path" }),
      json({ path: null }),
      json({ path: "/v/a.html", title: 3 }),
      json({ path: "/v/a.html", type: "embedded" }),
      json({ path: "/v/a.html", mode: "tall" }),
      json({ path: "/v/a.html", wide: "yes" }),
      json(["/v/a.html"]),
      ref("sub/chart.html"),
    ];
    for (const span of kept) expect(normalizeVisualizationText(`x ${span} y`)).toBe(`x ${span} y`);
  });

  test("other keywords, empty payloads and unterminated spans are untouched", () => {
    const text = `${S}cite${P}turn0search0${E} ${S}visualize${P}${E} ${S}visualize${P}{"path":"/v/a.html"}`;
    expect(normalizeVisualizationText(text)).toBe(text);
  });

  test("matching follows the app's regex for nested and malformed prefixes", () => {
    const nested = `${S}cite${P}turn0 ${json({ path: "/v/a.html" })}`;
    expect(normalizeVisualizationText(nested)).toBe(`${S}cite${P}turn0 ::codex-inline-vis{path="/v/a.html"}`);
    // An empty payload is skipped and the scan retries at the next prefix, as the regex does.
    const malformed = `${S}visualize${P}${E}${json({ path: "/v/b.html" })}`;
    expect(normalizeVisualizationText(malformed)).toBe(`${S}visualize${P}${E}::codex-inline-vis{path="/v/b.html"}`);
  });

  test("text without a reference is returned as the same string, and a second pass changes nothing", () => {
    const plain = "no references here ${S} ${E}";
    expect(normalizeVisualizationText(plain)).toBe(plain);
    const once = normalizeVisualizationText(json({ path: "/v/a.html" }));
    expect(normalizeVisualizationText(once)).toBe(once);
  });

  test("many unterminated prefixes are scanned in linear time", () => {
    const hostile = `${S}visualize${P}x`.repeat(20_000);
    const started = performance.now();
    expect(normalizeVisualizationText(hostile)).toBe(hostile);
    expect(performance.now() - started).toBeLessThan(200);
  });
});

describe("visualization references in the parsed request", () => {
  const reference = json({ path: "/workspace/viz/chart.html" });
  const directive = '::codex-inline-vis{path="/workspace/viz/chart.html"}';

  const deepFreeze = <T>(value: T): T => {
    if (value && typeof value === "object") {
      for (const child of Object.values(value)) deepFreeze(child);
      Object.freeze(value);
    }
    return value;
  };

  const body = () => deepFreeze({
    model: "anthropic/claude-opus-5-5",
    instructions: `Answer with ${reference} when asked.`,
    input: [
      { type: "message", role: "developer", content: [{ type: "input_text", text: `dev ${reference}` }] },
      {
        type: "message",
        role: "user",
        content: [
          { type: "input_text", text: `user ${reference}` },
          { type: "input_image", image_url: "data:image/png;base64,AAAA" },
        ],
      },
      { type: "message", role: "assistant", content: [{ type: "output_text", text: `Here:\n${reference}` }] },
      { type: "function_call", call_id: "call_1", name: "exec", arguments: JSON.stringify({ note: reference }) },
      { type: "function_call_output", call_id: "call_1", output: `skill says ${reference}` },
      { type: "message", role: "user", content: "again" },
    ],
  });

  test("every conversation text reaches the model as the ASCII directive", () => {
    const parsed = parseRequest(body());
    const texts = [
      ...(parsed.context.systemPrompt ?? []),
      ...parsed.context.messages.flatMap((message) => {
        if (typeof message.content === "string") return [message.content];
        return message.content.flatMap((part) => (part.type === "text" ? [part.text] : []));
      }),
    ];
    const withDirective = texts.filter((text) => text.includes(directive));
    expect(withDirective.length).toBeGreaterThanOrEqual(5);
    for (const text of texts) expect(text.includes(`${S}visualize${P}`)).toBe(false);
  });

  test("images and tool-call arguments are untouched and the raw body is the frozen input", () => {
    const input = body();
    const parsed = parseRequest(input);
    expect(parsed._rawBody).toBe(input);
    expect(JSON.stringify(parsed._rawBody)).toContain(`${S}visualize${P}`);
    const user = parsed.context.messages.find(
      (message) => message.role === "user" && Array.isArray(message.content) && message.content.some((p) => p.type === "image"),
    );
    expect(user && Array.isArray(user.content) ? user.content.find((p) => p.type === "image") : undefined)
      .toEqual({ type: "image", imageUrl: "data:image/png;base64,AAAA" });
    const call = parsed.context.messages
      .flatMap((message) => (message.role === "assistant" ? message.content : []))
      .find((part) => part.type === "toolCall");
    expect(call && "arguments" in call ? JSON.stringify(call.arguments) : "").toContain(`${S}visualize${P}`);
  });

  test("a replayed compaction summary is normalized like any other text", () => {
    const summary = `earlier answer: ${reference}`;
    const parsed = parseRequest({
      model: "anthropic/claude-opus-5-5",
      input: [
        { type: "context_compaction", encrypted_content: "ocx1:" + Buffer.from(summary, "utf-8").toString("base64") },
        { type: "message", role: "user", content: "next" },
      ],
    });
    expect(parsed.context.messages[0].content as string).toContain(directive);
  });

  test("an unaffected context is returned by reference", () => {
    const context: OcxContext = { messages: [{ role: "user", content: "plain", timestamp: 0 }] };
    expect(normalizeVisualizationContext(context)).toBe(context);
  });

  test("the Anthropic request carries the directive and no private-use character in text", async () => {
    const provider = { adapter: "anthropic", baseUrl: "https://api.anthropic.com", apiKey: "sk-x", authMode: "apiKey" } as unknown as OcxProviderConfig;
    const parsed = parseRequest({
      model: "anthropic/claude-opus-5-5",
      input: [{ type: "message", role: "user", content: `draw it: ${reference}` }],
    });
    const { body: wire } = await createAnthropicAdapter(provider).buildRequest(parsed);
    const serialized = typeof wire === "string" ? wire : JSON.stringify(wire);
    const decoded = JSON.parse(serialized) as { messages: Array<{ content: unknown }> };
    const text = JSON.stringify(decoded.messages);
    expect(text).toContain(directive.replaceAll('"', '\\"'));
    expect(hasPrivateUse(text)).toBe(false);
  });
});
