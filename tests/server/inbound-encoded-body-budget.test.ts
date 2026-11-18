import { describe, expect, test } from "bun:test";
import { zstdCompressSync } from "node:zlib";
import { withRaisedInboundBodyAdmission } from "../../src/server/inbound-body-admission";
import { createInboundBodyBudget } from "../../src/server/inbound-body-budget";
import { compressedBodyDecodeLimit, MAX_DECOMPRESSED_BODY_BYTES, readBoundedJsonRequestBody } from "../../src/server/request-decompress";

const plain = new TextEncoder().encode(JSON.stringify({ input: "an agent re-sends its whole conversation ".repeat(2000) }));
const wire = zstdCompressSync(plain);

function encodedRequest(signal?: AbortSignal): Request {
  return new Request("http://127.0.0.1/v1/responses", { method: "POST", body: wire, signal,
    headers: { "content-type": "application/json", "content-encoding": "zstd", "content-length": String(wire.byteLength) } });
}

function gate<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

describe("encoded request bodies join the shared inbound budget at the default limit (#3023)", () => {
  test("an encoded body reserves its decode bound before reading, shrinks to its measured size, and releases when the response ends", async () => {
    const budget = createInboundBodyBudget(64 * 1024 * 1024);
    const during: number[] = [];
    const response = await withRaisedInboundBodyAdmission(encodedRequest(), "/v1/responses", undefined, async () => {
      during.push(budget.snapshot().reservedBytes);
      return Response.json({ ok: true });
    }, undefined, { budget });
    expect(during).toEqual([compressedBodyDecodeLimit(wire.byteLength, MAX_DECOMPRESSED_BODY_BYTES)]);
    await response.text();
    expect(budget.snapshot()).toEqual({ reservedBytes: 0, activeLeases: 0, queuedRequests: 0 });

    const req = encodedRequest();
    const measured: number[] = [];
    await (await withRaisedInboundBodyAdmission(req, "/v1/responses", undefined, async () => {
      await readBoundedJsonRequestBody(req, MAX_DECOMPRESSED_BODY_BYTES);
      measured.push(budget.snapshot().reservedBytes);
      return Response.json({ ok: true });
    }, undefined, { budget })).text();
    expect(measured[0]).toBeGreaterThanOrEqual(plain.byteLength);
    expect(measured[0]).toBeLessThan(compressedBodyDecodeLimit(wire.byteLength, MAX_DECOMPRESSED_BODY_BYTES));
  });

  test("when decoded bodies in flight fill the budget, the next encoded body is refused before it is read; identity bodies are not gated", async () => {
    const reservation = compressedBodyDecodeLimit(wire.byteLength, MAX_DECOMPRESSED_BODY_BYTES);
    const budget = createInboundBodyBudget(reservation, 0);
    const holding = gate(), entered = gate();
    const first = withRaisedInboundBodyAdmission(encodedRequest(), "/v1/responses", undefined, async () => {
      entered.resolve(); await holding.promise; return Response.json({ ok: true });
    }, undefined, { budget, maxWaitMs: 0 });
    await entered.promise;
    let ran = false;
    const refused = await withRaisedInboundBodyAdmission(encodedRequest(), "/v1/responses", undefined, async () => { ran = true; return Response.json({}); },
      undefined, { budget, maxWaitMs: 0 });
    expect(ran).toBe(false);
    expect(refused.status).toBe(503);
    expect(await refused.json()).toMatchObject({ error: { code: "server_busy" } });
    const identity = await withRaisedInboundBodyAdmission(new Request("http://127.0.0.1/v1/responses", { method: "POST", body: plain,
      headers: { "content-type": "application/json" } }), "/v1/responses", undefined, async () => Response.json({ ok: true }), undefined, { budget, maxWaitMs: 0 });
    expect(identity.status).toBe(200);
    holding.resolve();
    await (await first).text();
    expect(budget.snapshot().reservedBytes).toBe(0);
  });
});
