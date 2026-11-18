import { afterEach, beforeEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { saveConfig } from "../../src/config";
import { clearComboSelectionState, clearComboTargetCooldowns } from "../../src/combos";
import { resetSharedSpendLedgerForTest, sharedSpendLedger } from "../../src/lib/spend-reservation-ledger";
import { startServer } from "../../src/server";
import { clearRequestLogsForTests, getRequestLogEntries } from "../../src/server/request-log";
import { ESTIMATED_USAGE_HEADER } from "../../src/server/responses/estimated-usage";
import { setRelayPlatformForTests } from "../../src/server/responses/passthrough-delivery";
import type { OcxConfig } from "../../src/types";
import { ownedServiceHomeInspection } from "../helpers/owned-service-home-inspection";
import { createTempHome, type TempHome } from "../helpers/temp-home";

// Use the real HTTP finalizer and durable ledger: a display-only estimate must not release
// an unknown send's reservation and make a second physical send affordable.
let home: TempHome;
let proxy: ReturnType<typeof startServer> | undefined;
let upstream: ReturnType<typeof Bun.serve> | undefined;
let releaseTerminal: (() => void) | undefined;
beforeEach(() => {
  home = createTempHome("ocx-combo-estimated-spend-");
  clearComboSelectionState(); clearComboTargetCooldowns(); clearRequestLogsForTests();
  resetSharedSpendLedgerForTest();
});
afterEach(async () => {
  releaseTerminal?.(); releaseTerminal = undefined;
  try { await proxy?.stop(true); }
  finally {
    proxy = undefined;
    try { await upstream?.stop(true); }
    finally {
      upstream = undefined; setRelayPlatformForTests(undefined);
      clearComboSelectionState(); clearComboTargetCooldowns();
      resetSharedSpendLedgerForTest(); home.remove();
    }
  }
});

type Scenario = {
  mode?: "legacy-tee" | "eager-relay";
  combo?: boolean;
  stream?: boolean;
  estimate?: boolean;
  terminal?: "completed" | "incomplete";
  nullUsage?: boolean;
  fragmented?: boolean;
  earlyOutput?: boolean;
  reportedUsage?: boolean;
  earlyUsage?: boolean;
};
const providerUsage = { input_tokens: 900, output_tokens: 100, total_tokens: 1000 };
const key = "ocx_data_estimated_usage_fixture";

async function until(done: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!done()) {
    if (Date.now() >= deadline) throw new Error("Estimated usage fixture did not finalize");
    await Bun.sleep(1);
  }
}

