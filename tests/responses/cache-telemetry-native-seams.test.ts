import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  addFinalRequestLog, beginRequestAttempt, clearRequestLogsForTests, noteAttemptSend,
  noteProviderAttemptSend, type RequestLogContext,
} from "../../src/server/request-log";
import { createNativeSteeringLogObserver } from "../../src/server/responses/native-steering-log";
import { guardPassthroughCompletion } from "../../src/server/responses/passthrough-completion";
import { usageFromComboFailureText } from "../../src/server/responses/core-combo-failure";
import { handleResponsesCompact } from "../../src/server/responses/compact";
import type { OcxConfig, OcxProviderConfig } from "../../src/types";
import { cacheProvenance } from "../../src/usage/cache-telemetry";
import { cacheDiagnosticPath } from "../../src/usage/cache-diagnostic";
import { readUsageEntries } from "../../src/usage/log";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const PROXY_ENV = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy"];
const ENV = [...PROXY_ENV, "OPENCODEX_HOME", "OPENCODEX_CACHE_DEBUG"];
const realFetch = globalThis.fetch;
const realSocket = globalThis.WebSocket;
let saved: Record<string, string | undefined>;
let home: string;
let release: () => void;

beforeEach(() => {
  saved = Object.fromEntries(ENV.map(key => [key, process.env[key]]));
  for (const key of PROXY_ENV) delete process.env[key];
  home = mkdtempSync(join(tmpdir(), "cache-native-seams-"));
  process.env.OPENCODEX_HOME = home;
  process.env.OPENCODEX_CACHE_DEBUG = "1";
  globalThis.fetch = (async () => { throw new Error("No network in native cache seam fixtures"); }) as typeof fetch;
  globalThis.WebSocket = class {
    constructor() { throw new Error("No upstream sockets in native cache seam fixtures"); }
  } as unknown as typeof WebSocket;
  clearRequestLogsForTests();
  release = acquireOwnedSpendHome();
});

afterEach(() => {
  release();
  globalThis.fetch = realFetch;
  globalThis.WebSocket = realSocket;
  clearRequestLogsForTests();
  for (const key of ENV) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  removeTreeWithRetry(home);
});

const rawUsage = (cached?: number) => ({ input_tokens: 10, output_tokens: 2,
  ...(cached === undefined ? {} : { input_tokens_details: { cached_tokens: cached } }),
  privateMetadata: "must-not-survive-internal-usage",
});

function context(): RequestLogContext {
  const attempt = beginRequestAttempt(1, "fixture", "fixture-model", "openai-responses");
  noteAttemptSend(attempt, undefined);
  return { provider: "fixture", model: "fixture-model", attempts: [attempt], activeAttempt: attempt };
}

function payload(id: string, usage?: unknown, steered = false): string {
  return JSON.stringify({ type: steered ? "response.incomplete" : "response.completed", response: {
    id, status: steered ? "incomplete" : "completed", output: [],
    ...(steered ? { incomplete_details: { reason: "steered" } } : {}),
    ...(usage === undefined ? {} : { usage }),
  } });
}

describe("native-control raw cache observations", () => {
  for (const cached of [0, undefined, 40]) test(`a single terminal retains ${cached ?? "missing"} upstream evidence`, () => {
    const log = context();
    createNativeSteeringLogObserver(log)(payload("one", rawUsage(cached)));
    expect(log.usage?.cacheTelemetry).toEqual({ source: "upstream", usagePresent: true,
      ...(cached === undefined ? {} : { read: cached }) });
    expect(cacheProvenance(log.usage)).toBe(cached === undefined ? "unknown" : "observed");
    expect(JSON.stringify(log.usage)).not.toContain("must-not-survive");
    addFinalRequestLog("native-fixture", Date.now(), log, 200);
    const saved = readUsageEntries()[0]!;
    expect(saved.usage?.cacheTelemetry).toEqual(log.usage?.cacheTelemetry);
    expect(saved.attempts?.[0]?.usage?.cacheTelemetry).toEqual(log.usage?.cacheTelemetry);
    const raw = JSON.parse(readFileSync(cacheDiagnosticPath(), "utf8").trim()).cache.rawUpstream;
    expect(raw).toEqual({ observed: true, usagePresent: true, present: cached !== undefined,
      ...(cached === undefined ? {} : { value: cached }) });
  });

  for (const [first, second] of [[0, 0], [0, undefined], [undefined, 0], [40, 0]] as const) {
    test(`successor chain combines ${first ?? "missing"}/${second ?? "missing"} without upgrading partial evidence`, () => {
      const log = context();
      const inspect = createNativeSteeringLogObserver(log);
      inspect(payload("parent", rawUsage(first), true));
      inspect(payload("successor", rawUsage(second)));
      expect(log.usage).toMatchObject({ inputTokens: 20, outputTokens: 4,
        cacheTelemetry: { source: "aggregate", complete: first !== undefined && second !== undefined,
          read: (first ?? 0) + (second ?? 0) } });
      expect(cacheProvenance(log.usage)).toBe(first === undefined || second === undefined ? "unknown" : "observed");
      expect(log.upstreamError).toBeUndefined();
      inspect(payload("successor", rawUsage(second)));
      expect(log.usage?.inputTokens).toBe(20);
      expect(log.activeAttempt?.usage).toBe(log.usage);
    });
  }

  test("a terminal with no usage makes the native chain incomplete, not fully observed", () => {
    const log = context();
    const inspect = createNativeSteeringLogObserver(log);
    inspect(payload("parent", rawUsage(0), true));
    inspect(payload("successor"));
    expect(log.usage).toMatchObject({ inputTokens: 10, outputTokens: 2,
      cacheTelemetry: { source: "aggregate", complete: false, read: 0 } });
    expect(cacheProvenance(log.usage)).toBe("unknown");
    addFinalRequestLog("absent-successor", Date.now(), log, 200);
    expect(JSON.parse(readFileSync(cacheDiagnosticPath(), "utf8").trim()).cache.rawUpstream)
      .toEqual({ observed: true, usagePresent: false, present: false });
  });

  test("a repeated terminal that omits usage cannot leave its previous cache count", () => {
    const log = context();
    const inspect = createNativeSteeringLogObserver(log);
    inspect(payload("one", rawUsage(40)));
    inspect(payload("one"));
    expect(log.usage).toBeUndefined();
    expect(log.activeAttempt?.usage).toBeUndefined();
  });

  test("control acknowledgements cannot contribute a cache observation", () => {
    const log = context();
    const inspect = createNativeSteeringLogObserver(log);
    for (const type of ["response.steer.accepted", "response.inject.failed"]) {
      inspect(JSON.stringify({ type, response: { id: "control", usage: rawUsage(40) } }));
    }
    expect(log.usage).toBeUndefined();
  });
});

