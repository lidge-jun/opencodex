import { expect, test } from "bun:test";
import { newBrowserUuid } from "../src/lib/uuid";

test("browser UUID falls back to RFC 4122 v4 when randomUUID rejects", () => {
  const cryptoObject = globalThis.crypto;
  const originalRandomUuid = cryptoObject.randomUUID;
  Object.defineProperty(cryptoObject, "randomUUID", {
    configurable: true,
    value: () => { throw new Error("randomUUID requires a secure context"); },
  });
  try {
    expect(newBrowserUuid()).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  } finally {
    Object.defineProperty(cryptoObject, "randomUUID", {
      configurable: true,
      value: originalRandomUuid,
    });
  }
});
