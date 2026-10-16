/** Real auth resolver + protocol handler composition (not the full serve dispatcher). */
import { expect, test, spyOn } from "bun:test";
import { Readable } from "node:stream";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveApiAuth, resolveResponsesApiAuth } from "../../src/server/auth-cors";
import { formatErrorResponse } from "../../src/bridge/errors";
import { anthropicErrorResponse } from "../../src/claude/outbound";
import { handleResponses } from "../../src/server/responses";
import { handleChatCompletions } from "../../src/server/chat-completions";
import { handleClaudeMessages } from "../../src/server/claude-messages";
import { handleSelectedKeyTest } from "../../src/cli/access-data-plane";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import type { OcxConfig } from "../../src/types";

for (const protocol of ["responses", "chat", "messages"] as const) {
  for (const scenario of ["authless", "wrong", "valid", "changed-policy"] as const) {
    test(`${protocol}: ${scenario} invokes real admission and real native parser/handler`, async () => {
      const prior = process.env.OPENCODEX_HOME;
      const priorToken = process.env.OPENCODEX_API_AUTH_TOKEN;
      const home = mkdtempSync(join(tmpdir(), "ocx-cli-probe-"));
      process.env.OPENCODEX_HOME = home; delete process.env.OPENCODEX_API_AUTH_TOKEN;
      let providerCalls = 0, dataCalls = 0;
      const provider = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
        providerCalls++;
        expect(req.headers.get("x-opencodex-api-key")).not.toBe("fixture-selected");
        await req.json();
        return Response.json({ id: "fixture-response", object: "response", status: "completed",
          output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "OK" }] }],
          usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 } });
      } });
      const config: OcxConfig = { port: 0, hostname: scenario === "authless" ? "127.0.0.1" : "0.0.0.0", defaultProvider: "fixture",
        providers: { fixture: { adapter: "openai-responses", baseUrl: `http://127.0.0.1:${provider.port}/v1`, apiKey: "fixture-provider", authMode: "key", allowPrivateNetwork: true, models: ["model"] } },
        apiKeys: [{ id: "fixture-id", name: "fixture", key: "fixture-selected", createdAt: "2026-01-01T00:00:00.000Z" }] };
      const release = acquireOwnedSpendHome();
      const logs: string[] = [];
      const out = spyOn(console, "log").mockImplementation(value => { logs.push(String(value)); });
      const err = spyOn(console, "error").mockImplementation(() => {});
      try {
        const code = await handleSelectedKeyTest(["fixture/model", "--protocol", protocol, "--api-key-stdin", "--json"], {
          stdinImpl: Readable.from([Buffer.from(scenario === "wrong" || scenario === "changed-policy" ? "wrong-selected" : "fixture-selected")]),
          readClientConnectionState: () => ({ kind: "disconnected" }),
          findLiveProxy: async () => ({ port: 12345, pid: 1, hostname: "127.0.0.1", source: "runtime" }),
          fetchImpl: (async (url, init) => {
            dataCalls++;
            if (scenario === "changed-policy" && dataCalls === 2) config.hostname = "127.0.0.1";
            const req = new Request(url, init);
            const admission = protocol === "messages" ? resolveApiAuth(req, config) : resolveResponsesApiAuth(req, config);
            if (!admission) return protocol === "messages"
              ? anthropicErrorResponse(401, "opencodex API key required", "authentication_error")
              : formatErrorResponse(401, "authentication_error", "opencodex API key required");
            const context = { model: "fixture/model", provider: "fixture" };
            if (protocol === "responses") return handleResponses(req, config, context);
            if (protocol === "chat") return handleChatCompletions(req, config, context);
            return handleClaudeMessages(req, config, context);
          }) as typeof fetch,
        });
        expect(code).toBe(scenario === "valid" || scenario === "changed-policy" ? 0 : 1);
        expect(dataCalls).toBe(scenario === "authless" ? 1 : 2);
        expect(providerCalls).toBe(scenario === "valid" || scenario === "changed-policy" ? 1 : 0);
        const report = JSON.parse(logs.at(-1)!);
        expect(report.control.outcome).toBe(scenario === "authless" ? "unavailable" : "credential_required");
        if (scenario === "changed-policy") {
          // The wrong key succeeds after policy changes: this is an observation, never an atomic admission certificate.
          expect(report.request.outcome).toBe("succeeded");
          expect(report).not.toHaveProperty("verified");
        }
      } finally {
        out.mockRestore(); err.mockRestore(); release(); await provider.stop(true);
        if (prior === undefined) delete process.env.OPENCODEX_HOME; else process.env.OPENCODEX_HOME = prior;
        if (priorToken === undefined) delete process.env.OPENCODEX_API_AUTH_TOKEN; else process.env.OPENCODEX_API_AUTH_TOKEN = priorToken;
        removeTreeWithRetry(home);
      }
    });
  }
}
test("disabled Messages uses real broad admission then real surface refusal", async () => {
  const config: OcxConfig = { port: 0, hostname: "0.0.0.0", providers: {}, apiSurfaces: { messages: { enabled: false } },
    apiKeys: [{ id: "id", name: "fixture", key: "fixture-selected", createdAt: "2026-01-01T00:00:00.000Z" }] };
  const logs: string[] = []; let count = 0;
  const out = spyOn(console, "log").mockImplementation(value => { logs.push(String(value)); });
  const err = spyOn(console, "error").mockImplementation(() => {});
  try {
    expect(await handleSelectedKeyTest(["fixture/model", "--protocol=messages", "--api-key-stdin", "--json"], {
      stdinImpl: Readable.from([Buffer.from("fixture-selected")]), readClientConnectionState: () => ({ kind: "disconnected" }),
      findLiveProxy: async () => ({ port: 12345, pid: 1, source: "runtime" }),
      fetchImpl: (async (url, init) => { count++; const req = new Request(url, init);
        return resolveApiAuth(req, config) ? handleClaudeMessages(req, config, { model: "", provider: "" })
          : anthropicErrorResponse(401, "opencodex API key required", "authentication_error"); }) as typeof fetch,
    })).toBe(1);
    expect(count).toBe(2); expect(JSON.parse(logs[0]!).request).toEqual({ outcome: "failed", status: 403 });
  } finally { out.mockRestore(); err.mockRestore(); }
});
