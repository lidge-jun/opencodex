import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createDevinAdapter, resolveDevinMaxOutputTokensForTests } from "../../src/adapters/devin";
import { parseCatalogBuffer, setCachedCatalogForTests } from "../../src/adapters/devin/cloud-direct/catalog";
import { devinCacheIdentity, invalidateSessionIdentity } from "../../src/adapters/devin/cloud-direct/chat";
import { encodeMessage, encodeString, encodeVarintField, iterFields } from "../../src/adapters/devin/cloud-direct/wire";
import { createTranslatorBudget } from "../../src/lib/translator-budget";
import type { AdapterEvent, OcxParsedRequest, OcxProviderConfig } from "../../src/types";
import { removeTreeWithRetry } from "../helpers/remove-tree";

/**
 * The output budget a Devin turn actually sends.
 *
 * CompletionConfiguration #2 is the output cap and #3 is the context window.
 * Every assertion below reads both, because the defect these guard against is
 * not "the number is wrong" but "the two meanings were collapsed into one":
 * a caller that names no cap has to reach the configured output budget without
 * the context window leaking into the field that decides how long the answer
 * may run.
 */
describe("Devin output budget on the wire", () => {
  const apiKey = "ocx-devin-output-fixture";
  const host = "https://server.codeium.com";
  const previousHome = process.env.OPENCODEX_HOME;
  const previousFetch = globalThis.fetch;
  let home = "";
  let requests: Buffer[] = [];

  function frame(body: Buffer, flags = 0): Buffer {
    const header = Buffer.alloc(5);
    header[0] = flags;
    header.writeUInt32BE(body.length, 1);
    return Buffer.concat([header, body]);
  }
  function fields(buf: Buffer) {
    return new Map([...iterFields(buf)].map(field => [field.num, field]));
  }
  function seed(rows: Array<{ uid: string; window?: number }>): void {
    const buffer = Buffer.concat(rows.map(row => encodeMessage(1, Buffer.concat([
      encodeString(1, row.uid),
      encodeString(22, row.uid),
      ...(row.window === undefined ? [] : [encodeVarintField(18, row.window)]),
      encodeVarintField(4, 0),
    ]))));
    setCachedCatalogForTests(parseCatalogBuffer(buffer, apiKey, host));
  }
  async function run(
    provider: Partial<OcxProviderConfig> = {},
    options: OcxParsedRequest["options"] = {},
    modelId = "swe-2-high",
  ): Promise<AdapterEvent[]> {
    const adapter = createDevinAdapter({ ...provider, adapter: "devin", apiKey, baseUrl: host });
    const events: AdapterEvent[] = [];
    await adapter.runTurn!({
      modelId, stream: true,
      context: { messages: [{ role: "user", content: "hi", timestamp: 1 }] },
      options,
    }, { headers: new Headers(), translatorBudget: createTranslatorBudget() },
    event => { events.push(event); });
    return events;
  }
  /** The completion configuration the one captured turn actually encoded. */
  function sentCompletion(): { output: bigint; context: bigint } {
    expect(requests).toHaveLength(1);
    const completion = fields(fields(requests[0]!).get(8)!.value as Buffer);
    return { output: completion.get(2)!.value as bigint, context: completion.get(3)!.value as bigint };
  }

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "ocx-devin-output-"));
    process.env.OPENCODEX_HOME = home;
    requests = [];
    setCachedCatalogForTests(null);
    seed([{ uid: "swe-2-high", window: 262_000 }, { uid: "swe-2-max", window: 1_000_000 }]);
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (!url.endsWith("/GetChatMessage")) return new Response("unavailable", { status: 503 });
      requests.push(Buffer.from(await (init!.body as Blob).arrayBuffer()).subarray(5));
      return new Response(Buffer.concat([
        frame(Buffer.concat([encodeString(3, "ok"), encodeVarintField(5, 2)])),
        frame(Buffer.from("{}"), 2),
      ]), { headers: { "content-type": "application/connect+proto" } });
    }) as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = previousFetch;
    setCachedCatalogForTests(null);
    if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = previousHome;
    invalidateSessionIdentity(devinCacheIdentity(apiKey, host));
    removeTreeWithRetry(home);
  });

  test("a caller that names no cap still reaches the configured provider budget", async () => {
    // Codex never sends max_output_tokens, so this is the path every real turn
    // takes. Before the budget was wired the encoder's 8192 was the only cap a
    // devin turn could ever have, whatever the operator configured.
    const events = await run({ defaultMaxOutputTokens: 64_000 });
    expect(events.some(event => event.type === "error")).toBe(false);
    expect(sentCompletion().output).toBe(64_000n);
  });

  test("a per-model budget outranks the provider default and follows the selected variant", async () => {
    await run({
      defaultMaxOutputTokens: 64_000,
      modelMaxOutputTokens: { "swe-2-high": 32_000, "swe-2-max": 100_000 },
    });
    expect(sentCompletion().output).toBe(32_000n);
  });

  test("an explicit small cap survives a much larger configured budget", async () => {
    await run(
      { defaultMaxOutputTokens: 64_000, modelMaxOutputTokens: { "swe-2-high": 32_000 } },
      { maxOutputTokens: 64 },
    );
    expect(sentCompletion().output).toBe(64n);
  });

  test("the context window never becomes the output cap", async () => {
    // The whole provider row describes input size and nothing else. The output
    // field has to stay on the encoder default rather than inherit 262k, which
    // would ask Cognition to generate an entire context window of tokens.
    await run({ contextWindow: 200_000, modelContextWindows: { "swe-2-high": 180_000 } });
    const sent = sentCompletion();
    expect(sent.output).toBe(8192n);
    expect(sent.context).toBe(180_000n);
  });

  test("a configured output budget does not disturb the input ceiling", async () => {
    await run({ defaultMaxOutputTokens: 64_000 });
    expect(sentCompletion().context).toBe(262_000n);
  });
});

