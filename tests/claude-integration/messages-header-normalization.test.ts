import { expect, test } from "bun:test";
import { anthropicRateLimitHeaders } from "../../src/server/anthropic-rate-limit-headers";
const sentinel = "zq7Vb2LmN4pX9tR1sK8wD3fH6jY0cA5e";
const table: [string, string, string][] = [];
for (const family of ["requests", "tokens", "input-tokens", "output-tokens"]) {
  for (const field of ["limit", "remaining"]) table.push([`anthropic-ratelimit-${family}-${field}`, "00042", "42"]);
  table.push([`anthropic-ratelimit-${family}-reset`, "2026-11-03t12:30:40.987654321+02:30", "2026-11-03T10:00:40.987654321Z"]);
}
for (const window of ["", "-5h", "-7d", "-7d_oi"]) {
  table.push([`anthropic-ratelimit-unified${window}-status`, "allowed", "allowed"]);
  table.push([`anthropic-ratelimit-unified${window}-reset`, "000123.456789", "123.457"]);
  if (window) table.push([`anthropic-ratelimit-unified${window}-utilization`, "00.620049999999", "0.62"]);
}
for (const [name, value, expected] of table) test(`${name} regenerates its value`, () => {
  expect(anthropicRateLimitHeaders(new Headers({ [name]: value }))).toEqual({ [name]: expected });
});
for (const [name] of table) test(`${name} drops arbitrary values`, () => {
  for (const value of [sentinel, "NaN", "Infinity", "1e3", "-1", "+1", "1, 2", "١", "1 2", "1\t2", "1".repeat(129)]) {
    const raw = new Headers();
    raw.get = key => key === name ? value : null;
    expect(anthropicRateLimitHeaders(raw)).toEqual({});
  }
});
const cases = [
  ["requests-remaining", "0", "0"], ["requests-limit", "1000000000000", "1000000000000"],
  ["requests-limit", "1000000000001", undefined], ["requests-limit", "1.0", undefined],
  ["unified-reset", "253402300799", "253402300799"], ["unified-reset", "253402300798.999999", "253402300799"],
  ["unified-reset", "253402300799.000001", undefined], ["unified-reset", "253402300800", undefined],
  ["unified-reset", "0.000001", "0"], ["unified-5h-utilization", "1.01", "1.01"],
  ["unified-5h-utilization", "99.999999999999", "100"], ["unified-5h-utilization", "100.000000000001", undefined],
  ["unified-5h-utilization", "0.12345", "0.1235"], ["unified-status", "rejected", "rejected"],
  ["unified-status", "allowed_warning", undefined], ["unified-status", "Allowed", undefined],
  ["tokens-reset", "2024-02-29T23:59:59.9Z", "2024-02-29T23:59:59.9Z"],
  ["tokens-reset", "2026-01-01T00:00:00.987+01:00", "2025-12-31T23:00:00.987Z"],
  ["tokens-reset", "2026-01-01T23:59:59.001-00:01", "2026-01-02T00:00:59.001Z"],
  ["tokens-reset", "1970-01-01T00:00:00.001Z", "1970-01-01T00:00:00.001Z"],
  ["tokens-reset", "1970-01-01T01:00:00.001+01:00", "1970-01-01T00:00:00.001Z"],
  ["tokens-reset", "1970-01-01T00:00:00.999+00:01", undefined],
  ["tokens-reset", "9999-12-31T22:59:59.999-01:00", "9999-12-31T23:59:59.999Z"],
  ["tokens-reset", "9999-12-31T23:59:59.999-00:01", undefined],
  ["tokens-reset", "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00Z"],
  ["tokens-reset", "2026-01-01T00:00:00.000999999Z", "2026-01-01T00:00:00.000999999Z"],
  ["tokens-reset", "2026-01-01T00:00:00.1+01:00", "2025-12-31T23:00:00.1Z"],
  ["tokens-reset", "2026-01-01T00:00:00.123+01:00", "2025-12-31T23:00:00.123Z"],
  ["tokens-reset", "2026-01-01T00:00:00.123456+01:00", "2025-12-31T23:00:00.123456Z"],
  ["tokens-reset", "2026-01-01T00:00:00.987654321+01:00", "2025-12-31T23:00:00.987654321Z"],
  ["tokens-reset", "2024-03-01T00:00:00.123456+00:01", "2024-02-29T23:59:00.123456Z"],
  ["tokens-reset", "2024-02-29T23:59:59.1-00:01", "2024-03-01T00:00:59.1Z"],
  ["tokens-reset", "1970-01-01T00:00:00.000000001Z", "1970-01-01T00:00:00.000000001Z"],
  ["tokens-reset", "9999-12-31T23:59:59.999999999Z", "9999-12-31T23:59:59.999999999Z"],
  ["tokens-reset", "2026-01-01T00:00:00.100000000Z", "2026-01-01T00:00:00.1Z"],
  ["tokens-reset", "2026-01-01T00:00:00.000000000Z", "2026-01-01T00:00:00Z"],
  ["tokens-reset", "2026-01-01T00:00:00.1234567890Z", undefined],
  ["tokens-reset", "2026-02-29T00:00:00Z", undefined], ["tokens-reset", "2026-11-31T00:00:00Z", undefined],
  ["tokens-reset", "1970-01-01T00:00:00+01:00", undefined], ["tokens-reset", "2026-01-01T00:00:00-00:00", undefined],
  ["tokens-reset", "9999-12-31T23:59:59.999Z", "9999-12-31T23:59:59.999Z"],
  ["tokens-reset", "2026-01-01T00:00:60Z", undefined], ["tokens-reset", "12345", undefined],
  ["tokens-reset", "Wed, 03 Nov 2026 00:00:00 GMT", undefined],
] as const;
for (const [suffix, value, expected] of cases) test(`${suffix}: ${value}`, () => {
  const name = `anthropic-ratelimit-${suffix}`;
  expect(anthropicRateLimitHeaders(new Headers({ [name]: value }))).toEqual(expected === undefined ? {} : { [name]: expected });
});
test("unknown family members are omitted while raw observations remain unchanged", () => {
  const raw = new Headers({ "anthropic-ratelimit-unified-7d-utilization": "0.62", "anthropic-ratelimit-unified-5h-reset": "1790913600.123456", [`anthropic-ratelimit-${sentinel}`]: sentinel, "anthropic-ratelimit-unified-utilization": "0.5" });
  const client = anthropicRateLimitHeaders(raw);
  expect(JSON.stringify(client).length).toBeGreaterThan(0);
  expect(JSON.stringify(client)).not.toContain(sentinel);
  expect(client).toEqual({ "anthropic-ratelimit-unified-7d-utilization": "0.62", "anthropic-ratelimit-unified-5h-reset": "1790913600.123" });
  expect(raw.get("anthropic-ratelimit-unified-5h-reset")).toBe("1790913600.123456");
});