describe("discarded OpenGateway completion usage is still raw", () => {
  for (const stream of [false, true]) for (const cached of [0, undefined, 40]) {
    test(`${stream ? "SSE" : "JSON"} records ${cached ?? "missing"} before replacing the empty completion`, async () => {
      const attempt = beginRequestAttempt(1, "fixture", "fixture-model", "openai-responses");
      const log: RequestLogContext = { provider: "fixture", model: "fixture-model", attempts: [attempt], activeAttempt: attempt };
      noteProviderAttemptSend(log, "fixture", { adapter: "openai-responses", authMode: "key" }, undefined);
      const snapshot = { id: "empty", object: "response", status: "completed", output: [], usage: rawUsage(cached) };
      const source = stream
        ? new Response(`data: ${JSON.stringify({ type: "response.completed", response: snapshot })}\n\n`,
          { headers: { "content-type": "text/event-stream" } })
        : Response.json(snapshot);
      const response = await guardPassthroughCompletion(source, {
        url: "https://apis.opengateway.ai/v1/responses", method: "POST", headers: {},
        body: JSON.stringify({ model: "fixture-model", input: "fixture", store: false, stream }),
      }, { emptyCompletionRetry: false }, new AbortController().signal, log,
      async () => { throw new Error("Retry disabled in cache seam fixture"); });
      expect(await response.text()).not.toContain("cacheTelemetry");
      expect(log.activeAttempt?.usage?.cacheTelemetry).toEqual({ source: "upstream", usagePresent: true,
        ...(cached === undefined ? {} : { read: cached }) });
      expect(cacheProvenance(log.usage)).toBe(cached === undefined ? "unknown" : "observed");
      expect(JSON.stringify(log.usage)).not.toContain("must-not-survive");
    });
  }
});

for (const cached of [0, 40]) test(`client failure JSON with cache ${cached} cannot claim raw upstream evidence`, () => {
  const usage = usageFromComboFailureText(JSON.stringify({ response: { usage: rawUsage(cached) } }));
  expect(usage?.cacheTelemetry).toEqual({ source: "client", usagePresent: true });
  expect(cacheProvenance(usage)).toBe("unknown");
});

describe("native compact raw HTTP usage", () => {
  for (const cached of [0, undefined, 40, null]) test(`buffered compact preserves ${cached === null ? "no usage" : cached ?? "missing counter"}`, async () => {
    let sends = 0;
    const snapshot = { id: "compact-fixture", object: "response", status: "completed",
      output: [{ id: "compaction-fixture", type: "compaction", encrypted_content: "fixture-compaction-ciphertext" }],
      ...(cached === null ? {} : { usage: rawUsage(cached) }) };
    const provider: OcxProviderConfig & { fetch: typeof fetch } = {
      adapter: "openai-responses", baseUrl: "https://api.openai.com/v1", authMode: "key", apiKey: "fixture-only-key",
      // The physical send is an in-memory fixture, not a wrapper around a real fetch.
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        expect(String(input)).toBe("https://api.openai.com/v1/responses/compact");
        expect(init?.method).toBe("POST");
        sends++;
        return Response.json(snapshot);
      }) as typeof fetch,
    };
    const config = { port: 0, defaultProvider: "openai-apikey", providers: { "openai-apikey": provider } } as OcxConfig;
    const log: RequestLogContext = { provider: "", model: "" };
    const response = await handleResponsesCompact(new Request("http://127.0.0.1/v1/responses/compact", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "openai-apikey/gpt-5.5", input: [{ role: "user", content: "fixture compact input" }] }),
    }), config, log);
    expect(response.status).toBe(200);
    const client = await response.text();
    expect(JSON.parse(client)).toEqual(snapshot);
    expect(client).not.toContain("cacheTelemetry");
    expect(sends).toBe(1);
    expect(log.usage?.cacheTelemetry).toEqual(cached === null ? undefined : {
      source: "upstream", usagePresent: true, ...(cached === undefined ? {} : { read: cached }),
    });
    addFinalRequestLog("native-compact", Date.now(), log, 200);
    const saved = readUsageEntries()[0]!;
    expect(saved.cacheProvenance).toBe(cached === undefined || cached === null ? "unknown" : "observed");
    // Native compact currently records request usage without creating an attempt row.
    expect(saved.usage?.cacheTelemetry).toEqual(log.usage?.cacheTelemetry);
    expect(JSON.parse(readFileSync(cacheDiagnosticPath(), "utf8").trim()).cache.rawUpstream).toEqual({
      observed: true, usagePresent: cached !== null, present: cached !== undefined && cached !== null,
      ...(cached === undefined || cached === null ? {} : { value: cached }),
    });
  });
});
