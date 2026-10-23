import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearComboSelectionState, clearComboTargetCooldowns } from "../../src/combos";
import { clearKeyCooldowns } from "../../src/providers/key-failover";
import { clearReasoningReplayCacheForTests } from "../../src/responses/reasoning-replay-cache";
import { clearResponseStateForTests, flushResponseState } from "../../src/responses/state";
import { resetThoughtSignatureReplayForTests } from "../../src/responses/thought-signature-replay";
import { closeRequestHistoryIndex } from "../../src/routing/history/indexer";
import { resolveContextPrincipal, resolveResponsesApiAuth } from "../../src/server/auth-cors";
import type { RequestLogContext } from "../../src/server/request-log";
import { clearComboRecallForTests } from "../../src/server/responses/combo-session-recall";
import { handleResponses } from "../../src/server/responses/core";
import type { OcxConfig, OcxProviderConfig } from "../../src/types";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import { removeTreeWithRetry } from "../helpers/remove-tree";

type Rec = Record<string, any>;
const MODEL = "deepseek-v4.1-flash";
const THREAD = "bridge-replay-principal-thread";
const PRIVATE = "synthetic owner reasoning";
const CALL = "call_bridge_principal";
const originalFetch = globalThis.fetch;
const previousHome = process.env.OPENCODEX_HOME;
let home: string | undefined;
let releaseSpend: (() => void) | undefined;
function clearRouteState() {
  clearComboSelectionState(); clearComboTargetCooldowns(); clearComboRecallForTests(); clearKeyCooldowns();
}
beforeEach(() => {
  home = undefined;
  home = mkdtempSync(join(tmpdir(), "ocx-bridge-replay-principal-"));
  process.env.OPENCODEX_HOME = home;
  releaseSpend = acquireOwnedSpendHome();
  clearRouteState(); clearReasoningReplayCacheForTests(); clearResponseStateForTests();
  resetThoughtSignatureReplayForTests();
});
afterEach(async () => {
  if (!home) return;
  releaseSpend?.(); releaseSpend = undefined;
  closeRequestHistoryIndex(); await flushResponseState(); clearResponseStateForTests();
  globalThis.fetch = originalFetch;
  clearRouteState(); clearReasoningReplayCacheForTests(); resetThoughtSignatureReplayForTests();
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  removeTreeWithRetry(home);
});

test.each([false, true])("bridge Combo retains bearer-only loopback principal through child dispatch (failover=%s)", async failover => {
  const target = failover ? "second" : "first";
  const row = (name: string): OcxProviderConfig => ({
    adapter: "openai-chat", baseUrl: `https://${name}.example.test/v1`, authMode: "key",
    apiKey: `synthetic-provider-${name}`, models: [MODEL],
  });
  const config: OcxConfig = {
    port: 0, hostname: "127.0.0.1", defaultProvider: "first",
    apiKeys: ["owner", "foreign"].map(id => ({ id, name: id, key: `synthetic-caller-${id}`, createdAt: "2026-01-01" })),
    providers: { first: row("first"), second: row("second") },
    combos: { pair: { strategy: "failover", targets: [
      { provider: "first", model: MODEL }, ...(failover ? [{ provider: "second", model: MODEL }] : []),
    ] } },
  };
  const outbound: Array<{ provider: string; body: Rec }> = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    expect(["first.example.test", "second.example.test"]).toContain(url.hostname);
    const provider = url.hostname.split(".")[0]!;
    const headers = new Headers(init?.headers);
    expect(headers.get("authorization")).toBe(`Bearer synthetic-provider-${provider}`);
    expect(headers.get("authorization")).not.toContain("synthetic-caller");
    const body = JSON.parse(String(init?.body)) as Rec;
    outbound.push({ provider, body });
    if (failover && provider === "first") {
      return Response.json({ error: { code: "model_not_found", message: "synthetic missing model" } }, { status: 404 });
    }
    const continuation = body.messages.some((message: Rec) => message.role === "tool");
    return Response.json({ id: `chatcmpl-${outbound.length}`, object: "chat.completion", model: MODEL,
      choices: [{ index: 0, message: continuation ? { role: "assistant", content: "continued" }
        : { role: "assistant", content: null, reasoning_content: PRIVATE, tool_calls: [
          { id: CALL, type: "function", function: { name: "inspect", arguments: "{}" } },
        ] }, finish_reason: continuation ? "stop" : "tool_calls" }],
      usage: { prompt_tokens: 2, completion_tokens: 2, total_tokens: 4 },
    });
  }) as typeof fetch;
  let ownerPrincipal: string | undefined;
  const post = async (caller: "owner" | "foreign" | undefined, seed = false) => {
    // Exercise the first candidate and the actual failover each time, without a previous lane pin/cooldown.
    clearRouteState();
    const before = outbound.length;
    const req = new Request("http://localhost/v1/responses", { method: "POST", headers: {
      "content-type": "application/json", "thread-id": THREAD,
      ...(caller ? { authorization: `Bearer synthetic-caller-${caller}` } : {}),
      ...(caller !== "owner" && ownerPrincipal ? { "x-opencodex-client-principal-id": ownerPrincipal } : {}),
    }, body: JSON.stringify({ model: "combo/pair", stream: false, store: false,
      tools: [{ type: "function", name: "inspect", parameters: { type: "object", properties: {} } }],
      input: seed ? "inspect the fixture" : [
        { type: "message", role: "user", content: [{ type: "input_text", text: "inspect the fixture" }] },
        { type: "function_call", call_id: CALL, name: "inspect", arguments: "{}" },
        { type: "function_call_output", call_id: CALL, output: "done" },
        { type: "message", role: "user", content: [{ type: "input_text", text: "continue" }] },
      ],
      ...(caller !== "owner" ? { replayPrincipal: { clientPrincipalId: ownerPrincipal },
        _reasoningReplayScope: { clientThreadId: THREAD, clientPrincipalId: ownerPrincipal } } : {}),
    }) });
    const admission = resolveResponsesApiAuth(req, { hostname: "127.0.0.1", apiKeys: config.apiKeys });
    expect(admission).toEqual({ kind: "loopback", source: "loopback" });
    const principal = resolveContextPrincipal(req, config, admission!);
    if (seed) { expect(principal).toBeDefined(); ownerPrincipal = principal; }
    else if (caller === "owner") expect(principal).toBe(ownerPrincipal);
    else expect(principal).not.toBe(ownerPrincipal);
    const log: RequestLogContext = { model: "", provider: "" };
    const completed: string[] = [];
    const response = await handleResponses(req, config, log, { admission: admission!, onResponseComplete: model => completed.push(model) });
    expect(response.status).toBe(200);
    await response.text();
    const sends = outbound.slice(before);
    expect(sends.map(send => send.provider)).toEqual(failover ? ["first", "second"] : ["first"]);
    expect(log.provider).toBe("combo");
    expect(log.attempts).toHaveLength(sends.length);
    expect(log.attempts?.map(attempt => attempt.sendCount)).toEqual(sends.map(() => 1));
    expect(completed).toEqual([MODEL]);
    return sends.find(send => send.provider === target)!.body.messages.find((message: Rec) => message.role === "assistant" && message.tool_calls)?.reasoning_content;
  };
  await post("owner", true);
  const same = await post("owner");
  const foreign = await post("foreign");
  const keyless = await post(undefined);
  expect(foreign).toBe(" ");
  expect(keyless).toBe(" ");
  expect(same).toBe(PRIVATE);
}, 20_000);
