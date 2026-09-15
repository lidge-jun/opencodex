import { describe, expect, test } from "bun:test";
import { createResponsesPassthroughAdapter } from "../../src/adapters/openai-responses";
import { parseRequest } from "../../src/responses/parser";
import { handleResponses } from "../../src/server/responses";
import { selectForwardHeaders } from "../../src/server/ws-bridge";
import { describeImage } from "../../src/vision/describe";
import { runWebSearch } from "../../src/web-search/executor";
import type { OcxConfig, OcxProviderConfig } from "../../src/types";
import { withTestTranslatorBudget } from "../helpers/translator-budget";

const callerUserAgent = "codex_cli_rs/0.153.0 (Windows 11; x86_64)";
const providerUserAgent = "provider-client/1.0";
const routes: Array<[string, OcxProviderConfig]> = [
  ["API key", { adapter: "openai-responses", baseUrl: "https://fixture.test/v1", authMode: "key", apiKey: "fixture-key" }],
  ["canonical forward", { adapter: "openai-responses", baseUrl: "https://chatgpt.com/backend-api/codex", authMode: "forward" }],
  ["custom forward", { adapter: "openai-responses", baseUrl: "https://fixture.test/v1", authMode: "forward" }],
];

/** Exercise the production adapter with the shared test budget lifecycle. */
function buildRequest(provider: OcxProviderConfig, incoming: Headers) {
  return withTestTranslatorBudget(createResponsesPassthroughAdapter(provider)).buildRequest(
    parseRequest({ model: "fixture-model", input: "ping", stream: false }),
    { headers: incoming },
  );
}

describe("Responses upstream User-Agent", () => {
  test("WebSocket bridge retains the caller UA without forwarding unrelated headers", () => {
    const selected = selectForwardHeaders(new Headers({
      "User-Agent": callerUserAgent, "x-unrelated": "private", cookie: "fixture=value",
    }));
    expect(selected.get("user-agent")).toBe(callerUserAgent);
    expect(selected.has("x-unrelated")).toBe(false);
    expect(selected.has("cookie")).toBe(false);
  });

  for (const [name, provider] of routes) {
    test(`${name}: preserves the caller identity without forwarding unrelated headers`, () => {
      const incoming = new Headers({ "User-Agent": callerUserAgent, cookie: "fixture=value", "x-unrelated": "private" });
      const result = new Headers(buildRequest(provider, incoming).headers);
      expect(result.get("user-agent")).toBe(callerUserAgent);
      expect(result.has("cookie")).toBe(false);
      expect(result.has("x-unrelated")).toBe(false);
      expect(incoming.get("user-agent")).toBe(callerUserAgent);
    });

    // Header casing must not produce two identities when the transport normalizes names.
    for (const headerName of ["User-Agent", "user-agent", "USER-AGENT"]) {
      test(`${name}: explicit ${headerName} wins without a duplicate`, () => {
        const configured = { [headerName]: providerUserAgent, "x-provider-option": "enabled" };
        const request = buildRequest({ ...provider, headers: configured }, new Headers({ "user-agent": callerUserAgent }));
        const result = new Headers(request.headers);
        expect(result.get("user-agent")).toBe(providerUserAgent);
        expect(Object.keys(request.headers).filter(key => key.toLowerCase() === "user-agent")).toHaveLength(1);
        expect(result.get("x-provider-option")).toBe("enabled");
        expect(configured).toEqual({ [headerName]: providerUserAgent, "x-provider-option": "enabled" });
      });
    }

    test(`${name}: missing caller UA does not fabricate a client identity`, () => {
      expect(new Headers(buildRequest(provider, new Headers()).headers).has("user-agent")).toBe(false);
    });

    test(`${name}: an explicitly empty provider UA still takes precedence`, () => {
      const result = new Headers(buildRequest({ ...provider, headers: { "User-Agent": "" } },
        new Headers({ "user-agent": callerUserAgent })).headers);
      expect(result.get("user-agent")).toBe("");
    });
  }

  for (const override of [false, true]) {
    test(`HTTP upstream receives ${override ? "the configured override" : "the original Codex UA"}`, async () => {
      const expected = override ? providerUserAgent : callerUserAgent;
      const received: Array<string | null> = [];
      // Model a UA-gated upstream on loopback, without real provider credentials.
      const upstream = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        async fetch(request) {
          await request.text();
          const ua = request.headers.get("user-agent");
          received.push(ua);
          if (ua !== expected) return Response.json({ error: { message: "client compatibility was not selected" } }, { status: 400 });
          return Response.json({ id: "resp_fixture", object: "response", status: "completed", output: [
            { type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }] },
          ] });
        },
      });
      try {
        const config = {
          port: 0,
          defaultProvider: "fixture",
          providers: { fixture: {
            adapter: "openai-responses", baseUrl: `${upstream.url.origin}/v1`,
            authMode: "key", apiKey: "fixture-key", allowPrivateNetwork: true,
            ...(override ? { headers: { "USER-AGENT": providerUserAgent } } : {}),
          } },
        } as OcxConfig;
        const response = await handleResponses(new Request("http://localhost/v1/responses", {
          method: "POST",
          headers: { "content-type": "application/json", "user-agent": callerUserAgent },
          body: JSON.stringify({ model: "fixture/model", input: "ping", stream: false }),
          signal: AbortSignal.timeout(5000),
        }), config, { model: "", provider: "" });
        expect(response.status).toBe(200);
        expect(await response.text()).toContain("ok");
        expect(received).toEqual([expected]);
      } finally {
        await upstream.stop(true);
      }
    });
  }

  for (const kind of ["search", "vision"] as const) {
    for (const headerName of [undefined, "User-Agent", "user-agent", "USER-AGENT"]) {
      test(`${kind} sidecar preserves ${headerName ?? "caller UA"} on the wire`, async () => {
        const received: Array<string | null> = [];
        const upstream = Bun.serve({
          hostname: "127.0.0.1",
          port: 0,
          async fetch(request) {
            await request.text();
            received.push(request.headers.get("user-agent"));
            return new Response('data: {"type":"response.output_text.delta","delta":"ok"}\n\n'
              + 'data: {"type":"response.completed","response":{"status":"completed"}}\n\n',
            { headers: { "content-type": "text/event-stream" } });
          },
        });
        try {
          const provider: OcxProviderConfig = {
            adapter: "openai-responses", baseUrl: upstream.url.origin, authMode: "forward",
            ...(headerName ? { headers: { [headerName]: providerUserAgent } } : {}),
          };
          const incoming = new Headers({ "user-agent": callerUserAgent });
          const settings = { model: "fixture-model", reasoning: "low" as const, timeoutMs: 5000 };
          const result = kind === "search"
            ? await runWebSearch("ping", { type: "web_search" }, provider, incoming, settings)
            : await describeImage("data:image/png;base64,AA==", "low", "ping", provider, incoming, settings);
          expect(result.error).toBeUndefined();
          expect(received).toEqual([headerName ? providerUserAgent : callerUserAgent]);
        } finally {
          await upstream.stop(true);
        }
      });
    }
  }
});
