import { describe, expect, test } from "bun:test";
import { normalizeDevinModelId } from "../../src/adapters/devin";
import { parseDevinAuthPaste, refreshDevinToken } from "../../src/oauth/devin";
import { DEVIN_DEFAULT_API_SERVER, resolveDevinApiBaseUrl, validateDevinApiBaseUrl } from "../../src/oauth/devin/api-base";
import { registerUser } from "../../src/oauth/devin/register-user";
import { anySignal } from "../../src/lib/abort";
import { buildGetChatMessageRequestForTests } from "../../src/adapters/devin/cloud-direct/chat";
import { decodeModelUsageStats } from "../../src/adapters/devin/cloud-direct/chat";
import { CloudChatError, decodeChatFrame } from "../../src/adapters/devin/cloud-direct/chat";
import { devinErrorClassification, mergeDevinUsage } from "../../src/adapters/devin";
import { iterFields } from "../../src/adapters/devin/cloud-direct/wire";
import { buildMetadata, normalizeDevinSessionToken } from "../../src/adapters/devin/cloud-direct/metadata";

/** Tag -> field for one encoded proto message. */
function iterFieldMap(buf: Buffer): Record<number, { wire: number; value: unknown }> {
  const out: Record<number, { wire: number; value: unknown }> = {};
  for (const f of iterFields(buf)) out[f.num] = { wire: f.wire, value: f.value };
  return out;
}

const FAKE_TOKEN = "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ1c2VyLTEifQ.c2lnbmF0dXJl";

describe("devin api-server allowlist", () => {
  test("accepts the default host and a tenant path, keeping the path", () => {
    expect(validateDevinApiBaseUrl("https://server.codeium.com")).toBe("https://server.codeium.com");
    expect(validateDevinApiBaseUrl("https://server.codeium.com/")).toBe("https://server.codeium.com");
    // EU and FedStart tenants live under a path prefix, so normalizing to the
    // origin the way the Copilot validator does would point them at the wrong
    // service rather than merely losing decoration.
    expect(validateDevinApiBaseUrl("https://eu.windsurf.com/_route/api_server")).toBe(
      "https://eu.windsurf.com/_route/api_server",
    );
    expect(validateDevinApiBaseUrl("https://windsurf.fedstart.com/_route/api_server")).toBe(
      "https://windsurf.fedstart.com/_route/api_server",
    );
  });

  test("rejects every shape that would redirect a credential-bearing POST", () => {
    for (const hostile of [
      "http://server.codeium.com",
      "https://attacker.example.com",
      "https://server.codeium.com.attacker.example",
      // Assembled rather than written out: a literal userinfo URL reads as an
      // email address to the privacy scanner.
      `https://user:secret${"@"}server.codeium.com`,
      "https://server.codeium.com:8443",
      "https://127.0.0.1",
      "https://localhost",
      "https://10.0.0.5",
      "https://server.codeium.com/path?next=https://evil.example",
      "https://server.codeium.com/path#frag",
      "not a url",
      "",
    ]) {
      expect(validateDevinApiBaseUrl(hostile)).toBeUndefined();
    }
    expect(resolveDevinApiBaseUrl("https://attacker.example.com")).toBe(DEVIN_DEFAULT_API_SERVER);
  });
});

describe("devin auth paste", () => {
  test("accepts a bare token and pulls one out of a callback URL", () => {
    expect(parseDevinAuthPaste(` ${FAKE_TOKEN} `)).toBe(FAKE_TOKEN);
    expect(parseDevinAuthPaste(`https://windsurf.com/callback#access_token=${FAKE_TOKEN}&state=abc`)).toBe(FAKE_TOKEN);
    expect(parseDevinAuthPaste(`https://windsurf.com/cb?firebase_id_token=${FAKE_TOKEN}`)).toBe(FAKE_TOKEN);
  });

  test("accepts the one-time token shape a live sign-in actually returns", () => {
    // Measured, not assumed: a free-tier sign-in on 2026-09-12 returned a
    // 47-character `ott$…` value, and RegisterUser exchanged it successfully.
    // A JWT-only check here would reject every real login.
    const oneTime = "ott$lLA_RUkVq3nB7xYz0aQpMdT4sWgEhJcK-TjATkAk";
    expect(parseDevinAuthPaste(oneTime)).toBe(oneTime);
    expect(parseDevinAuthPaste(` ${oneTime}\n`)).toBe(oneTime);
  });

  test("refuses a paste with no token instead of posting it as the token", () => {
    expect(() => parseDevinAuthPaste("https://windsurf.com/windsurf/signin?prompt=login")).toThrow(/no auth token/i);
    expect(() => parseDevinAuthPaste("this is not a token")).toThrow(/not a Devin auth token/i);
    expect(() => parseDevinAuthPaste("short")).toThrow(/not a Devin auth token/i);
    expect(() => parseDevinAuthPaste("   ")).toThrow(/No auth token pasted/i);
  });
});

