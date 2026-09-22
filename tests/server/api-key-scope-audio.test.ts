/**
 * Per-key model and provider scope on the audio and voice data planes (#5049).
 *
 * None of these endpoints resolves a model through the router, so the scope
 * landed with #5265 did not reach them. They share one upstream decision in
 * `resolveAudioUpstream`, and the model it is given is the model the upstream
 * will run, so the refusal is asserted once per endpoint that reaches it.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MODEL_NOT_ALLOWED_FOR_KEY } from "../../src/server/admission-model-scope";
import { resolveAudioClient, type AudioClient } from "../../src/server/audio-client";
import { resolveDictationSocket } from "../../src/server/audio-dictation";
import { handleExternalLive, resolveExternalLiveSocket } from "../../src/server/audio-live";
import { handleAudioTranscriptions } from "../../src/server/audio-transcriptions";
import { LIVE_AUDIO_MODEL, TRANSCRIPTION_MODEL } from "../../src/server/audio-upstream";
import { LiveCallBindings } from "../../src/server/live-call-bindings";
import { tryAdmitTurn } from "../../src/server/lifecycle";
import type { RequestLogContext } from "../../src/server/request-log";
import type { AdmissionLease } from "../../src/lib/admission";
import type { OcxConfig } from "../../src/types";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const SCOPED_KEY = "ocx_data_" + "a".repeat(40);
const OPEN_KEY = "ocx_data_" + "b".repeat(40);
const OTHER_LIVE_MODEL = "gpt-live-1-experimental";

const originalFetch = globalThis.fetch;
const previousHome = process.env.OPENCODEX_HOME;
let home = "";
let upstreamCalls: string[] = [];
let leases: AdmissionLease[] = [];

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ocx-audio-scope-"));
  process.env.OPENCODEX_HOME = home;
  upstreamCalls = [];
  leases = [];
  globalThis.fetch = (async (input: unknown) => {
    upstreamCalls.push(String(input));
    return Response.json({ text: "hello" });
  }) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const lease of leases.splice(0)) lease.release();
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  if (home) removeTreeWithRetry(home);
  home = "";
});

type Scope = { allowedProviders?: string[]; allowedModels?: string[] };

/**
 * A keyed OpenAI platform provider and nothing else: the audio upstream then
 * resolves without a stored ChatGPT credential, so each case exercises the
 * scope decision rather than account selection.
 */
function config(scope: Scope): OcxConfig {
  return {
    port: 0,
    hostname: "127.0.0.1",
    defaultProvider: "openai-apikey",
    providers: {
      "openai-apikey": {
        adapter: "openai-responses",
        baseUrl: "https://api.openai.com/v1",
        apiKey: "fixture-upstream-key",
        authMode: "key",
      },
    },
    apiKeys: [
      { id: "scoped", name: "mail", key: SCOPED_KEY, createdAt: "2026-01-01T00:00:00.000Z", ...scope },
      { id: "open", name: "coding", key: OPEN_KEY, createdAt: "2026-01-01T00:00:00.000Z" },
    ],
  } as OcxConfig;
}

function logContext(): RequestLogContext {
  return { model: "unknown", provider: "unknown" } as RequestLogContext;
}

function lease(): AdmissionLease {
  const admitted = tryAdmitTurn();
  if (!admitted) throw new Error("the turn gate refused an idle test lease");
  leases.push(admitted);
  return admitted;
}

function client(cfg: OcxConfig, key = SCOPED_KEY): AudioClient {
  const resolved = resolveAudioClient(
    new Request("http://localhost/v1/live", { headers: { "x-opencodex-api-key": key } }),
    cfg,
  );
  if (!resolved || resolved instanceof Response) throw new Error("the audio key was not admitted");
  return resolved;
}

function transcriptionRequest(): Request {
  const form = new FormData();
  form.append("file", new File([new Uint8Array([82, 73, 70, 70, 0, 0])], "sample.wav", { type: "audio/wav" }));
  form.append("model", TRANSCRIPTION_MODEL);
  return new Request("http://localhost/v1/audio/transcriptions", {
    method: "POST",
    headers: { "x-opencodex-api-key": SCOPED_KEY },
    body: form,
  });
}

async function denial(response: Response): Promise<{ type: string; model: string }> {
  const payload = await response.json() as { error: { type: string; model: string } };
  return payload.error;
}

test("file transcription refuses a provider the key may not reach", async () => {
  const cfg = config({ allowedProviders: ["some-other-provider"] });
  const response = await handleAudioTranscriptions(
    transcriptionRequest(),
    cfg,
    logContext(),
    client(cfg).admission,
  );
  expect(response.status).toBe(403);
  const error = await denial(response);
  expect(error.type).toBe(MODEL_NOT_ALLOWED_FOR_KEY);
  expect(error.model).toBe(TRANSCRIPTION_MODEL);
  expect(upstreamCalls).toEqual([]);
});

