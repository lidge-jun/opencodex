import { expect, test } from "bun:test";
import {
  aggregateRouteClass,
  composeGrantTap,
  parseForwardGrant,
  routeCooldownMs,
  routeOutcomeOfStderr,
  type RouteOutcomeClass,
} from "../../src/link/route-select";

test("cooldowns keep today's per-alias cadence for each route", () => {
  // Transient: today's reconnect backoff (1 s doubling to 30 s, jitter fixed at 1.0 here).
  expect([1, 2, 3, 4, 5, 6, 7].map(n => routeCooldownMs("transient", n, () => 0.5))).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000]);
  expect(routeCooldownMs("readiness", 1, () => 0.5)).toBe(1_000);
  expect(routeCooldownMs("grant_unobserved", 3, () => 0.5)).toBe(4_000);
  expect(routeCooldownMs("forward", 1)).toBe(60_000);
  expect(routeCooldownMs("forward", 9)).toBe(60_000);
  expect(routeCooldownMs("auth", 1)).toBe(300_000);
  expect(routeCooldownMs("auth", 9)).toBe(300_000);
  expect(routeCooldownMs("hostkey", 1)).toBe(600_000);
});

test.each([
  [["hostkey", "hostkey"], "hostkey"],
  [["hostkey", "transient"], "network"],
  [["hostkey", "auth"], "auth"],
  [["auth", "forward"], "forward"],
  [["hostkey", "grant_unobserved"], "network"],
  [["hostkey", "readiness"], "network"],
  [["hostkey", null], "network"],
] as const)("the link verdict of %j is the most recoverable route outcome: %s", (outcomes, expected) => {
  expect(aggregateRouteClass(outcomes as readonly (RouteOutcomeClass | null)[])).toBe(expected);
});

test("only an all-hostkey link is terminal", () => {
  expect(aggregateRouteClass(["hostkey"])).toBe("hostkey");
  expect(aggregateRouteClass(["hostkey", "hostkey", "hostkey"])).toBe("hostkey");
});

test.each([
  ["Host key verification failed.", "hostkey"],
  ["alice@host: Permission denied (publickey).", "auth"],
  ["Warning: remote port forwarding failed for listen port 19002", "forward"],
  ["ssh: connect to host 10.0.0.5 port 22: Connection refused", "transient"],
  ["", "transient"],
] as const)("stderr %j is a %s route outcome", (stderr, expected) => {
  expect(routeOutcomeOfStderr(stderr)).toBe(expected);
});

test("the grant line names this tunnel's ports exactly", () => {
  const line = "debug1: remote forward success for: listen 127.0.0.1:19002, connect 127.0.0.1:19001";
  expect(parseForwardGrant(line, 19002, 19001)).toBe("granted");
  expect(parseForwardGrant(line.replace("success", "failure"), 19002, 19001)).toBe("refused");
  expect(parseForwardGrant(line, 19003, 19001)).toBeNull();
  expect(parseForwardGrant(line, 19002, 19000)).toBeNull();
  expect(parseForwardGrant("debug1: Remote: remote forward success for: listen 127.0.0.1:19002, connect 127.0.0.1:19001", 19002, 19001)).toBeNull();
  expect(parseForwardGrant("remote forward success for: listen 127.0.0.1:190020, connect 127.0.0.1:19001", 19002, 19001)).toBeNull();
});

test("the composed tap observes the grant and keeps exactly today's classifier lines", () => {
  const seen: string[] = [];
  const tap = composeGrantTap(19002, 19001, verdict => seen.push(verdict));
  const debugNoise = [
    "debug1: connect_next: connect to 127.0.0.1 port 19001: Connection refused",
    "debug1: Remote: Permission denied for a forwarded channel",
    "debug1: channel 2: free: port listener, nchannels 3 connection reset",
  ];
  for (const line of debugNoise) expect(tap(line)).toBe(false);
  expect(tap("debug1: remote forward success for: listen 127.0.0.1:19002, connect 127.0.0.1:19001")).toBe(false);
  expect(seen).toEqual(["granted"]);
  expect(tap("Host key verification failed.")).toBe(true);
  expect(tap("alice@host: Permission denied (publickey).")).toBe(true);
});

test("the composed tap runs a capture tap after the observer and keeps its decision", () => {
  const captured: string[] = [];
  const tap = composeGrantTap(19002, 19001, () => {}, line => { captured.push(line); return line.startsWith("Host key"); });
  expect(tap("debug1: remote forward success for: listen 127.0.0.1:19002, connect 127.0.0.1:19001")).toBe(false);
  expect(tap("Host key verification failed.")).toBe(true);
  expect(captured).toHaveLength(2);
});

test("an observer that throws neither breaks the tap nor changes the classification", () => {
  const tap = composeGrantTap(19002, 19001, () => { throw new Error("observer failure"); });
  expect(tap("debug1: remote forward success for: listen 127.0.0.1:19002, connect 127.0.0.1:19001")).toBe(false);
  expect(tap("Host key verification failed.")).toBe(true);
});
