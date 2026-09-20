import { describe, expect, test } from "bun:test";
import {
  resolveVoiceTarget,
  selectVoiceBackend,
  voiceConfigValueError,
  voiceProviderEndpointError,
} from "../../src/config/voice-target";
import { handleAudioSpeech, SPEECH_INPUT_MAX_CHARS, SPEECH_REQUEST_MAX_BYTES, SPEECH_RESPONSE_MAX_BYTES } from "../../src/server/audio-speech";
import { handleAudioTranscriptions } from "../../src/server/audio-transcriptions";
import { latestDictationModelFromEntries } from "../../src/server/audio-dictation";
import { REDACTED_PROVIDER_FIELDS, redactedFieldPresence, safeConfigDTO } from "../../src/server/auth-cors";
import type { DataPlaneAdmission } from "../../src/server/auth-cors";
import type { RequestLogContext } from "../../src/server/request-log";
import type { OcxConfig, OcxProviderConfig } from "../../src/types";

// Port 9 is discard: nothing listens, so a request that escapes is refused at
// once rather than served.
//
// These pointed at 8915 and 8911 — the real Handy and pocket-voice on this
// machine. Every test refuses before any upstream call, so it never mattered
// until `red.ts` deliberately broke the 1 MiB cap: the megabyte of "x" then
// went straight out to the live text-to-speech service, which spent the next
// several minutes at 327% CPU and 3.2 GB trying to say it.
//
// A test fixture naming a real address is a loaded gun pointed at whatever
// happens to be listening.
const PROVIDERS = {
  handy: {
    adapter: "openai",
    baseUrl: "http://127.0.0.1:9/v1",
    transcriptionUrl: "http://127.0.0.1:9/v1/audio/transcriptions",
  },
  pocket: {
    adapter: "openai",
    baseUrl: "http://127.0.0.1:9/v1",
    speechUrl: "http://127.0.0.1:9/v1/audio/speech",
    speechHeaders: { authorization: "${POCKET_TOKEN}" },
  },
  bare: { adapter: "openai", baseUrl: "https://example.test/v1" },
} satisfies Record<string, OcxProviderConfig>;

function config(extra: Partial<OcxConfig> = {}): OcxConfig {
  return {
    port: 0,
    defaultProvider: "handy",
    providers: PROVIDERS,
    ...extra,
  } as OcxConfig;
}

const ADMISSION = { kind: "environment", source: "bearer", contextPrincipalId: "p" } as unknown as DataPlaneAdmission;
const LOG = { model: "speech", provider: "unknown" } as RequestLogContext;

