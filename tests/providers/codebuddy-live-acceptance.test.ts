import { describe, expect, test } from "bun:test";
import {
  abortable,
  AcceptanceFailure,
  argumentsMatch,
  assertLiveOptIn,
  assertLoopbackListener,
  liveAcceptanceApiKey,
  liveAcceptanceCliPath,
  liveAcceptanceModel,
  liveAcceptanceRegion,
  readResponseStream,
  runAcceptanceScenario,
  syntheticAcceptanceResult,
} from "../../scripts/codebuddy-live-acceptance";

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    if (error instanceof AcceptanceFailure) return error.code;
    throw error;
  }
  return "no_failure";
}

async function rejectedCode(work: Promise<unknown>): Promise<string> {
  try {
    await work;
  } catch (error) {
    if (error instanceof AcceptanceFailure) return error.code;
    throw error;
  }
  return "no_failure";
}

function frame(type: string, payload: unknown): string {
  // Real Responses SSE carries the event type inside the data payload as well;
  // the parser cross-checks the event line against data.type.
  const body = payload && typeof payload === "object" && !Array.isArray(payload)
    ? { type, ...(payload as Record<string, unknown>) }
    : payload;
  return "event: " + type + "\ndata: " + JSON.stringify(body) + "\n\n";
}

function sse(frames: string): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(frames));
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "content-type": "text/event-stream; charset=utf-8" },
  });
}

function toolTurn(id: string, callId: string, name: string, args: Record<string, unknown>): string {
  const serialized = JSON.stringify(args);
  const midpoint = Math.max(1, Math.floor(serialized.length / 2));
  return [
    frame("response.function_call_arguments.delta", { item_id: id, delta: serialized.slice(0, midpoint) }),
    frame("response.function_call_arguments.delta", { item_id: id, delta: serialized.slice(midpoint) }),
    frame("response.function_call_arguments.done", { item_id: id, arguments: serialized }),
    frame("response.completed", {
      response: {
        id: "resp_for_" + callId,
        status: "completed",
        model: "kimi-k2.5",
        usage: { input_tokens: 20, output_tokens: 7, total_tokens: 27 },
        output: [{ type: "function_call", id, call_id: callId, name, arguments: serialized }],
      },
    }),
    "data: [DONE]\n\n",
  ].join("");
}

function textTurn(id: string, text: string): string {
  const midpoint = Math.max(1, Math.floor(text.length / 2));
  return [
    frame("response.output_text.delta", { item_id: id, content_index: 0, delta: text.slice(0, midpoint) }),
    frame("response.output_text.delta", { item_id: id, content_index: 0, delta: text.slice(midpoint) }),
    frame("response.output_text.done", { item_id: id, content_index: 0, text }),
    frame("response.completed", {
      response: {
        id: "resp_for_text",
        status: "completed",
        model: "kimi-k2.5",
        output: [{ type: "message", id, content: [{ type: "output_text", text }] }],
      },
    }),
    "data: [DONE]\n\n",
  ].join("");
}

interface ScenarioRequest { body: Record<string, unknown>; turnId: string | null }

function scenarioFetch(options: { omitUsage?: boolean; usageInputOnly?: boolean; omitDone?: boolean } = {}): {
  fetch: (input: URL, init: RequestInit) => Promise<Response>;
  requests: ScenarioRequest[];
} {
  const requests: ScenarioRequest[] = [];
  const fetch = async (_input: URL, init: RequestInit): Promise<Response> => {
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    const metadata = new Headers(init.headers).get("x-codex-turn-metadata");
    requests.push({ body, turnId: metadata });
    if (!body.previous_response_id) {
      const raw = toolTurn("fc_lookup", "call_lookup", "lookup_inventory", { sku: "TEST-123" });
      if (options.omitUsage) return sse(raw.replace(/"usage":\{[^}]*\},/, ""));
      if (options.usageInputOnly) {
        return sse(raw.replace(/"usage":\{[^}]*\},/, '"usage":{"input_tokens":20,"output_tokens":0,"total_tokens":20},'));
      }
      return sse(raw);
    }
    if (body.previous_response_id === "resp_for_call_lookup") {
      return sse(toolTurn("fc_reserve", "call_reserve", "reserve_inventory", { sku: "TEST-123", quantity: 2 }));
    }
    const finalTurn = textTurn("msg_final", "R-42"); return sse(options.omitDone ? finalTurn.replace("data: [DONE]\n\n", "") : finalTurn);
  };
  return { fetch, requests };
}

