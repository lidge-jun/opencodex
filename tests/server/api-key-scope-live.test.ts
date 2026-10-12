/**
 * Per-key model and provider scope on the native voice relay (#5049).
 *
 * `/v1/live` and `/v1/realtime/calls` resolve an OpenAI upstream directly and
 * relay the call-create body verbatim, so the model the caller states in its
 * session — or in a standalone socket query — is the destination that gets
 * billed. Nothing here passes through the router, so the scope has to be
 * applied where that upstream is chosen.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MODEL_NOT_ALLOWED_FOR_KEY, UNNAMED_DESTINATION_MODEL } from "../../src/server/admission-model-scope";
import type { DataPlaneAdmission } from "../../src/server/auth-cors";
import { LIVE_AUDIO_MODEL } from "../../src/server/audio-upstream";
import { handleLive, resolveLiveSidebandUpgrade } from "../../src/server/live";
import type { RequestLogContext } from "../../src/server/request-log";
import type { OcxConfig } from "../../src/types";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const SCOPED_KEY = "ocx_data_" + "l".repeat(40);
const OPEN_KEY = "ocx_data_" + "m".repeat(40);
const SCOPED: DataPlaneAdmission = { kind: "configured", keyId: "scoped", source: "dedicated" };
const UNSCOPED: DataPlaneAdmission = { kind: "configured", keyId: "open", source: "dedicated" };
const OTHER_LIVE_MODEL = "gpt-realtime-preview";

const originalFetch = globalThis.fetch;
const previousHome = process.env.OPENCODEX_HOME;
let home = "";
let upstreamCalls: string[] = [];

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ocx-live-scope-"));
  process.env.OPENCODEX_HOME = home;
  upstreamCalls = [];
  globalThis.fetch = (async (input: unknown) => {
    upstreamCalls.push(String(input));
    return new Response("v=0", { status: 200, headers: { "content-type": "application/sdp" } });
  }) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  if (home) removeTreeWithRetry(home);
  home = "";
});

type Scope = { allowedProviders?: string[]; allowedModels?: string[] };

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
  return { model: "gpt-live", provider: "unknown" } as RequestLogContext;
}

/** A call-create the proxy admits by dedicated key, leaving Authorization for the upstream. */
function jsonCallCreate(session?: Record<string, unknown>, key = SCOPED_KEY): Request {
  return new Request("http://localhost/v1/live", {
    method: "POST",
    headers: { "content-type": "application/json", "x-opencodex-api-key": key },
    body: JSON.stringify({ sdp: "v=0", ...(session ? { session } : {}) }),
  });
}

function multipartCallCreate(session: Record<string, unknown>): Request {
  const form = new FormData();
  form.set("sdp", "v=0");
  form.set("session", JSON.stringify(session));
  return new Request("http://localhost/v1/realtime/calls", {
    method: "POST",
    headers: { "x-opencodex-api-key": SCOPED_KEY },
    body: form,
  });
}

async function denial(response: Response): Promise<{ type: string; model: string }> {
  const payload = await response.json() as { error: { type: string; model: string } };
  return payload.error;
}

test("call-create is judged on the live model its session names", async () => {
  const response = await handleLive(
    jsonCallCreate({ model: OTHER_LIVE_MODEL }),
    config({ allowedModels: [LIVE_AUDIO_MODEL] }),
    logContext(),
    undefined,
    SCOPED,
  );
  expect(response.status).toBe(403);
  const error = await denial(response);
  expect(error.type).toBe(MODEL_NOT_ALLOWED_FOR_KEY);
  expect(error.model).toBe(OTHER_LIVE_MODEL);
  expect(upstreamCalls).toEqual([]);
});

test("a multipart call-create states its model in the session field", async () => {
  const response = await handleLive(
    multipartCallCreate({ model: OTHER_LIVE_MODEL }),
    config({ allowedModels: [LIVE_AUDIO_MODEL] }),
    logContext(),
    undefined,
    SCOPED,
  );
  expect(response.status).toBe(403);
  expect((await denial(response)).model).toBe(OTHER_LIVE_MODEL);
  expect(upstreamCalls).toEqual([]);
});