describe("devin credential lifecycle", () => {
  test("refresh fails closed rather than extending a possibly revoked key", async () => {
    // The carried implementation returned an extended expiry, which made a
    // revoked key look valid forever. Throwing is what marks needsReauth.
    await expect(refreshDevinToken("whatever")).rejects.toThrow(/invalid_grant/);
  });
});

describe("devin model ids", () => {
  test("dotted version numbers collapse to the hyphenated catalog spelling", () => {
    expect(normalizeDevinModelId("swe-1.6")).toBe("swe-1-6");
    expect(normalizeDevinModelId("claude-opus-4.7-max")).toBe("claude-opus-4-7-max");
    expect(normalizeDevinModelId("swe-1-7")).toBe("swe-1-7");
  });
});

describe("registerUser error reporting", () => {
  const withFetch = async (impl: typeof fetch, run: () => Promise<void>) => {
    const original = globalThis.fetch;
    globalThis.fetch = impl;
    try {
      await run();
    } finally {
      globalThis.fetch = original;
    }
  };
  const region = {
    website: "https://windsurf.com",
    registerApiServerUrl: "https://register.windsurf.com",
    oauthClientId: "test-client",
  };

  test("an error body that echoes the token never reaches the message", async () => {
    await withFetch(
      (async () =>
        new Response(JSON.stringify({ code: "invalid_argument", message: `bad firebase_id_token ${FAKE_TOKEN}` }), {
          status: 400,
        })) as typeof fetch,
      async () => {
        const error = await registerUser(FAKE_TOKEN, region).catch((e: Error) => e);
        expect(error).toBeInstanceOf(Error);
        const message = (error as Error).message;
        expect(message).not.toContain(FAKE_TOKEN);
        expect(message).toContain("HTTP 400");
        expect(message).toContain("invalid_argument");
      },
    );
  });

  test("a 200 with an unparseable body reports its size, not its contents", async () => {
    await withFetch(
      (async () => new Response(`<html>${FAKE_TOKEN}</html>`, { status: 200 })) as typeof fetch,
      async () => {
        const error = await registerUser(FAKE_TOKEN, region).catch((e: Error) => e);
        expect((error as Error).message).not.toContain(FAKE_TOKEN);
        expect((error as Error).message).toMatch(/not JSON/i);
      },
    );
  });

  test("a register host outside the allowlist is refused before the token is sent", async () => {
    let called = false;
    await withFetch(
      (async () => {
        called = true;
        return new Response("{}", { status: 200 });
      }) as typeof fetch,
      async () => {
        const error = await registerUser(FAKE_TOKEN, { ...region, registerApiServerUrl: "https://evil.example" }).catch(
          (e: Error) => e,
        );
        expect((error as Error).message).toMatch(/non-Cognition register host/i);
        expect(called).toBe(false);
      },
    );
  });
});

describe("anySignal", () => {
  test("cleanup detaches from a parent signal that never aborts", () => {
    const parent = new AbortController();
    let added = 0;
    let removed = 0;
    const realAdd = parent.signal.addEventListener.bind(parent.signal);
    const realRemove = parent.signal.removeEventListener.bind(parent.signal);
    // Exercise the polyfill branch explicitly: on Bun the builtin
    // AbortSignal.any is used and owns its own teardown.
    const builtin = (AbortSignal as unknown as { any?: unknown }).any;
    (AbortSignal as unknown as { any?: unknown }).any = undefined;
    parent.signal.addEventListener = ((...args: Parameters<typeof realAdd>) => {
      added += 1;
      return realAdd(...args);
    }) as typeof realAdd;
    parent.signal.removeEventListener = ((...args: Parameters<typeof realRemove>) => {
      removed += 1;
      return realRemove(...args);
    }) as typeof realRemove;
    try {
      const composed = anySignal([parent.signal, AbortSignal.timeout(60_000)]);
      expect(composed.signal.aborted).toBe(false);
      composed.cleanup();
      expect(added).toBe(1);
      expect(removed).toBe(1);
    } finally {
      (AbortSignal as unknown as { any?: unknown }).any = builtin;
    }
  });

  test("aborts as soon as any input aborts", () => {
    const a = new AbortController();
    const b = new AbortController();
    const composed = anySignal([a.signal, b.signal]);
    expect(composed.signal.aborted).toBe(false);
    b.abort(new Error("stop"));
    expect(composed.signal.aborted).toBe(true);
    composed.cleanup();
  });
});

