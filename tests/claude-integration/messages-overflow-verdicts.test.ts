import { expect, test } from "bun:test";
import { cases, golden, key, registerMessagesOverflowRows } from "../helpers/messages-overflow-assertions";
import type { MessagesOverflowFixture } from "../helpers/messages-overflow-cases";

registerMessagesOverflowRows(["passthrough", "count_tokens"]);

for (const lane of ["passthrough", "count_tokens"] as const) for (const pair of ["id", "utf8"]) test(`${lane}: raw ${pair} outcomes differ`, async () => {
  const left = cases.find(row => row.lane === lane && row.input.id === `raw-parity-${pair}-a`)!;
  const right = cases.find(row => row.lane === lane && row.input.id === `raw-parity-${pair}-b`)!;
  const { observeMessagesOverflowBody } = await import("../helpers/messages-overflow-case");
  const body = (input: MessagesOverflowFixture) => new Response(input.rawBytes ? new Uint8Array(input.rawBytes) : input.rawBody!);
  const a = await observeMessagesOverflowBody(body(left.input), lane, left.input);
  const b = await observeMessagesOverflowBody(body(right.input), lane, right.input);
  expect(a.bodyLength).toBeGreaterThan(0);
  expect(a.bodyLength).toBe(b.bodyLength);
  expect(a.bodySha256).not.toBe(b.bodySha256);
  if (pair === "id") expect(golden.outcomes[key(left)]![9]).not.toBe(golden.outcomes[key(right)]![9]);
  // The baseline proxy already decodes upstream UTF-8; compare its real returned bytes separately.
  else expect(golden.outcomes[key(left)]![9]).toBe(golden.outcomes[key(right)]![9]);
});
