import { afterEach, expect, test } from "bun:test";
import {
  applyTerminalRefusalClientHeaders,
  replayRefusalResponse,
  replayRefusedStatus,
  setReplayRefusalRetryable,
} from "../../src/lib/upstream-retry";

afterEach(() => setReplayRefusalRetryable(false));

test("a replay refusal stays terminal by default", async () => {
  expect(replayRefusedStatus()).toBe(429);
  const response = replayRefusalResponse();
  expect(response.status).toBe(429);
  expect(response.headers.get("x-should-retry")).toBe("false");
});

test("replayRefusalRetryable makes the refusal a retryable 502", async () => {
  setReplayRefusalRetryable(true);
  expect(replayRefusedStatus()).toBe(502);
  const response = replayRefusalResponse();
  expect(response.status).toBe(502);
  expect(response.headers.get("x-should-retry")).toBe("true");
});

test("deterministic contract errors stay terminal when retryable refusals are enabled", () => {
  setReplayRefusalRetryable(true);
  const headers = new Headers();
  applyTerminalRefusalClientHeaders(headers);
  expect(headers.get("x-should-retry")).toBe("false");
});
