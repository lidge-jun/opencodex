import { afterEach, describe, expect, test } from "bun:test";
import {
  providerRequestPacingStatus, registerProviderResponseProvenance,
  resetProviderRequestPacingForTest, sendTrackingRequestSlot,
  trackProviderRequestSlotBody, waitForProviderRequestSlot,
} from "../../src/providers/request-pacing";
import {
  isNativeControlResponse, markNativeControlResponse,
} from "../../src/server/responses/native-response-control";
import {
  codexWsSocketDeathStage, isCodexWsPreludeProjection, isCodexWsQuotaObservedResponse,
  isCodexWsUpstreamResponse, markCodexWsPreludeProjection, markCodexWsResponse,
  markCodexWsSocketDeath, markCodexWsStage, readCodexWsStage, type CodexWsStageRecord,
} from "../../src/server/responses/codex-ws-wire";
import type { OcxProviderConfig } from "../../src/types";

afterEach(() => resetProviderRequestPacingForTest());

const provider: OcxProviderConfig = {
  adapter: "openai-responses", apiKey: "fixture-key", baseUrl: "https://example.test/v1",
  apiKeyPool: [{ id: "fixture", key: "fixture-key" }],
  requestPacing: { enabled: true, keySelection: "round-robin" },
};

function stage(): CodexWsStageRecord {
  return {
    requestBytes: 24, sent: true, upstreamFrames: 2, controlFrames: 1, relayedEvents: 1,
    firstFrameMs: 1, firstResponseMs: 2, elapsedMs: 3, pings: 0, pongs: 0,
    closeCode: null, reused: false, ocxVersion: "0.0.0", bunVersion: "fixture",
  };
}

function expectUnmarked(response: Response): void {
  expect(isNativeControlResponse(response)).toBe(false);
  expect(isCodexWsUpstreamResponse(response)).toBe(false);
  expect(isCodexWsQuotaObservedResponse(response)).toBe(false);
  expect(isCodexWsPreludeProjection(response)).toBe(false);
  expect(readCodexWsStage(response)).toBeUndefined();
  expect(codexWsSocketDeathStage(response)).toBeUndefined();
}

function countedSlot() {
  let releases = 0;
  return {
    slot: { leased: true, bodyTracked: false, released: false, release() { releases++; } },
    releases: () => releases,
  };
}