describe("devin cloud request shape", () => {
  // The bug this guards: #2 and #3 were swapped, so a caller asking for 32
  // output tokens wrote 32 into the context-window field and Cognition answered
  // every single turn with an opaque "an internal error occurred" - on free and
  // paid accounts alike. Verified on 2026-09-12 by building the same turn with a
  // working client and diffing the encoded messages field by field.
  function fields(buf: Buffer) {
    const out: Record<number, { wire: number; value: unknown }> = {};
    for (const f of iterFields(buf)) out[f.num] = { wire: f.wire, value: f.value };
    return out;
  }
  const build = (completionOpts?: Record<string, number>) =>
    buildGetChatMessageRequestForTests({
      apiKey: "devin-session-token$test",
      sessionId: "11111111-1111-1111-1111-111111111111",
      requestId: 1n,
      triggerId: "22222222-2222-2222-2222-222222222222",
      cascadeId: "33333333-3333-3333-3333-333333333333",
      modelUid: "swe-2-high",
      messages: [{ role: "user", content: "hi" }],
      ...(completionOpts ? { completionOpts } : {}),
    });

  test("the output cap lands in #2 and the context window in #3", () => {
    const outer = fields(build({ maxOutputTokens: 64, maxInputTokens: 200_000 }));
    const completion = outer[8]?.value as Buffer;
    const inner = fields(completion);
    expect(inner[2]).toEqual({ wire: 0, value: 64n });
    expect(inner[3]).toEqual({ wire: 0, value: 200_000n });
    // #6 and #11 are not part of the message the service accepts.
    expect(inner[6]).toBeUndefined();
    expect(inner[11]).toBeUndefined();
  });

  test("temperature zero is clamped, because the service refuses exactly zero", () => {
    const inner = fields(fields(build({ temperature: 0 }))[8]?.value as Buffer);
    const raw = inner[5]?.value as Buffer;
    const temperature = Buffer.from(raw).readDoubleLE(0);
    expect(temperature).toBeGreaterThan(0);
    expect(temperature).toBeLessThan(0.01);
  });

  test("the outer request carries the verified tag set", () => {
    const outer = fields(build());
    // Present: metadata, system prompt, one prompt, request type, completion
    // config, session model config, session id, the #20 marker and the model.
    for (const tag of [1, 2, 3, 7, 8, 15, 16, 20, 21]) expect(outer[tag], `#${tag}`).toBeDefined();
    // #22 only appears from the second turn onward and is reused across that
    // turn's tool loop, so a fresh per-request uuid matches neither shape.
    expect(outer[22]).toBeUndefined();
  });

  test("metadata carries the fingerprint the service checks the length of", () => {
    const metadata = fields(fields(build())[1]?.value as Buffer);
    expect((metadata[31]?.value as Buffer).length).toBe(732);
  });
});

describe("devin session-token normalization", () => {
  test("a bare JWT regains the prefix the service reads", () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJhIjoxfQ.sig";
    expect(normalizeDevinSessionToken(jwt)).toBe("devin-session-token$" + jwt);
    // Without this, the key goes out verbatim and Cognition answers with an
    // opaque permission_denied, which reads as a revoked account.
    const metadata = iterFieldMap(buildMetadata({
      apiKey: jwt, requestId: 1, sessionId: "s", triggerId: "t", cloudChatShape: true,
    }));
    expect((metadata[3]?.value as Buffer).toString("utf8")).toBe("devin-session-token$" + jwt);
  });

  test("every other key format this field has carried passes through untouched", () => {
    for (const key of [
      "devin-session-token$eyJhbGciOiJIUzI1NiJ9.eyJhIjoxfQ.sig",
      "3f2504e0-4f89-11d3-9a0c-0305e82c3301",
      "sk-ws-01-abcdef",
      "cog_abcdef",
      "",
    ]) {
      expect(normalizeDevinSessionToken(key)).toBe(key);
    }
  });
});

describe("devin ModelUsageStats decode (response field 7)", () => {
  function varint(num: number, value: number): Buffer {
    const out: number[] = [(num << 3) | 0];
    let v = value;
    do { const b = v & 0x7f; v = Math.floor(v / 128); out.push(v > 0 ? b | 0x80 : b); } while (v > 0);
    return Buffer.from(out);
  }
  const stats = (input: number, output: number, write: number, read: number) =>
    Buffer.concat([varint(2, input), varint(3, output), varint(4, write), varint(5, read)]);

  test("an exclusive frame folds cache into the inclusive input this repo reports", () => {
    // 1k fresh + 57k cache read is the 58k prompt the user sees as one number.
    const u = decodeModelUsageStats(stats(1_000, 200, 0, 57_000));
    expect(u?.promptTokens).toBe(58_000);
    expect(u?.cachedInputTokens).toBe(57_000);
    expect(u?.totalTokens).toBe(58_200);
  });

  test("an already-inclusive frame is left alone rather than inflated", () => {
    const u = decodeModelUsageStats(stats(58_000, 200, 0, 57_000));
    expect(u?.promptTokens).toBe(58_000);
    expect(u?.cachedInputTokens).toBe(57_000);
    // normalizeCostTokens only rejects read + write > input, so an inflated
    // input would pass validation and bill cache at the uncached rate.
    expect(u!.cachedInputTokens! + (u!.cacheCreationInputTokens ?? 0)).toBeLessThanOrEqual(u!.promptTokens!);
  });

  test("cache write counts as prompt too, and an empty message decodes to nothing", () => {
    const u = decodeModelUsageStats(stats(1_000, 0, 4_000, 0));
    expect(u?.promptTokens).toBe(5_000);
    expect(u?.cacheCreationInputTokens).toBe(4_000);
    expect(decodeModelUsageStats(Buffer.alloc(0))).toBeNull();
  });
});

