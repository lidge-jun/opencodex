/**
 * The native call registry tells a join for a call this proxy created apart from a join for a call
 * the client created itself (V3 `existingCall`). Its id extraction must yield exactly the id the
 * client reads from the same Location, or a created call would look foreign and lose its account.
 */
import { expect, test } from "bun:test";
import { liveCallIdFromLocation, NativeLiveCalls } from "../../src/server/live-native-calls";

const UUID = "0d6c3f1e-8b2a-4c4d-9e0f-1a2b3c4d5e6f";

test("call ids are extracted the way openai/codex reads them from a Location", () => {
  expect(liveCallIdFromLocation("/v1/live/rtc_api_1")).toBe("rtc_api_1");
  expect(liveCallIdFromLocation("/v1/realtime/calls/calls/rtc_backend_1")).toBe("rtc_backend_1");
  expect(liveCallIdFromLocation("https://api.openai.com/v1/realtime/calls/rtc_abs")).toBe("rtc_abs");
  expect(liveCallIdFromLocation(`/v1/realtime/calls/${UUID}`)).toBe(UUID);
  expect(liveCallIdFromLocation("/v1/live/rtc_query?intent=quicksilver&x=/rtc_not_this")).toBe("rtc_query");
  expect(liveCallIdFromLocation("/v1/live/rtc_slash/")).toBe("rtc_slash");
  expect(liveCallIdFromLocation("/v1/realtime/calls/rtc_suffix/accept")).toBe("rtc_suffix");
});

test("a Location without a recognizable call id records nothing", () => {
  for (const location of [null, undefined, "", "/v1/live", "/v1/live/rtc_", "/v1/live/call-abc",
    "/v1/live/rtc_bad%20id", `/v1/live/rtc_${"a".repeat(130)}`, `/v1/live/${"x".repeat(5000)}/rtc_long`]) {
    expect(liveCallIdFromLocation(location)).toBeNull();
  }
  const calls = new NativeLiveCalls();
  expect(calls.record("/v1/live")).toBeNull();
  expect(calls.size).toBe(0);
});

test("a recorded call is known until its TTL passes", () => {
  let now = 1_000;
  const calls = new NativeLiveCalls(() => now, 60_000, 8);
  expect(calls.record("/v1/live/rtc_ttl")).toBe("rtc_ttl");
  expect(calls.has("rtc_ttl")).toBe(true);
  expect(calls.has("rtc_other")).toBe(false);
  now += 59_999;
  expect(calls.has("rtc_ttl")).toBe(true);
  now += 1;
  expect(calls.has("rtc_ttl")).toBe(false);
  expect(calls.size).toBe(0);
});

test("capacity evicts the oldest call first, and re-recording refreshes a call", () => {
  let now = 0;
  const calls = new NativeLiveCalls(() => now, 60_000, 2);
  calls.record("/v1/live/rtc_one");
  now += 1;
  calls.record("/v1/live/rtc_two");
  now += 1;
  calls.record("/v1/live/rtc_one");
  now += 1;
  calls.record("/v1/live/rtc_three");
  expect(calls.has("rtc_two")).toBe(false);
  expect(calls.has("rtc_one")).toBe(true);
  expect(calls.has("rtc_three")).toBe(true);
  expect(calls.size).toBe(2);
});

test("clear forgets every recorded call", () => {
  const calls = new NativeLiveCalls();
  calls.record("/v1/live/rtc_clear");
  calls.clear();
  expect(calls.has("rtc_clear")).toBe(false);
});
