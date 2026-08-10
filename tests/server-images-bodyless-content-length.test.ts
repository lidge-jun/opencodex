import { expect, test } from "bun:test";
import { IMAGES_RESPONSE_MAX_BYTES, readImageResponseBytes } from "../src/server/images";

test("bodyless 304 ignores representation Content-Length when enforcing image response size", async () => {
  const response = new Response(null, {
    status: 304,
    headers: { "content-length": String(IMAGES_RESPONSE_MAX_BYTES + 1) },
  });

  const observed = await readImageResponseBytes(response);

  expect(observed.oversized).toBe(false);
  expect(observed.bytes.byteLength).toBe(0);
});