test("file transcription still runs when the scope names its destination", async () => {
  const cfg = config({ allowedProviders: ["openai-apikey"], allowedModels: [TRANSCRIPTION_MODEL] });
  const response = await handleAudioTranscriptions(
    transcriptionRequest(),
    cfg,
    logContext(),
    client(cfg).admission,
  );
  expect(response.status).toBe(200);
  expect(upstreamCalls).toHaveLength(1);
});

test("the dictation socket refuses before it resolves a credential", async () => {
  const cfg = config({ allowedProviders: ["some-other-provider"] });
  const resolved = await resolveDictationSocket(client(cfg), cfg, logContext(), lease());
  expect(resolved).toBeInstanceOf(Response);
  const response = resolved as Response;
  expect(response.status).toBe(403);
  expect((await denial(response)).type).toBe(MODEL_NOT_ALLOWED_FOR_KEY);
});

test("an allowed dictation key reaches its own capability error instead", async () => {
  const cfg = config({ allowedModels: [TRANSCRIPTION_MODEL] });
  const resolved = await resolveDictationSocket(client(cfg), cfg, logContext(), lease());
  expect(resolved).toBeInstanceOf(Response);
  // Streaming dictation needs a ChatGPT account; the point is that the scope is
  // no longer what stops it.
  expect((resolved as Response).status).toBe(400);
});

test("voice call-create refuses the live model the session names", async () => {
  const cfg = config({ allowedModels: ["gpt-4o-transcribe-only"] });
  const response = await handleExternalLive(
    new Request("http://localhost/v1/live", {
      method: "POST",
      headers: { "content-type": "application/json", "x-opencodex-api-key": SCOPED_KEY },
      body: JSON.stringify({ sdp: "v=0" }),
    }),
    cfg,
    logContext(),
    { client: client(cfg), lease: lease(), bindings: new LiveCallBindings() },
  );
  expect(response.status).toBe(403);
  const error = await denial(response);
  expect(error.type).toBe(MODEL_NOT_ALLOWED_FOR_KEY);
  expect(error.model).toBe(LIVE_AUDIO_MODEL);
  expect(upstreamCalls).toEqual([]);
});

test("a standalone realtime socket is judged on the model in its own query", async () => {
  const cfg = config({ allowedModels: [LIVE_AUDIO_MODEL] });
  const resolved = await resolveExternalLiveSocket(
    client(cfg),
    cfg,
    logContext(),
    { style: "frameless-standalone", query: "model=" + OTHER_LIVE_MODEL },
    { lease: lease(), bindings: new LiveCallBindings() },
  );
  expect(resolved).toBeInstanceOf(Response);
  const response = resolved as Response;
  expect(response.status).toBe(403);
  expect((await denial(response)).model).toBe(OTHER_LIVE_MODEL);
});

test("a Realtime standalone socket is judged on its query too, not the default", async () => {
  // The Frameless branch rewrites its query and was the only one read. A
  // Realtime standalone socket forwards `model=` untouched, so reading the
  // default here admitted a model the caller was never allowed to run.
  const cfg = config({ allowedModels: [LIVE_AUDIO_MODEL] });
  const resolved = await resolveExternalLiveSocket(
    client(cfg),
    cfg,
    logContext(),
    { style: "realtime-standalone", query: "intent=quicksilver&model=" + OTHER_LIVE_MODEL },
    { lease: lease(), bindings: new LiveCallBindings() },
  );
  expect(resolved).toBeInstanceOf(Response);
  expect((resolved as Response).status).toBe(403);
  expect((await denial(resolved as Response)).model).toBe(OTHER_LIVE_MODEL);
});

test("rejoining a call is judged on the model that call settled on", async () => {
  const cfg = config({ allowedModels: [LIVE_AUDIO_MODEL] });
  const audio = client(cfg);
  const bindings = new LiveCallBindings();
  const alias = bindings.create({
    owner: audio.owner,
    upstreamCallId: "call-upstream",
    joinStyle: "frameless-path",
    providerName: "openai-apikey",
    model: OTHER_LIVE_MODEL,
    callerOwned: false,
  });
  expect(alias).not.toBeNull();
  const resolved = await resolveExternalLiveSocket(
    audio,
    cfg,
    logContext(),
    { style: "frameless-path", callId: alias as string },
    { lease: lease(), bindings },
  );
  expect(resolved).toBeInstanceOf(Response);
  expect((resolved as Response).status).toBe(403);
  expect((await denial(resolved as Response)).model).toBe(OTHER_LIVE_MODEL);
});

test("a key with no scope keeps every audio destination", async () => {
  const cfg = config({ allowedProviders: ["some-other-provider"] });
  const response = await handleAudioTranscriptions(
    transcriptionRequest(),
    cfg,
    logContext(),
    client(cfg, OPEN_KEY).admission,
  );
  expect(response.status).toBe(200);
  expect(upstreamCalls).toHaveLength(1);
});