test("quota decisions keep raw fractions and reset precision separately from client display", async () => {
  const { rawAnthropicHeaderWindows } = await import("../../src/providers/quota/anthropic-decision-windows");
  const { parseAnthropicFamilyHeaders } = await import("../../src/providers/quota/anthropic-family-headers");
  const raw = new Headers({
    "anthropic-ratelimit-unified-5h-utilization": "0.620049", "anthropic-ratelimit-unified-5h-reset": "1790913600.123456",
    "anthropic-ratelimit-unified-7d_oi-utilization": "1.01", "anthropic-ratelimit-unified-7d_oi-reset": "1790913600.123456",
    "anthropic-ratelimit-unified-7d_oi-status": "rejected",
  });
  const before = rawAnthropicHeaderWindows(raw, 1000);
  const familyBefore = parseAnthropicFamilyHeaders(raw, 1000, 429);
  const client = anthropicRateLimitHeaders(raw);
  expect(client["anthropic-ratelimit-unified-5h-utilization"]).toBe("0.62");
  expect(client["anthropic-ratelimit-unified-5h-reset"]).toBe("1790913600.123");
  expect(rawAnthropicHeaderWindows(raw, 1000)).toEqual(before);
  expect(before).toEqual([{ window: "5h", percent: 62.0049, observedAt: 1000, resetAt: 1790913600123.456 }]);
  expect(parseAnthropicFamilyHeaders(raw, 1000, 429)).toEqual(familyBefore);
  expect(familyBefore[0]).toMatchObject({ label: "Fable", percent: 100, rejected: true, resetAt: 1790913600123.456 });
});
