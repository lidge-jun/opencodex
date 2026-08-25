import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOpenAIChatAdapter as createOpenAIChatAdapterProduction } from "../src/adapters/openai-chat";
import { saveConfig } from "../src/config";
import {
  MAX_ACTIVE_SESSION_LANES,
  SESSION_LANE_ID_BYTES,
  resetLifecycleDrainStateForTests,
  sessionLaneMetrics,
  tryAdmitTurn,
  type ActiveTurnLease,
} from "../src/server/lifecycle";
import { sessionLaneIdFromRequest } from "../src/server/request-log-conversation";
import { startServer } from "../src/server";
import type { AdapterEvent, OcxConfig } from "../src/types";
import { withTestTranslatorBudget } from "./helpers/translator-budget";

const provider = { adapter: "openai-chat", baseUrl: "https://example.test/v1", apiKey: "key" };

interface ProtocolCall {
  id: string;
  name: string;
  arguments: string;
}

function chatSse(session: number, round: number, callCount: number): string {
  const frames: string[] = [];
  for (let index = 0; index < callCount; index += 1) {
    frames.push(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{
      index,
      id: `call_s${session}_r${round}_t${index}`,
      function: { name: `mcp__lane_${session}__tool_${index}`, arguments: `{"session":${session},` },
    }] } }] })}\n\n`);
  }
  for (let index = callCount - 1; index >= 0; index -= 1) {
    frames.push(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{
      index,
      function: { arguments: `"round":${round},"tool":${index}}` },
    }] } }] })}\n\n`);
  }
  frames.push(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [] }, finish_reason: "tool_calls" }] })}\n\n`);
  frames.push("data: [DONE]\n\n");
  return frames.join("");
}

async function parseCalls(session: number, round: number): Promise<ProtocolCall[]> {
  const callCount = (session % 8) + 1;
  const adapter = withTestTranslatorBudget(createOpenAIChatAdapterProduction(provider));
  const events: AdapterEvent[] = [];
  for await (const event of adapter.parseStream(new Response(chatSse(session, round, callCount)))) {
    events.push(event);
  }
  const calls: ProtocolCall[] = [];
  let current: ProtocolCall | undefined;
  for (const event of events) {
    if (event.type === "tool_call_start") {
      expect(current).toBeUndefined();
      current = { id: event.id, name: event.name, arguments: "" };
    } else if (event.type === "tool_call_delta") {
      expect(current).toBeDefined();
      current!.arguments += event.arguments;
    } else if (event.type === "tool_call_end") {
      expect(current).toBeDefined();
      calls.push(current!);
      current = undefined;
    }
  }
  expect(current).toBeUndefined();
  expect(events.at(-1)?.type).toBe("done");
  expect(calls).toHaveLength(callCount);
  for (let index = 0; index < calls.length; index += 1) {
    expect(calls[index]).toEqual({
      id: `call_s${session}_r${round}_t${index}`,
      name: `mcp__lane_${session}__tool_${index}`,
      arguments: `{"session":${session},"round":${round},"tool":${index}}`,
    });
    expect(JSON.parse(calls[index].arguments)).toEqual({ session, round, tool: index });
  }
  return calls;
}

function memorySnapshot() {
  const memory = process.memoryUsage();
  return {
    rss: memory.rss,
    heapUsed: memory.heapUsed,
    external: memory.external,
    arrayBuffers: memory.arrayBuffers,
  };
}

async function runRecallWave(sessionCount: 32 | 64) {
  resetLifecycleDrainStateForTests();
  const before = memorySnapshot();
  const leases: ActiveTurnLease[] = [];
  for (let session = 0; session < sessionCount; session += 1) {
    const lease = tryAdmitTurn(`logical-session-${session}`);
    expect(lease).not.toBeNull();
    leases.push(lease!);
  }
  expect(sessionLaneMetrics()).toMatchObject({
    active: sessionCount,
    peak: sessionCount,
    retainedBytes: sessionCount * SESSION_LANE_ID_BYTES,
  });
  expect(tryAdmitTurn("logical-session-0")).toBeNull();

  const firstCalls = await Promise.all(Array.from({ length: sessionCount }, (_, session) => parseCalls(session, 1)));
  for (const lease of leases) lease.release();
  expect(sessionLaneMetrics().active).toBe(0);
  expect(sessionLaneMetrics().retainedBytes).toBe(0);

  const recallLeases = Array.from({ length: sessionCount }, (_, session) => {
    const lease = tryAdmitTurn(`logical-session-${session}`);
    expect(lease).not.toBeNull();
    return lease!;
  });
  const secondCalls = await Promise.all(Array.from({ length: sessionCount }, (_, session) => parseCalls(session, 2)));
  for (const lease of recallLeases) lease.release();
  expect(sessionLaneMetrics().active).toBe(0);
  expect(sessionLaneMetrics().retainedBytes).toBe(0);
  for (let session = 0; session < sessionCount; session += 1) {
    expect(new Set([...firstCalls[session], ...secondCalls[session]].map(call => call.id)).size)
      .toBe(firstCalls[session].length + secondCalls[session].length);
  }
  const after = memorySnapshot();
  const measured = {
    sessions: sessionCount,
    lanePeakBytes: sessionCount * SESSION_LANE_ID_BYTES,
    rssDelta: after.rss - before.rss,
    heapUsedDelta: after.heapUsed - before.heapUsed,
    externalDelta: after.external - before.external,
    arrayBuffersDelta: after.arrayBuffers - before.arrayBuffers,
  };
  console.log(`[session-lane-harness] ${JSON.stringify(measured)}`);
  return measured;
}

describe("#820 concurrent tool-recall session harness", () => {
  test("the HTTP boundary rejects an overlapping recall on the same logical session", async () => {
    resetLifecycleDrainStateForTests();
    const previousHome = process.env.OPENCODEX_HOME;
    const home = mkdtempSync(join(tmpdir(), "ocx-session-lane-"));
    process.env.OPENCODEX_HOME = home;
    saveConfig({
      port: 0,
      hostname: "127.0.0.1",
      defaultProvider: "openai",
      providers: {
        openai: { adapter: "openai-responses", baseUrl: "https://api.openai.com/v1", authMode: "forward" },
      },
    } as OcxConfig);
    const headers = new Headers({ "content-type": "application/json", session_id: "recall-session" });
    const held = tryAdmitTurn(sessionLaneIdFromRequest(headers));
    const server = startServer(0);
    try {
      expect(held).not.toBeNull();
      const overlapping = await fetch(new URL("/v1/responses", server.url), {
        method: "POST",
        headers,
        body: "not-json",
      });
      expect(overlapping.status).toBe(503);
      expect(await overlapping.json()).toMatchObject({ error: { code: "server_busy" } });
      held?.release();
      const afterRelease = await fetch(new URL("/v1/responses", server.url), {
        method: "POST",
        headers,
        body: "not-json",
      });
      expect(afterRelease.status).toBe(400);
    } finally {
      held?.release();
      await server.stop(true);
      if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
      else process.env.OPENCODEX_HOME = previousHome;
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("32 sustained independent sessions preserve protocol isolation within the lane envelope", async () => {
    const measured = await runRecallWave(32);
    expect(measured.lanePeakBytes).toBe(1024);
  });

  test("64 burst independent sessions preserve protocol isolation at the lane cap", async () => {
    const measured = await runRecallWave(64);
    expect(MAX_ACTIVE_SESSION_LANES).toBe(64);
    expect(measured.lanePeakBytes).toBe(2048);
  });

  test("the 65th identified lane is rejected without allocating lane memory", () => {
    resetLifecycleDrainStateForTests();
    const leases = Array.from({ length: 64 }, (_, index) => tryAdmitTurn(`capacity-${index}`));
    expect(leases.every(Boolean)).toBe(true);
    expect(tryAdmitTurn("capacity-overflow")).toBeNull();
    expect(sessionLaneMetrics()).toMatchObject({ active: 64, retainedBytes: 2048, rejected: 1 });
    for (const lease of leases) lease?.release();
    expect(sessionLaneMetrics().retainedBytes).toBe(0);
  });
});