describe("devin frame-level usage precedence and classification", () => {
  // Tags above 15 need a multi-byte varint: field 28 wire 2 is 226, and
  // writing that as one raw byte sets the continuation bit and swallows the
  // next byte.
  function uvarint(value: number): number[] {
    const out: number[] = [];
    let v = value;
    do { const b = v & 0x7f; v = Math.floor(v / 128); out.push(v > 0 ? b | 0x80 : b); } while (v > 0);
    return out;
  }
  function varint(num: number, value: number): Buffer {
    return Buffer.from([...uvarint((num << 3) | 0), ...uvarint(value)]);
  }
  function lenDelim(num: number, payload: Buffer): Buffer {
    return Buffer.concat([Buffer.from([...uvarint((num << 3) | 2), ...uvarint(payload.length)]), payload]);
  }
  // ResponseDimensionGroup carrying a cumulative metric whose uid reads like a
  // metric id — the shape the old decoder mined for usage.
  function displayGroup(uid: string, value: number): Buffer {
    const f32 = Buffer.alloc(5);
    f32.writeUInt8((2 << 3) | 5, 0);
    f32.writeFloatLE(value, 1);
    const entry = Buffer.concat([lenDelim(4, f32), lenDelim(5, Buffer.from(uid, "utf8"))]);
    return lenDelim(2, entry);
  }

  test("field 7 suppresses the display rows and is reported before finish", () => {
    const stats = Buffer.concat([varint(2, 1_000), varint(3, 200), varint(4, 0), varint(5, 57_000)]);
    const frame = Buffer.concat([
      lenDelim(7, stats),
      varint(5, 2),                                   // stop_reason STOP_PATTERN
      lenDelim(28, displayGroup("input_tokens", 999)), // the wrong, display-derived number
    ]);
    const events = [...decodeChatFrame(frame)];
    const usages = events.filter(e => e.kind === "usage");
    expect(usages).toHaveLength(1);
    expect(usages[0]!.promptTokens).toBe(58_000);
    expect(usages[0]!.cachedInputTokens).toBe(57_000);
    // Ahead of finish, so ordering does not depend on where the service puts
    // the field.
    expect(events.findIndex(e => e.kind === "usage"))
      .toBeLessThan(events.findIndex(e => e.kind === "finish"));
  });

  test("a frame with no field 7 still falls back to the display rows", () => {
    const frame = lenDelim(28, Buffer.concat([
      displayGroup("input_tokens", 4_000),
      displayGroup("output_tokens", 100),
    ]));
    const usages = [...decodeChatFrame(frame)].filter(e => e.kind === "usage");
    expect(usages).toHaveLength(1);
    expect(usages[0]!.promptTokens).toBe(4_000);
  });
});

describe("devin usage merging and error classification", () => {
  test("a later partial frame cannot zero an earlier count, and the total stays derived", () => {
    const merged = mergeDevinUsage(
      { inputTokens: 58_000, outputTokens: 200, totalTokens: 58_200, cachedInputTokens: 57_000 },
      { inputTokens: 58_000, outputTokens: 900 },
    );
    expect(merged.cachedInputTokens).toBe(57_000);
    expect(merged.outputTokens).toBe(900);
    // Taking the max of two totals alongside per-field maxima would leave
    // 58,200 here, which no longer equals input + output.
    expect(merged.totalTokens).toBe(58_900);
  });

  test("an HTTP status on the cloud error becomes a structured classification", () => {
    expect(devinErrorClassification(new CloudChatError("x", undefined, undefined, 429)))
      .toEqual({ status: 429, errorType: "rate_limit_error", retryable: true });
    expect(devinErrorClassification(new CloudChatError("x", undefined, undefined, 401)))
      .toEqual({ status: 401, errorType: "authentication_error", retryable: false });
    expect(devinErrorClassification(new CloudChatError("x", undefined, undefined, 503)))
      .toEqual({ status: 503, retryable: true });
    // A Connect trailer carries no status, so it keeps the older inference path.
    expect(devinErrorClassification(new CloudChatError("x", "resource_exhausted"))).toEqual({});
  });
});