describe("Devin output budget resolution", () => {
  const provider: Partial<OcxProviderConfig> = {
    adapter: "devin",
    defaultMaxOutputTokens: 64_000,
    modelMaxOutputTokens: { "swe-2-high": 32_000 },
  };

  test("an explicit caller value is forwarded unchanged", () => {
    expect(resolveDevinMaxOutputTokensForTests(provider as OcxProviderConfig, "swe-2-high", 64)).toBe(64);
  });

  test("an unconfigured provider leaves the encoder default in place", () => {
    expect(resolveDevinMaxOutputTokensForTests({ adapter: "devin" } as OcxProviderConfig, "swe-2-high", undefined))
      .toBeUndefined();
  });

  test("a dotted or case-folded saved hint still matches the selected uid", () => {
    expect(resolveDevinMaxOutputTokensForTests(
      { adapter: "devin", modelMaxOutputTokens: { "SWE.2-HIGH": 24_000 } } as OcxProviderConfig,
      "swe-2-high", undefined,
    )).toBe(24_000);
  });

  test("another variant's budget is never borrowed", () => {
    expect(resolveDevinMaxOutputTokensForTests(
      { adapter: "devin", modelMaxOutputTokens: { "swe-2-max": 100_000 } } as OcxProviderConfig,
      "swe-2-high", undefined,
    )).toBeUndefined();
  });

  test.each([Number.NaN, Number.POSITIVE_INFINITY, 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    "invalid configured metadata %p is ignored rather than encoded",
    invalid => {
      expect(resolveDevinMaxOutputTokensForTests(
        { adapter: "devin", defaultMaxOutputTokens: invalid, modelMaxOutputTokens: { "swe-2": invalid } } as OcxProviderConfig,
        "swe-2-high", undefined,
      )).toBeUndefined();
    },
  );

  test("the context window is not an output budget", () => {
    expect(resolveDevinMaxOutputTokensForTests(
      { adapter: "devin", contextWindow: 200_000, modelContextWindows: { "swe-2-high": 180_000 } } as OcxProviderConfig,
      "swe-2-high", undefined,
    )).toBeUndefined();
  });
});