function speechRequest(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request("http://127.0.0.1/v1/audio/speech", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

describe("voice target resolution", () => {
  test("the reserved name selects the built-in path for every route", () => {
    for (const kind of ["dictation", "transcription", "speech"] as const) {
      expect(resolveVoiceTarget(PROVIDERS, undefined, kind).kind).toBe("openai");
      expect(resolveVoiceTarget(PROVIDERS, "openai", kind).kind).toBe("openai");
    }
  });

  test("a custom provider resolves per route", () => {
    expect(resolveVoiceTarget(PROVIDERS, "handy", "transcription")).toMatchObject({ kind: "custom", providerName: "handy" });
    expect(resolveVoiceTarget(PROVIDERS, "pocket", "speech")).toMatchObject({ kind: "custom", providerName: "pocket" });
  });

  test("an unconfigured provider name is refused, not ignored", () => {
    const result = resolveVoiceTarget(PROVIDERS, "nope", "speech");
    expect(result.kind).toBe("invalid");
    expect(result.kind === "invalid" && result.error).toContain("not configured");
  });

  test("each route reads its own endpoint field", () => {
    // handy carries transcriptionUrl but no speechUrl: naming it for speech must
    // fail, or a read-aloud would silently POST text at a transcription endpoint.
    expect(voiceProviderEndpointError("handy", PROVIDERS.handy, "transcription")).toBeNull();
    expect(voiceProviderEndpointError("handy", PROVIDERS.handy, "speech")).toContain("speechUrl");
    expect(voiceProviderEndpointError("pocket", PROVIDERS.pocket, "speech")).toBeNull();
    expect(voiceProviderEndpointError("pocket", PROVIDERS.pocket, "transcription")).toContain("transcriptionUrl");
  });

  test("headers that are not strings are refused, naming the field", () => {
    const provider = { ...PROVIDERS.pocket, speechHeaders: { authorization: 7 } };
    const error = voiceProviderEndpointError("pocket", provider as never, "speech");
    expect(error).toContain("speechHeaders");
    expect(error).toContain("object of strings");
  });

  test("protocols that are not an array of strings are refused", () => {
    // `dictationProtocols` is the only per-route field with no test anywhere
    // on this branch, and the one that reaches a WebSocket handshake — a
    // number in that list becomes a subprotocol header the far side rejects.
    const provider = { ...PROVIDERS.handy, dictationUrl: "ws://h/s", dictationProtocols: ["ok", 7] };
    const error = voiceProviderEndpointError("handy", provider as never, "dictation");
    expect(error).toContain("dictationProtocols");
    expect(error).toContain("array of strings");
  });

  test("well-formed headers and protocols are accepted", () => {
    const provider = { ...PROVIDERS.handy, dictationUrl: "ws://h/s", dictationProtocols: ["a"] };
    expect(voiceProviderEndpointError("handy", provider as never, "dictation")).toBeNull();
  });

  test("a provider with no voice endpoint at all is refused", () => {
    expect(voiceProviderEndpointError("bare", PROVIDERS.bare, "transcription")).toContain("transcriptionUrl");
  });

  test("byModel beats provider, and an exact model id is required", () => {
    const block = { provider: "handy", byModel: { "zai/glm-5.3": "pocket" } };
    expect(selectVoiceBackend(PROVIDERS, block, "zai/glm-5.3", "speech")).toMatchObject({ providerName: "pocket" });
    expect(selectVoiceBackend(PROVIDERS, block, "zai/glm-5.3-flash", "speech")).toMatchObject({ providerName: "handy" });
    expect(selectVoiceBackend(PROVIDERS, block, undefined, "speech")).toMatchObject({ providerName: "handy" });
  });

  // One behaviour per test. As a single test with six assertions, every guard
  // in tests/red.ts named the same test, so any of the six failing counted as
  // proof for all of them.
  test("a valid block and an absent one are both accepted", () => {
    expect(voiceConfigValueError({ provider: "pocket" }, PROVIDERS, "speech")).toBeNull();
    expect(voiceConfigValueError(undefined, PROVIDERS, "speech")).toBeNull();
  });

  test("a provider that cannot serve the route names the field", () => {
    expect(voiceConfigValueError({ provider: "handy" }, PROVIDERS, "speech")).toContain("speech.provider");
  });

  test("a byModel override names the model it came from", () => {
    expect(voiceConfigValueError({ byModel: { m: "bare" } }, PROVIDERS, "speech")).toContain("speech.byModel.m");
  });

  // The three sites where a wrong message means the config blames the wrong
  // thing rather than saying nothing. Everywhere else a bad message is a
  // missing diagnosis; here it is a misleading one, and a misleading one
  // sends you to the wrong file. The third of these is the exact shape of a
  // failure that cost an hour: a request reached a backend that could not
  // serve it, and the error named something else.
  test("a target that is not a string says so, naming the field", () => {
    const error = voiceConfigValueError({ provider: 7 }, PROVIDERS, "speech");
    expect(error).toContain("speech.provider");
    expect(error).toContain("must be a string");
  });

  test("a target naming no configured provider says which name is unknown", () => {
    const error = voiceConfigValueError({ provider: "nope" }, PROVIDERS, "speech");
    expect(error).toContain("speech.provider");
    expect(error).toContain("not configured");
  });

  test("a provider that exists but lacks the route's endpoint names the endpoint", () => {
    // `handy` is configured and serves transcription; naming it for speech has
    // to say `speechUrl`, not "not configured", or you go looking for a typo
    // in a provider name that is perfectly correct.
    const error = voiceConfigValueError({ provider: "handy" }, PROVIDERS, "speech");
    expect(error).toContain("speech.provider");
    expect(error).toContain("speechUrl");
    expect(error).not.toContain("not configured");
  });

  test("an unknown key in a route block is refused", () => {
    expect(voiceConfigValueError({ nope: 1 }, PROVIDERS, "speech")).toContain("unknown key");
  });

  test("a route block that is not an object is refused", () => {
    expect(voiceConfigValueError("string", PROVIDERS, "speech")).toContain("must be an object");
  });

  test("a byModel map that is not an object is refused", () => {
    expect(voiceConfigValueError({ byModel: "nope" }, PROVIDERS, "speech")).toContain("byModel: must be an object");
  });
});

describe("speech route", () => {
  test("an unconfigured speech backend reports 501, not a silent OpenAI fallback", async () => {
    // opencodex has no built-in text-to-speech, so "openai" here means nothing
    // is configured — answering 404 would read as a routing bug.
    const response = await handleAudioSpeech(speechRequest({ input: "hello" }), config(), LOG, ADMISSION);
    expect(response.status).toBe(501);
    expect(await response.text()).toContain("speech.provider");
  });

  test("a misconfigured target reports which setting is wrong", async () => {
    const response = await handleAudioSpeech(
      speechRequest({ input: "hello" }),
      config({ speech: { provider: "handy" } } as Partial<OcxConfig>),
      LOG,
      ADMISSION,
    );
    expect(response.status).toBe(502);
    expect(await response.text()).toContain("speechUrl");
  });

});

describe("transcription provider relay", () => {
  function wav(): File {
    // A minimal valid-looking payload; the stub never decodes it.
    return new File([new Uint8Array([82, 73, 70, 70, 0, 0, 0, 0])], "clip.wav", { type: "audio/wav" });
  }

  function transcriptionRequest(): Request {
    const form = new FormData();
    form.append("file", wav());
    form.append("model", "gpt-4o-transcribe");
    return new Request("http://127.0.0.1/v1/audio/transcriptions", { method: "POST", body: form });
  }

  async function relayWith(provider: OcxProviderConfig): Promise<{ status: number; sent: FormData | null; url: string }> {
    const real = globalThis.fetch;
    let sent: FormData | null = null;
    let url = "";
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      url = String(input);
      sent = init?.body as FormData;
      return new Response(JSON.stringify({ text: "ok" }), { headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    try {
      const { handleAudioTranscriptions } = await import("../../src/server/audio-transcriptions");
      const response = await handleAudioTranscriptions(
        transcriptionRequest(),
        config({ transcription: { provider: "stub" }, providers: { ...PROVIDERS, stub: provider } } as Partial<OcxConfig>),
        LOG,
        ADMISSION,
      );
      return { status: response.status, sent, url };
    } finally {
      globalThis.fetch = real;
    }
  }

  test("the caller's OpenAI model name is not forwarded to a custom backend", async () => {
    // opencodex only accepts OpenAI's transcription model names, which mean
    // nothing to a self-hosted engine. Forwarding one made Handy reject every
    // request with HTTP 400.
    const { status, sent, url } = await relayWith({
      adapter: "openai",
      baseUrl: "http://127.0.0.1:9/v1",
      transcriptionUrl: "http://127.0.0.1:9/v1/audio/transcriptions",
    } as OcxProviderConfig);
    expect(status).toBe(200);
    expect(url).toBe("http://127.0.0.1:9/v1/audio/transcriptions");
    expect(sent!.get("model")).toBeNull();
    expect(sent!.get("file")).toBeInstanceOf(File);
  });

  test("a configured transcriptionModel is sent instead", async () => {
    const { sent } = await relayWith({
      adapter: "openai",
      baseUrl: "http://127.0.0.1:9/v1",
      transcriptionUrl: "http://127.0.0.1:9/v1/audio/transcriptions",
      transcriptionModel: "parakeet-unified-en-0.6b",
    } as OcxProviderConfig);
    expect(sent!.get("model")).toBe("parakeet-unified-en-0.6b");
  });
});

describe("management DTO", () => {
  test("returns the voice routing blocks so they can be read back", () => {
    const dto = safeConfigDTO({
      port: 1, providers: {}, defaultProvider: "x",
      dictation: { provider: "handy" },
      transcription: { provider: "handy" },
      speech: { provider: "pocket", byModel: { "deepseek/chat": "pocket" } },
    } as unknown as OcxConfig) as Record<string, unknown>;
    expect(dto.dictation).toEqual({ provider: "handy" });
    expect(dto.transcription).toEqual({ provider: "handy" });
    expect(dto.speech).toEqual({ provider: "pocket", byModel: { "deepseek/chat": "pocket" } });
  });

  test("omits a block that is not configured, rather than sending null", () => {
    const dto = safeConfigDTO({
      port: 1, providers: {}, defaultProvider: "x",
    } as unknown as OcxConfig) as Record<string, unknown>;
    expect("speech" in dto).toBe(false);
  });
});

describe("redacted field presence", () => {
  test("a provider carrying route headers no longer reports none", () => {
    // Through safeConfigDTO, not the helper: the first version of this asserted
    // on `redactedFieldPresence` directly and stayed green with the DTO put
    // back to its two hardcoded flags, which is the bug it exists to catch.
    const dto = safeConfigDTO({
      port: 1, defaultProvider: "handy",
      providers: {
        handy: {
          adapter: "openai",
          dictationHeaders: { authorization: "Bearer x" },
          transcriptionHeaders: { authorization: "Bearer x" },
        },
      },
    } as unknown as OcxConfig) as { providers: Record<string, Record<string, unknown>> };
    const handy = dto.providers.handy!;
    expect(handy.hasDictationHeaders).toBe(true);
    expect(handy.hasTranscriptionHeaders).toBe(true);
    expect(handy.hasSpeechHeaders).toBe(false);
  });

  test("every redacted field gets a flag", () => {
    const flags = redactedFieldPresence({} as OcxProviderConfig);
    for (const field of REDACTED_PROVIDER_FIELDS) {
      expect(flags[`has${field[0]!.toUpperCase()}${field.slice(1)}`]).toBe(false);
    }
  });

  test("an empty value is not presence", () => {
    const flags = redactedFieldPresence({
      apiKey: "", headers: {},
    } as unknown as OcxProviderConfig);
    expect(flags.hasApiKey).toBe(false);
    expect(flags.hasHeaders).toBe(false);
  });

  test("the old flags keep their names", () => {
    const flags = redactedFieldPresence({ apiKey: "k" } as OcxProviderConfig);
    expect(flags.hasApiKey).toBe(true);
    expect("hasHeaders" in flags).toBe(true);
  });
});

describe("speech request validation", () => {
  /**
   * One row per refusal in `parseSpeech`. Table-driven because these are a
   * parser: eleven near-identical branches whose only interesting property is
   * which input reaches which message, and writing eleven prose tests would
   * hide that they are one thing.
   *
   * Through `handleAudioSpeech`, not the parser: `parseSpeech` is private, and
   * a test that reaches past the handler proves the parser works while saying
   * nothing about whether the handler calls it.
   */
  const SPEECH_CONFIGURED = config({
    speech: { provider: "pocket" },
  } as Partial<OcxConfig>);

  const ROWS: Array<{ why: string; request: Request; expect: string; status?: number }> = [
    {
      why: "a body that is not JSON at all",
      request: new Request("http://127.0.0.1/v1/audio/speech", {
        method: "POST",
        headers: { "content-type": "text/plain" },
        body: "hello",
      }),
      expect: "Expected application/json",
    },
    {
      why: "a body that is not valid JSON",
      request: new Request("http://127.0.0.1/v1/audio/speech", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{not json",
      }),
      expect: "not valid JSON",
    },
    {
      why: "a body stream that fails mid-read",
      request: new Request("http://127.0.0.1/v1/audio/speech", {
        method: "POST",
        headers: { "content-type": "application/json" },
        // A truncated upload looks like this: the stream starts and then
        // errors, which is a different refusal from a body that arrived whole
        // and was unparseable.
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{"input":'));
            controller.error(new Error("connection reset"));
          },
        }),
        // @ts-expect-error duplex is required for a streaming request body
        duplex: "half",
      }),
      expect: "Malformed speech request body",
    },
    {
      why: "valid JSON that is not an object",
      request: speechRequest("just a string"),
      expect: "must be a JSON object",
    },
    {
      why: "a field the OpenAI shape does not define",
      request: speechRequest({ input: "hi", surprise: 1 }),
      expect: "Unsupported speech field",
    },
    {
      why: "no input at all",
      request: speechRequest({ model: "tts-1" }),
      expect: "A nonempty",
    },
    {
      why: "an input of only whitespace",
      request: speechRequest({ input: "   " }),
      expect: "A nonempty",
    },
    {
      why: "a body past the 1 MiB cap",
      // The real limit, with a real body. No injectable constant needed: a
      // megabyte of JSON is cheap to build and this proves the number that
      // actually ships rather than a test-only stand-in.
      request: new Request("http://127.0.0.1/v1/audio/speech", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ input: "x".repeat(SPEECH_REQUEST_MAX_BYTES) }),
      }),
      expect: "exceeds 1 MiB",
      status: 413,
    },
    {
      why: "an input past the character cap",
      request: speechRequest({ input: "x".repeat(SPEECH_INPUT_MAX_CHARS + 1) }),
      expect: "characters",
      // 413, not 400: the request is well-formed and too big, which is a
      // different thing for a client to act on. The table assumed one status
      // for every refusal and this row is why it does not.
      status: 413,
    },
    {
      why: "a model that is not a string",
      request: speechRequest({ input: "hi", model: 7 }),
      expect: "`model` must be a string",
    },
    {
      why: "a voice that is not a string",
      request: speechRequest({ input: "hi", voice: [] }),
      expect: "`voice` must be a string",
    },
    {
      why: "a response_format that is not a string",
      request: speechRequest({ input: "hi", response_format: {} }),
      expect: "`response_format` must be a string",
    },
  ];

  for (const row of ROWS) {
    test(`refuses ${row.why}`, async () => {
      const response = await handleAudioSpeech(row.request, SPEECH_CONFIGURED, LOG, ADMISSION);
      expect(response.status).toBe(row.status ?? 400);
      expect(await response.text()).toContain(row.expect);
    });
  }
});