async function exercise(scenario: Scenario = {}) {
  const { mode = "legacy-tee", combo = true, stream = true, estimate = true,
    terminal = "completed", nullUsage = false, fragmented = false,
    earlyOutput = false, reportedUsage = false, earlyUsage = false } = scenario;
  setRelayPlatformForTests(mode === "eager-relay" ? "darwin" : "linux");
  let sends = 0;
  const terminalReady = new Promise<void>(resolve => { releaseTerminal = resolve; });
  const output = [{ id: "msg_estimate", type: "message", role: "assistant", status: "completed",
    content: [{ type: "output_text", text: "OK", annotations: [] }] }];
  const responseBody = { id: "resp_estimate", object: "response", model: "probe", status: terminal,
    output, ...(terminal === "incomplete" ? { incomplete_details: { reason: "max_output_tokens" } } : {}),
    ...(reportedUsage ? { usage: providerUsage } : nullUsage ? { usage: null } : {}) };
  upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(req) {
    expect(new URL(req.url).pathname).toBe("/v1/responses");
    expect(req.headers.get("authorization")).toBe("Bearer synthetic-provider-key");
    sends++;
    if (!stream) return Response.json(responseBody);
    const events = [
      ...(earlyUsage ? [{ type: "response.in_progress",
        response: { ...responseBody, status: "in_progress", output: [], usage: providerUsage } }] : []),
      ...(earlyOutput ? [{ type: "response.output_text.delta", item_id: "msg_estimate",
        output_index: 0, content_index: 0, delta: "OK" }] : []),
      { type: `response.${terminal}`, response: responseBody },
    ];
    const frames = events.map(event => `event: ${event.type}\r\ndata: ${JSON.stringify(event)}\r\n\r\n`);
    const bytes = new TextEncoder().encode(frames.join(""));
    const terminalOffset = new TextEncoder().encode(frames.slice(0, -1).join("")).byteLength;
    let offset = 0;
    const body = new ReadableStream<Uint8Array>({ async pull(controller) {
      if (offset === bytes.length) { controller.close(); return; }
      // A real read barrier proves the parent commits before terminal metadata arrives.
      if (earlyOutput && offset >= terminalOffset) await terminalReady;
      const bound = earlyOutput && offset < terminalOffset ? terminalOffset : bytes.length;
      const end = fragmented ? Math.min(offset + 7, bound) : bound;
      controller.enqueue(bytes.subarray(offset, end)); offset = end;
    } });
    return new Response(body, { headers: { "content-type": "text/event-stream" } });
  } });
  saveConfig({ port: 0, hostname: "0.0.0.0", defaultProvider: "fixture", streamMode: mode,
    clientIntegrations: { codex: false },
    apiKeys: [{ id: "estimate-fixture", name: "estimate fixture", key, createdAt: "2026-11-18" }],
    spend: { pool: { maxTokens: 1500 } },
    providers: { fixture: { adapter: "openai-responses", authMode: "key", apiKey: "synthetic-provider-key",
      baseUrl: `http://127.0.0.1:${upstream.port}/v1`, allowPrivateNetwork: true, proxy: "direct",
      models: ["probe"], estimateMissingUsage: estimate, upstreamWebsocket: false } },
    combos: { estimate: { alias: "chain/estimate", strategy: "failover", waitForCooldownMs: 0,
      targets: [{ provider: "fixture", model: "probe" }] } },
  } as OcxConfig);
  proxy = startServer(0, { inspectNativeCodexOwnership: ownedServiceHomeInspection("estimated usage HTTP fixture") });
  const send = () => fetch(`http://127.0.0.1:${proxy!.port}/v1/responses`, {
    method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify({ model: combo ? "chain/estimate" : "fixture/probe",
      input: "hello", max_output_tokens: 1000, stream, store: false }),
  });
  const first = await send();
  releaseTerminal?.();
  const text = await first.text();
  expect(first.status).toBe(200);
  await until(() => getRequestLogEntries().length === 1);
  const row = getRequestLogEntries()[0]!;
  expect(row.admissionKind).toBe("configured");
  const delivered = stream
    ? JSON.parse(text.split(/\r?\n/).find(line => line.startsWith("data:")
      && line.includes(`"type":"response.${terminal}"`))!.slice(5)).response
    : JSON.parse(text);
  if (reportedUsage) expect(delivered.usage).toEqual(providerUsage);
  else if (estimate) {
    expect(delivered.usage.input_tokens).toBeGreaterThan(0);
    expect(delivered.usage.output_tokens).toBeGreaterThan(0);
    expect(delivered.usage.total_tokens).toBeLessThan(1000);
  } else expect(delivered.usage).toBeUndefined();
  expect(first.headers.get(ESTIMATED_USAGE_HEADER)).toBe(estimate ? stream ? "when-missing" : "true" : null);

  const snapshot = sharedSpendLedger().snapshot("pool", "fixture")!;
  const records = readFileSync(home.path("spend-ledger.jsonl"), "utf8").trim().split("\n")
    .map(line => JSON.parse(line) as { kind: string; tokens?: number });
  const second = await send();
  const secondBody = await second.text();
  // This is the security outcome: the ceiling still blocks a second upstream dispatch.
  expect(second.status).toBe(429);
  expect(JSON.parse(secondBody).error.code).toBe("request_send_budget_exhausted");
  expect(sends).toBe(1);
  expect(snapshot.reserved).toBe(0);
  if (reportedUsage || earlyUsage) {
    expect(row.usage).toMatchObject({ inputTokens: 900, outputTokens: 100 });
    expect(snapshot.settled).toBe(1000);
    expect(snapshot.unresolved).toBe(0);
    expect(records.filter(record => record.kind === "settle")).toHaveLength(1);
    expect(records.find(record => record.kind === "settle")?.tokens).toBe(1000);
  } else {
    expect(row.usage).toBeUndefined();
    expect(snapshot.settled).toBe(0);
    expect(snapshot.unresolved).toBeGreaterThanOrEqual(1000);
    expect(records.some(record => record.kind === "settle")).toBe(false);
    expect(records.filter(record => record.kind === "lost")).toHaveLength(1);
  }
}

for (const mode of ["legacy-tee", "eager-relay"] as const) {
  test(`${mode}: Combo terminal-only display estimate cannot release spend`, () => exercise({ mode }), 15_000);
  test(`${mode}: fragmented incomplete/null usage remains unknown spend`, () =>
    exercise({ mode, terminal: "incomplete", nullUsage: true, fragmented: true }), 15_000);
  test(`${mode}: estimated usage after output commitment remains unknown spend`, () =>
    exercise({ mode, earlyOutput: true, fragmented: true }), 15_000);
  test(`${mode}: Combo provider usage remains authoritative despite when-missing header`, () =>
    exercise({ mode, reportedUsage: true }), 15_000);
  test(`${mode}: provider usage arriving after output commitment still settles`, () =>
    exercise({ mode, reportedUsage: true, earlyOutput: true }), 15_000);
  test(`${mode}: an estimated terminal preserves earlier provider usage`, () =>
    exercise({ mode, earlyUsage: true }), 15_000);
}
test("direct SSE keeps missing usage unresolved", () => exercise({ combo: false }), 15_000);
test("Combo JSON keeps estimated usage out of settlement", () => exercise({ stream: false }), 15_000);
test("Combo SSE with estimation disabled keeps missing usage unresolved", () => exercise({ estimate: false }), 15_000);
