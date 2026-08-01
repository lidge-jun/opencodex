import { expect, test } from "bun:test";
import { formatCreatedDate } from "../src/pages/api-keys-utils";

// The server salvages a key whose `createdAt` was hand-edited to a non-string
// rather than discarding a working credential, so this formatter can now receive
// an empty string. Rendering "Invalid Date" would state something false about the
// key; the dash states the one true thing.

test("an empty createdAt renders as unknown, not Invalid Date", () => {
  expect(formatCreatedDate("")).toBe("—");
});

test("an unparseable createdAt renders as unknown", () => {
  expect(formatCreatedDate("not-a-date")).toBe("—");
  expect(formatCreatedDate("2026-13-45T99:99:99Z")).toBe("—");
});

test("a real timestamp still formats for the locale", () => {
  const formatted = formatCreatedDate("2026-07-31T00:00:00.000Z", "en-US");
  expect(formatted).not.toBe("—");
  expect(formatted).toContain("2026");
});