test("a call-create that names no model has no destination a model list can allow", async () => {
  const response = await handleLive(
    jsonCallCreate(),
    config({ allowedModels: ["something-else"] }),
    logContext(),
    undefined,
    SCOPED,
  );
  expect(response.status).toBe(403);
  expect((await denial(response)).model).toBe(UNNAMED_DESTINATION_MODEL);
  expect(upstreamCalls).toEqual([]);
});

test("a provider-only scope still creates a call that names no model", async () => {
  const response = await handleLive(
    jsonCallCreate(),
    config({ allowedProviders: ["openai-apikey"] }),
    logContext(),
    undefined,
    SCOPED,
  );
  expect(response.status).toBe(200);
  expect(upstreamCalls).toHaveLength(1);
});

test("a provider outside the scope cannot serve a voice call", async () => {
  const response = await handleLive(
    jsonCallCreate({ model: LIVE_AUDIO_MODEL }),
    config({ allowedProviders: ["some-other-provider"] }),
    logContext(),
    undefined,
    SCOPED,
  );
  expect(response.status).toBe(403);
  expect(upstreamCalls).toEqual([]);
});

test("an allowed destination still reaches the upstream", async () => {
  const response = await handleLive(
    jsonCallCreate({ model: LIVE_AUDIO_MODEL }),
    config({ allowedProviders: ["openai-apikey"], allowedModels: [LIVE_AUDIO_MODEL] }),
    logContext(),
    undefined,
    SCOPED,
  );
  expect(response.status).toBe(200);
  expect(upstreamCalls).toHaveLength(1);
});

test("a standalone realtime socket is judged on the model in its query", async () => {
  const resolved = await resolveLiveSidebandUpgrade(
    new Request("http://localhost/v1/realtime?model=" + OTHER_LIVE_MODEL, {
      headers: { "x-opencodex-api-key": SCOPED_KEY },
    }),
    config({ allowedModels: [LIVE_AUDIO_MODEL] }),
    logContext(),
    { style: "realtime-standalone", query: "model=" + OTHER_LIVE_MODEL },
    undefined,
    SCOPED,
  );
  expect(resolved).toBeInstanceOf(Response);
  expect((resolved as Response).status).toBe(403);
  expect((await denial(resolved as Response)).model).toBe(OTHER_LIVE_MODEL);
});

test("a native join names no model, so a model list cannot admit it", async () => {
  // This compatibility path records nothing about the calls it relays, so the
  // model a join attaches to is unknowable here. Admitting it against an
  // assumed default would let a key scoped to that default ride a call created
  // for another model.
  const resolved = await resolveLiveSidebandUpgrade(
    new Request("http://localhost/v1/live/call-abc", { headers: { "x-opencodex-api-key": SCOPED_KEY } }),
    config({ allowedModels: [LIVE_AUDIO_MODEL] }),
    logContext(),
    { style: "frameless-path", callId: "call-abc" },
    undefined,
    SCOPED,
  );
  expect(resolved).toBeInstanceOf(Response);
  expect((resolved as Response).status).toBe(403);
});

test("a provider-only scope still joins an existing call", async () => {
  const resolved = await resolveLiveSidebandUpgrade(
    new Request("http://localhost/v1/live/call-abc", { headers: { "x-opencodex-api-key": SCOPED_KEY } }),
    config({ allowedProviders: ["openai-apikey"] }),
    logContext(),
    { style: "frameless-path", callId: "call-abc" },
    undefined,
    SCOPED,
  );
  expect(resolved).not.toBeInstanceOf(Response);
  expect((resolved as { upstreamWsUrl: string }).upstreamWsUrl).toContain("call-abc");
});

test("a key with no scope keeps the voice relay unrestricted", async () => {
  const response = await handleLive(
    jsonCallCreate({ model: OTHER_LIVE_MODEL }, OPEN_KEY),
    config({ allowedModels: [LIVE_AUDIO_MODEL] }),
    logContext(),
    undefined,
    UNSCOPED,
  );
  expect(response.status).toBe(200);
  expect(upstreamCalls).toHaveLength(1);
});
