import { describe, expect, test } from "bun:test";
import { mkdtempSync} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOpenAIChatAdapter as createOpenAIChatAdapterProduction } from "../src/adapters/openai-chat";
import { saveConfig } from "../src/config";
import {
  MAX_ACTIVE_TURNS,
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
import { removeTreeWithRetry } from "./helpers/remove-tree";

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
    admitted: sessionCount,
    rejected: 0,
    retainedBytes: sessionCount * SESSION_LANE_ID_BYTES,
  });
  const overlappingLease = tryAdmitTurn("logical-session-0");
  expect(overlappingLease).not.toBeNull();
  expect(sessionLaneMetrics()).toMatchObject({
    active: sessionCount,
    admitted: sessionCount,
    rejected: 0,
    retainedBytes: sessionCount * SESSION_LANE_ID_BYTES,
  });
  overlappingLease?.release();

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
  test("the HTTP boundary admits a reconnect while the same logical session is settling", async () => {
    resetLifecycleDrainStateForTests();
    const previousHome = process.env.OPENCODEX_HOME;
    const originalFetch = globalThis.fetch;
    const home = mkdtempSync(join(tmpdir(), "ocx-session-lane-"));
    process.env.OPENCODEX_HOME = home;
    let markUpstreamStarted!: () => void;
    const upstreamStarted = new Promise<void>(resolve => { markUpstreamStarted = resolve; });
    let finishUpstream!: () => void;
    const upstreamResponse = new Promise<Response>(resolve => {
      finishUpstream = () => resolve(Response.json({
        id: "resp_reconnect",
        object: "response",
        status: "completed",
        model: "test-model",
        output: [],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      }));
    });
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url === "https://reconnect.example.test/v1/responses") {
        markUpstreamStarted();
        return upstreamResponse;
      }
      return originalFetch(input, init);
    }) as typeof fetch;
    saveConfig({
      port: 0,
      hostname: "127.0.0.1",
      defaultProvider: "reconnect",
      providers: {
        reconnect: {
          adapter: "openai-responses",
          baseUrl: "https://reconnect.example.test/v1",
          authMode: "key",
          apiKey: "test-key",
        },
      },
    } as OcxConfig);
    const headers = new Headers({ "content-type": "application/json", session_id: "recall-session" });
    const held = tryAdmitTurn(sessionLaneIdFromRequest(headers));
    const server = startServer(0);
    try {
      expect(held).not.toBeNull();
      const overlappingResponse = originalFetch(new URL("/v1/responses", server.url), {
        method: "POST",
        headers,
        body: JSON.stringify({ model: "reconnect/test-model", input: "hello", stream: false }),
      });
      await upstreamStarted;
      expect(sessionLaneMetrics()).toMatchObject({ active: 1, admitted: 1, rejected: 0 });
      held?.release();
      expect(sessionLaneMetrics()).toMatchObject({ active: 1, retainedBytes: SESSION_LANE_ID_BYTES });
      finishUpstream();
      const overlapping = await overlappingResponse;
      expect(overlapping.status).toBe(200);
      await overlapping.text();
      expect(sessionLaneMetrics()).toMatchObject({ active: 0, retainedBytes: 0 });

      const invalid = await originalFetch(new URL("/v1/responses", server.url), {
        method: "POST",
        headers,
        body: "not-json",
      });
      expect(invalid.status).toBe(400);
      expect(await invalid.json()).toMatchObject({
        error: { type: "invalid_request_error", message: "Invalid JSON body" },
      });
    } finally {
      finishUpstream();
      held?.release();
      await server.stop(true);
      globalThis.fetch = originalFetch;
      if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
      else process.env.OPENCODEX_HOME = previousHome;
      removeTreeWithRetry(home);
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

  test("same-lane reconnect leases retain one lane until the final release", () => {
    resetLifecycleDrainStateForTests();
    const first = tryAdmitTurn("reconnect-lane");
    const second = tryAdmitTurn("reconnect-lane");
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(sessionLaneMetrics()).toMatchObject({
      active: 1,
      peak: 1,
      admitted: 1,
      rejected: 0,
      retainedBytes: SESSION_LANE_ID_BYTES,
    });

    first?.release();
    expect(sessionLaneMetrics()).toMatchObject({ active: 1, retainedBytes: SESSION_LANE_ID_BYTES });
    second?.release();
    expect(sessionLaneMetrics()).toMatchObject({ active: 0, retainedBytes: 0 });

    const third = tryAdmitTurn("reconnect-lane");
    const fourth = tryAdmitTurn("reconnect-lane");
    expect(third).not.toBeNull();
    expect(fourth).not.toBeNull();
    fourth?.release();
    expect(sessionLaneMetrics()).toMatchObject({ active: 1, retainedBytes: SESSION_LANE_ID_BYTES });
    third?.release();
    expect(sessionLaneMetrics()).toMatchObject({ active: 0, retainedBytes: 0 });
  });

  test("same-lane reconnects remain bounded by the global active-turn cap", () => {
    resetLifecycleDrainStateForTests();
    const leases = Array.from({ length: MAX_ACTIVE_TURNS }, () => tryAdmitTurn("global-cap-lane"));
    expect(leases.every(Boolean)).toBe(true);
    expect(sessionLaneMetrics()).toMatchObject({ active: 1, admitted: 1, rejected: 0 });
    expect(tryAdmitTurn("global-cap-lane")).toBeNull();
    expect(sessionLaneMetrics()).toMatchObject({ active: 1, admitted: 1, rejected: 0 });
    for (const lease of leases) lease?.release();
    expect(sessionLaneMetrics()).toMatchObject({ active: 0, retainedBytes: 0 });
  });

  /**
   * The regression this lane derivation exists to avoid (#820).
   *
   * A parallel subagent fan-out is Codex's normal shape, and every child of one parent
   * carries the SAME `x-codex-parent-thread-id` — that is what `codexPoolAffinityKey`
   * deliberately keys on, so the whole fan-out pins to one account. A lane keyed the same
   * way inherits that coalescing and rejects every sibling after the first with 503.
   *
   * Keyed on the pair, the parent qualifies the lane instead of defining it: siblings
   * separate, while two overlapping turns of ONE conversation still share a lane, which is
   * the protocol rule this admission boundary is here to enforce.
   */
  test("parallel subagents of one parent take separate lanes, and one conversation still shares one", () => {
    resetLifecycleDrainStateForTests();
    const parent = "parent-thread-id";
    const spawn = (threadId: string) => new Headers({
      "x-codex-parent-thread-id": parent,
      "x-codex-turn-metadata": JSON.stringify({ subagent_kind: "thread_spawn" }),
      "thread-id": threadId,
    });

    const siblingLanes = ["child-a", "child-b", "child-c"].map(id => sessionLaneIdFromRequest(spawn(id)));
    expect(new Set(siblingLanes).size).toBe(3);
    const siblingLeases = siblingLanes.map(lane => tryAdmitTurn(lane));
    expect(siblingLeases.every(Boolean)).toBe(true);

    // Same parent AND same child thread still shares one fixed-size lane, while a reconnect
    // gets its own process-wide turn lease instead of a local 503.
    const overlappingSibling = tryAdmitTurn(sessionLaneIdFromRequest(spawn("child-a")));
    expect(overlappingSibling).not.toBeNull();
    expect(sessionLaneMetrics()).toMatchObject({ active: 3, admitted: 3, rejected: 0 });
    overlappingSibling?.release();

    for (const lease of siblingLeases) lease?.release();
    expect(sessionLaneMetrics().retainedBytes).toBe(0);
  });
});