describe("pacing body transport provenance", () => {
  test("round-robin lease preserves native and WS markers and live stage identity", async () => {
    const slot = await waitForProviderRequestSlot("provenance", provider);
    expect(slot.leased).toBe(true); // Key accounting alone owns a lease, with no concurrency cap.
    expect(providerRequestPacingStatus("provenance", provider).keys?.[0]?.inFlight).toBe(1);
    const original = markNativeControlResponse(new Response("first response\nsecond response\n"));
    markCodexWsResponse(original, true);
    const record = stage();
    markCodexWsStage(original, record);
    const wrapped = trackProviderRequestSlotBody(slot, original);
    expect(wrapped).not.toBe(original);
    expect(slot.bodyTracked).toBe(true);
    expect(isNativeControlResponse(wrapped)).toBe(true);
    expect(isCodexWsUpstreamResponse(wrapped)).toBe(true);
    expect(isCodexWsQuotaObservedResponse(wrapped)).toBe(true);
    expect(isCodexWsPreludeProjection(wrapped)).toBe(false);
    expect(readCodexWsStage(wrapped)).toBe(record);
    markCodexWsStage(original, { ...record, upstreamFrames: 5, relayedEvents: 4 });
    expect(readCodexWsStage(wrapped)?.relayedEvents).toBe(4);
    expect(slot.released).toBe(false);
    expect(await wrapped.text()).toBe("first response\nsecond response\n");
    expect(slot.released).toBe(true);
    expect(providerRequestPacingStatus("provenance", provider).keys?.[0]?.inFlight).toBe(0);
  });

  test.each([0, 1])("preserves prelude, stage and socket-death metadata (%i control frames)", async controlFrames => {
    const slot = await waitForProviderRequestSlot("prelude", provider);
    const original = new Response("refusal", { status: 502 });
    const record = { ...stage(), upstreamFrames: controlFrames, controlFrames, relayedEvents: 0 };
    markCodexWsPreludeProjection(original);
    markCodexWsStage(original, record);
    markCodexWsSocketDeath(original, record);
    const wrapped = trackProviderRequestSlotBody(slot, original);
    expect(isCodexWsPreludeProjection(wrapped)).toBe(true);
    expect(codexWsSocketDeathStage(wrapped)).toBe(controlFrames ? "protocol-prelude" : "pre-header");
    expect(readCodexWsStage(wrapped)).toBe(record);
    expect(isNativeControlResponse(wrapped)).toBe(false);
    expect(isCodexWsUpstreamResponse(wrapped)).toBe(false);
    expect(isCodexWsQuotaObservedResponse(wrapped)).toBe(false);
    expect(wrapped.status).toBe(502);
    await wrapped.body!.cancel();
    expect(slot.released).toBe(true);
  });

  test("an unobserved WS response retains only its existing authority", async () => {
    const slot = await waitForProviderRequestSlot("ws-only", provider);
    const original = new Response("WS");
    markCodexWsResponse(original, false);
    const wrapped = trackProviderRequestSlotBody(slot, original);
    expect(isCodexWsUpstreamResponse(wrapped)).toBe(true);
    expect(isCodexWsQuotaObservedResponse(wrapped)).toBe(false);
    expect(isNativeControlResponse(wrapped)).toBe(false);
    await wrapped.body!.cancel();
  });

  test("unmarked caller content and copied headers never acquire transport authority", async () => {
    const slot = await waitForProviderRequestSlot("unmarked", provider);
    const original = new Response('{"type":"response.created","nativeControl":true}', {
      headers: { "x-codex-ws": "true", "x-native-control": "true", "x-codex-turn-state": "fixture" },
    });
    const wrapped = trackProviderRequestSlotBody(slot, original);
    expectUnmarked(wrapped);
    expect(wrapped.headers.get("x-codex-turn-state")).toBe("fixture");
    await wrapped.body!.cancel();
  });

  test("only the owned body rewrap carries identity; ordinary cloning does not", async () => {
    const source = markNativeControlResponse(new Response("fixture"));
    markCodexWsResponse(source, true);
    const clone = source.clone();
    expectUnmarked(clone);
    expect(trackProviderRequestSlotBody(undefined, source)).toBe(source);
    await Promise.all([source.text(), clone.text()]);
  });

  test.each([undefined, false])("registered provenance preserves present values (%s)", async value => {
    const markers = new WeakMap<Response, unknown>();
    registerProviderResponseProvenance(markers);
    registerProviderResponseProvenance(markers); // Registration is idempotent.
    const original = new Response("fixture");
    markers.set(original, value);
    const tracked = countedSlot();
    const wrapped = trackProviderRequestSlotBody(tracked.slot, original);
    expect(markers.has(wrapped)).toBe(true);
    expect(markers.get(wrapped)).toBe(value);
    expectUnmarked(wrapped);
    await wrapped.text();
    expect(tracked.releases()).toBe(1);
  });

  test("body completion releases once after every chunk", async () => {
    const tracked = countedSlot();
    const wrapped = trackProviderRequestSlotBody(tracked.slot, markNativeControlResponse(new Response(
      new ReadableStream<Uint8Array>({ start(controller) {
        controller.enqueue(new TextEncoder().encode("first"));
        controller.enqueue(new TextEncoder().encode("second"));
        controller.close();
      } }),
    )));
    const reader = wrapped.body!.getReader();
    expect((await reader.read()).done).toBe(false);
    expect(tracked.releases()).toBe(0);
    expect((await reader.read()).done).toBe(false);
    expect(tracked.releases()).toBe(0);
    expect((await reader.read()).done).toBe(true);
    await reader.cancel();
    expect(tracked.releases()).toBe(1);
  });

  test("body cancellation forwards its reason and releases once", async () => {
    const tracked = countedSlot();
    const reasons: unknown[] = [];
    const original = new Response(new ReadableStream({ cancel(reason) { reasons.push(reason); } }));
    markCodexWsResponse(original, true);
    const wrapped = trackProviderRequestSlotBody(tracked.slot, original);
    await wrapped.body!.cancel("consumer-abort");
    await wrapped.body!.cancel("second-cancel");
    expect(reasons).toEqual(["consumer-abort"]);
    expect(tracked.releases()).toBe(1);
  });

  test("body error preserves the failure and releases once", async () => {
    const tracked = countedSlot();
    const failure = new Error("fixture stream failure");
    const original = new Response(new ReadableStream({ pull(controller) { controller.error(failure); } }));
    markCodexWsResponse(original, false);
    const wrapped = trackProviderRequestSlotBody(tracked.slot, original);
    await expect(wrapped.text()).rejects.toBe(failure);
    expect(tracked.releases()).toBe(1);
  });

  test("abort and send error both return round-robin key leases", async () => {
    const abort = new AbortController();
    const failure = new DOMException("fixture abort", "AbortError");
    const slot = await waitForProviderRequestSlot("abort", provider, undefined, abort.signal);
    abort.abort(failure);
    await expect(sendTrackingRequestSlot(slot, async () => { throw failure; })).rejects.toBe(failure);
    expect(slot.released).toBe(true);
    expect(providerRequestPacingStatus("abort", provider).keys?.[0]?.inFlight).toBe(0);
    const next = await waitForProviderRequestSlot("abort", provider);
    await expect(sendTrackingRequestSlot(next, async () => { throw new Error("send failed"); })).rejects.toThrow("send failed");
    expect(next.released).toBe(true);
    expect(providerRequestPacingStatus("abort", provider).keys?.[0]?.inFlight).toBe(0);
  });
});