describe("transcription request validation", () => {
  /**
   * One row per refusal in `parseTranscription`, driven through the exported
   * handler rather than the private parser — a test that reaches past the
   * handler proves the parser works and says nothing about whether the
   * handler calls it.
   *
   * Four of these are 413 rather than 400: the request is well formed and too
   * big, which is a different thing for a client to act on. The speech table
   * assumed a single status and was wrong the same way.
   */
  function clip(bytes = 8): File {
    return new File([new Uint8Array(bytes)], "clip.wav", { type: "audio/wav" });
  }

  function upload(build: (form: FormData) => void, headers: Record<string, string> = {}): Request {
    const form = new FormData();
    build(form);
    return new Request("http://127.0.0.1/v1/audio/transcriptions", { method: "POST", body: form, headers });
  }

  const ROWS: Array<{ why: string; request: Request; expect: string; status?: number }> = [
    {
      why: "a body that is not multipart",
      request: new Request("http://127.0.0.1/v1/audio/transcriptions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      }),
      expect: "Expected multipart/form-data",
    },
    {
      why: "a compressed body",
      request: upload(f => { f.append("file", clip()); f.append("model", "gpt-4o-transcribe"); },
        { "content-encoding": "gzip" }),
      expect: "Compressed audio request bodies are not supported",
    },
    {
      why: "a field the OpenAI shape does not define",
      request: upload(f => { f.append("file", clip()); f.append("surprise", "1"); }),
      expect: "Unsupported transcription field",
    },
    {
      why: "no file part at all",
      request: upload(f => { f.append("model", "gpt-4o-transcribe"); }),
      expect: "A nonempty audio file is required",
    },
    {
      why: "an empty file",
      request: upload(f => { f.append("file", clip(0)); f.append("model", "gpt-4o-transcribe"); }),
      expect: "A nonempty audio file is required",
    },
    {
      why: "a text field past the 16 KiB cap",
      request: upload(f => {
        f.append("file", clip());
        f.append("model", "gpt-4o-transcribe");
        f.append("prompt", "x".repeat(17_000));
      }),
      expect: "no larger than 16 KiB",
      status: 413,
    },
    {
      why: "a body past the 32 MiB read cap, with no content-length to warn of it",
      // Streamed in 64 KiB chunks so nothing allocates 32 MiB at once, and
      // sent without a content-length — the header check at the top cannot
      // see this, so only the read cap stops it. Two sites, one message, and
      // this is the one that has to hold when the header lies.
      request: new Request("http://127.0.0.1/v1/audio/transcriptions", {
        method: "POST",
        headers: { "content-type": "multipart/form-data; boundary=b" },
        body: new ReadableStream({
          start(controller) {
            const chunk = new Uint8Array(64 * 1024);
            for (let sent = 0; sent < 33 * 1024 * 1024; sent += chunk.length) {
              controller.enqueue(chunk);
            }
            controller.close();
          },
        }),
        // @ts-expect-error duplex is required for a streaming request body
        duplex: "half",
      }),
      expect: "exceeds 32 MiB",
      status: 413,
    },
    {
      why: "a multipart body whose boundary does not match",
      request: new Request("http://127.0.0.1/v1/audio/transcriptions", {
        method: "POST",
        headers: { "content-type": "multipart/form-data; boundary=declared" },
        body: '--actual\r\nContent-Disposition: form-data; name="file"\r\n\r\nx\r\n--actual--\r\n',
      }),
      expect: "Malformed audio multipart body",
    },
    {
      why: "the same field twice",
      request: upload(f => {
        f.append("file", clip());
        f.append("model", "gpt-4o-transcribe");
        // FormData keeps both, so this reaches the duplicate scan rather than
        // being collapsed on the way in.
        f.append("model", "gpt-4o-transcribe");
      }),
      expect: "Duplicate transcription field",
    },
    {
      why: "a model the route does not serve",
      request: upload(f => { f.append("file", clip()); f.append("model", "whisper-9"); }),
      expect: "Unsupported transcription model",
    },
    {
      why: "no model at all",
      request: upload(f => { f.append("file", clip()); }),
      expect: "Unsupported transcription model",
    },
    {
      why: "a response_format that is neither json nor text",
      request: upload(f => {
        f.append("file", clip());
        f.append("model", "gpt-4o-transcribe");
        f.append("response_format", "srt");
      }),
      expect: "response_format must be json or text",
    },
    {
      why: "a language tag that is not BCP-47 shaped",
      request: upload(f => {
        f.append("file", clip());
        f.append("model", "gpt-4o-transcribe");
        f.append("language", "English");
      }),
      expect: "Invalid transcription language",
    },
  ];

  for (const row of ROWS) {
    test(`refuses ${row.why}`, async () => {
      const response = await handleAudioTranscriptions(row.request, config(), LOG, ADMISSION);
      expect(response.status).toBe(row.status ?? 400);
      expect(await response.text()).toContain(row.expect);
    });
  }
});

describe("speech streaming", () => {
  const CONFIGURED = config({ speech: { provider: "pocket" } } as Partial<OcxConfig>);

  async function speakWith(upstream: () => Response): Promise<Response> {
    const real = globalThis.fetch;
    globalThis.fetch = (async () => upstream()) as typeof fetch;
    try {
      return await handleAudioSpeech(speechRequest({ input: "hello" }), CONFIGURED, LOG, ADMISSION);
    } finally {
      globalThis.fetch = real;
    }
  }

  test("audio is forwarded as a stream, carrying the provider's content type", async () => {
    const response = await speakWith(() =>
      new Response(new Blob([new Uint8Array(1024)]).stream(), {
        headers: { "content-type": "audio/wav" },
      }));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("audio/wav");
    expect(await response.arrayBuffer()).toHaveLength(1024);
  });

  test("a response past the cap is torn down mid-flight", async () => {
    // The caller already has a 200, so there is no status left to change:
    // the stream errors and the body ends short. Buffering could have
    // answered 413; streaming cannot, and truncation is the honest end.
    const oversized = new ReadableStream<Uint8Array>({
      start(controller) {
        const chunk = new Uint8Array(1024 * 1024);
        for (let sent = 0; sent <= SPEECH_RESPONSE_MAX_BYTES; sent += chunk.byteLength) {
          controller.enqueue(chunk);
        }
        controller.close();
      },
    });
    const response = await speakWith(() =>
      new Response(oversized, { headers: { "content-type": "audio/wav" } }));
    expect(response.status).toBe(200);
    await expect(response.arrayBuffer()).rejects.toThrow();
  });

  test("an upstream failure is still a clean message, not a streamed error page", async () => {
    const response = await speakWith(() =>
      new Response("upstream exploded", { status: 503 }));
    expect(response.status).toBe(503);
    expect(await response.text()).toContain("returned HTTP 503");
  });

  test("an upstream with no body at all is 502", async () => {
    const response = await speakWith(() => new Response(null, { status: 200 }));
    expect(response.status).toBe(502);
    expect(await response.text()).toContain("no audio");
  });
});

describe("byModel needs a conversation", () => {
  /**
   * The selection is real — a thread whose last turn used one model routes
   * speech to that model's backend — but only when the request log has a
   * conversation id to match on, and only `/v1/responses` and the
   * Claude-messages path record one. `/v1/chat/completions` logs the model and
   * leaves the conversation unset, so a caller on that route can never match.
   *
   * Pinned here because it is invisible from the config: a `byModel` entry
   * looks configured and does nothing, which is the same shape as a guard that
   * is present and inert.
   */
  test("an entry with no conversation id can never be matched", () => {
    const entries = [
      { conversationId: undefined, requestedModel: "stub/model-a", model: "model-a" },
      { conversationId: undefined, requestedModel: "stub/model-b", model: "model-b" },
    ] as unknown as Parameters<typeof latestDictationModelFromEntries>[0];
    expect(latestDictationModelFromEntries(entries, ["some-thread"])).toBeUndefined();
  });

  test("the most recent turn in the thread wins", () => {
    const entries = [
      { conversationId: "t1", requestedModel: "stub/model-a" },
      { conversationId: "t2", requestedModel: "stub/model-b" },
      { conversationId: "t1", requestedModel: "stub/model-c" },
    ] as unknown as Parameters<typeof latestDictationModelFromEntries>[0];
    expect(latestDictationModelFromEntries(entries, ["t1"])).toBe("stub/model-c");
    expect(latestDictationModelFromEntries(entries, ["t2"])).toBe("stub/model-b");
  });

  test("no thread ids at all means no match, whatever is logged", () => {
    const entries = [
      { conversationId: "t1", requestedModel: "stub/model-a" },
    ] as unknown as Parameters<typeof latestDictationModelFromEntries>[0];
    expect(latestDictationModelFromEntries(entries, [])).toBeUndefined();
  });
});