describe("CodeBuddy live acceptance harness", () => {
  test("accepts exact selectors without allowing provider prefixes or CLI arguments", () => {
    expect(liveAcceptanceModel({})).toBe("kimi-k2.5");
    expect(liveAcceptanceModel({ CODEBUDDY_LIVE_MODEL: "kimi-k3" })).toBe("kimi-k3");
    for (const model of ["", "codebuddy/kimi-k3", "--model", "kimi-k3 extra", "x".repeat(65)]) {
      expect(codeOf(() => liveAcceptanceModel({ CODEBUDDY_LIVE_MODEL: model }))).toBe("invalid_model_selector");
    }
  });

  test("region and key gates admit only the two presets and a present key", () => {
    expect(liveAcceptanceRegion({})).toBe("global");
    expect(liveAcceptanceRegion({ CODEBUDDY_LIVE_REGION: "cn" })).toBe("cn");
    for (const region of ["", "global-cn", "internal", "GLOBAL"]) {
      expect(codeOf(() => liveAcceptanceRegion({ CODEBUDDY_LIVE_REGION: region }))).toBe("invalid_region");
    }
    expect(codeOf(() => liveAcceptanceApiKey({}))).toBe("explicit_api_key_required");
    expect(codeOf(() => liveAcceptanceApiKey({ CODEBUDDY_LIVE_API_KEY: "   " }))).toBe("explicit_api_key_required");
    expect(liveAcceptanceApiKey({ CODEBUDDY_LIVE_API_KEY: " ck_key " })).toBe("ck_key");
  });

  test("validates the selected model on the returned completion", async () => {
    const frames = textTurn("msg_probe", "OK").replaceAll("kimi-k2.5", "kimi-k3");
    const result = await readResponseStream(sse(frames), new AbortController().signal, "kimi-k3");
    expect(result.response.model).toBe("kimi-k3");
    expect(await rejectedCode(readResponseStream(sse(frames), new AbortController().signal)))
      .toBe("invalid_completed_response");
  });

  test("requires an explicit opt-in, an absolute CLI path, and a key outside the test preload", () => {
    const optedIn = {
      CODEBUDDY_LIVE_TEST: "1",
      CODEBUDDY_LIVE_CLI_PATH: "/opt/codebuddy/bin",
      CODEBUDDY_LIVE_API_KEY: "ck_key",
    };
    expect(codeOf(() => assertLiveOptIn({}))).toBe("explicit_opt_in_required");
    expect(codeOf(() => assertLiveOptIn({ CODEBUDDY_LIVE_TEST: "1", OCX_TEST_PRELOAD_PID: "1" })))
      .toBe("test_preload_not_supported");
    expect(codeOf(() => assertLiveOptIn({ CODEBUDDY_LIVE_TEST: "1", BUN_TEST_WORKER_ID: "0" })))
      .toBe("test_preload_not_supported");
    expect(codeOf(() => assertLiveOptIn({ ...optedIn, CODEBUDDY_LIVE_CLI_PATH: "relative/codebuddy" })))
      .toBe("cli_path_must_be_absolute");
    expect(codeOf(() => assertLiveOptIn({ CODEBUDDY_LIVE_TEST: "1", CODEBUDDY_LIVE_API_KEY: "ck_key" })))
      .toBe("explicit_cli_path_required");
    expect(codeOf(() => assertLiveOptIn({
      CODEBUDDY_LIVE_TEST: "1", CODEBUDDY_LIVE_CLI_PATH: "/opt/codebuddy/bin",
    }))).toBe("explicit_api_key_required");
    expect(codeOf(() => assertLiveOptIn({ ...optedIn, CODEBUDDY_LIVE_REGION: "internal" }))).toBe("invalid_region");
    expect(codeOf(() => assertLiveOptIn(optedIn))).toBe("no_failure");
    expect(codeOf(() => liveAcceptanceCliPath({ CODEBUDDY_LIVE_CLI_PATH: "   " })))
      .toBe("explicit_cli_path_required");
    expect(liveAcceptanceCliPath({ CODEBUDDY_LIVE_CLI_PATH: " /opt/codebuddy/bin " })).toBe("/opt/codebuddy/bin");
  });

  test("labels synthetic success without claiming native-client acceptance", () => {
    expect(syntheticAcceptanceResult(true)).toEqual({ passed: true,
      code: "synthetic_three_turn_streaming_passed", scope: "synthetic-adapter", codexClientExecuted: false });
    expect(syntheticAcceptanceResult(false, new Error("private response"))).toEqual({ passed: false,
      code: "acceptance_failed", scope: "synthetic-adapter", codexClientExecuted: false });
    expect(syntheticAcceptanceResult(false, undefined).passed).toBe(false);
  });

  test("admits only a positive ephemeral loopback listener", () => {
    const at = (port: number, hostname = "127.0.0.1") => () => assertLoopbackListener({
      port,
      hostname,
      url: new URL("http://" + hostname + ":" + port),
    });
    expect(codeOf(at(10100))).toBe("unsafe_listener_port");
    expect(codeOf(at(0))).toBe("unsafe_listener_port");
    expect(codeOf(at(43210, "0.0.0.0"))).toBe("unsafe_listener_address");
    expect(codeOf(at(43210, "example.internal"))).toBe("unsafe_listener_address");
    expect(codeOf(at(43210))).toBe("no_failure");
    expect(codeOf(() => assertLoopbackListener({
      port: 43210,
      hostname: "127.0.0.1",
      url: new URL("http://user:pass@127.0.0.1:43210"),
    }))).toBe("unsafe_listener_address");
  });

  test("abortable rejects before an aborted operation settles", async () => {
    const controller = new AbortController();
    controller.abort();
    expect(await rejectedCode(abortable(new Promise(() => {}), controller.signal)))
      .toBe("acceptance_aborted");
  });

  test("matches tool arguments exactly by key set and value", () => {
    expect(argumentsMatch("{\"sku\":\"TEST-123\"}", { sku: "TEST-123" })).toBe(true);
    expect(argumentsMatch("{\"sku\":\"TEST-124\"}", { sku: "TEST-123" })).toBe(false);
    expect(argumentsMatch("{\"sku\":\"TEST-123\",\"extra\":1}", { sku: "TEST-123" })).toBe(false);
    expect(argumentsMatch("not json", { sku: "TEST-123" })).toBe(false);
    expect(argumentsMatch({ sku: "TEST-123" }, { sku: "TEST-123" })).toBe(false);
  });

  test("rejects torn, failed, and completion-less streams", async () => {
    const signal = new AbortController().signal;
    expect(await rejectedCode(readResponseStream(
      sse(frame("response.completed", { response: { id: "x", status: "completed", model: "kimi-k2.5", output: [] } }).slice(0, 10)),
      signal,
    ))).toBe("truncated_sse_frame");
    expect(await rejectedCode(readResponseStream(
      sse(frame("error", { message: "boom" })),
      signal,
    ))).toBe("response_failed");
    expect(await rejectedCode(readResponseStream(
      sse(frame("response.output_text.delta", { item_id: "m", content_index: 0, delta: "hi" }) + "data: [DONE]\n\n"),
      signal,
    ))).toBe("premature_or_duplicate_done");
    expect(await rejectedCode(readResponseStream(
      new Response("ok", { status: 500, headers: { "content-type": "text/event-stream" } }),
      signal,
    ))).toBe("unexpected_http_status");
  });

  test("runs the three-turn scenario with one shared turn id and chained state", async () => {
    const { fetch, requests } = scenarioFetch();

    await runAcceptanceScenario(
      new URL("http://127.0.0.1:43210"),
      new AbortController().signal,
      fetch,
    );

    expect(requests).toHaveLength(3);
    // The real Codex client reuses one stable user turn_id across every
    // Responses request in a turn and sends parallel_tool_calls as permission.
    expect(requests[0]!.turnId).toBeTruthy();
    expect(new Set(requests.map(request => request.turnId)).size).toBe(1);
    expect(JSON.parse(requests[0]!.turnId!)).toMatchObject({ turn_id: expect.any(String) });
    for (const request of requests) {
      expect(request.body.model).toBe("codebuddy/kimi-k2.5");
      expect(request.body.stream).toBe(true);
      expect(request.body.parallel_tool_calls).toBe(true);
    }
    expect(requests[1]!.body.previous_response_id).toBe("resp_for_call_lookup");
    expect(requests[1]!.body.input).toMatchObject([
      { type: "function_call_output", call_id: "call_lookup" },
      { type: "message", role: "user" },
    ]);
    expect(requests[2]!.body.previous_response_id).toBe("resp_for_call_reserve");
    expect(requests[2]!.body.input).toMatchObject([
      { type: "function_call_output", call_id: "call_reserve" },
      { type: "message", role: "user" },
    ]);
  });

  test("routes the scenario through the selected region's provider prefix", async () => {
    const { fetch, requests } = scenarioFetch();
    await runAcceptanceScenario(new URL("http://127.0.0.1:43210"), new AbortController().signal, fetch, "kimi-k2.5", "codebuddy-cn");
    for (const request of requests) expect(request.body.model).toBe("codebuddy-cn/kimi-k2.5");
  });

  test("a tool leg without reported usage fails the scenario", async () => {
    const { fetch } = scenarioFetch({ omitUsage: true });
    expect(await rejectedCode(runAcceptanceScenario(
      new URL("http://127.0.0.1:43210"),
      new AbortController().signal,
      fetch,
    ))).toBe("usage_missing");
  });

  test("a tool leg with zero output tokens fails the scenario", async () => {
    // The single-field check this replaced accepted a report where the tool leg's output usage
    // was lost; both directions of the partial-usage fold must be positive.
    const { fetch } = scenarioFetch({ usageInputOnly: true });
    expect(await rejectedCode(runAcceptanceScenario(
      new URL("http://127.0.0.1:43210"),
      new AbortController().signal,
      fetch,
    ))).toBe("usage_zero");
  });

  test("a stream ending after completion without [DONE] fails acceptance", async () => {
    const { fetch } = scenarioFetch({ omitDone: true });
    expect(await rejectedCode(runAcceptanceScenario(
      new URL("http://127.0.0.1:43210"),
      new AbortController().signal,
      fetch,
    ))).toBe("missing_done");
  });

  test("a mention of the expected marker is not a semantic pass", async () => {
    let count = 0;
    const mockFetch = async () => {
      count++;
      if (count === 1) return sse(toolTurn("fc_lookup", "call_lookup", "lookup_inventory", { sku: "TEST-123" }));
      if (count === 2) return sse(toolTurn("fc_reserve", "call_reserve", "reserve_inventory", { sku: "TEST-123", quantity: 2 }));
      return sse(textTurn("msg_final", "R-42 is not available."));
    };
    expect(await rejectedCode(runAcceptanceScenario(new URL("http://127.0.0.1:43210"),
      new AbortController().signal, mockFetch))).toBe("final_result_mismatch");
  });
});
