import assert from 'node:assert/strict';
import { relayResponseLogBody, MAX_RESPONSE_LOG_INSPECTION_BYTES, MAX_NON_JSON_ERROR_INSPECTION_BYTES } from '../../src/server/response-log-body';
const enc = new TextEncoder();
const tick = () => new Promise<void>(r => setTimeout(r, 0));
function controlled() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const reasons: unknown[] = [];
  const stream = new ReadableStream<Uint8Array>({ start(c) { controller = c; }, cancel(r) { reasons.push(r); } }, { highWaterMark: 0 });
  return { stream, reasons, push: (v: string | Uint8Array) => controller.enqueue(typeof v === 'string' ? enc.encode(v) : v), close: () => controller.close(), error: (e: unknown) => controller.error(e) };
}
function wrapped(source: ReadableStream<Uint8Array>, isJson: boolean, inspectionLimit?: number) {
  const calls: [string, string | undefined][] = [];
  return { body: relayResponseLogBody(source, { isJson, inspectionLimit, onFinalize: (...v) => calls.push(v) }), calls };
}
export function registerResponseLogBodyCases(test: (name: string, run: () => Promise<void>) => unknown): void {
  for (const isJson of [false, true]) {
    test(`first chunk before EOF; no early log (${isJson})`, async () => {
      const s = controlled(), w = wrapped(s.stream, isJson);
      const reader = w.body.getReader(), first = reader.read();
      s.push('{}');
      assert.deepEqual(await first, { value: enc.encode('{}'), done: false });
      assert.equal(w.calls.length, 0);
      s.close();
      assert.equal((await reader.read()).done, true);
      assert.deepEqual(w.calls, [['eof', '{}']]);
      assert.equal(s.stream.locked, false);
    });
    test(`slow readers do not cause prefetch (${isJson})`, async () => {
      let pulls = 0;
      const source = new ReadableStream({ pull(c) { ++pulls; c.enqueue(enc.encode('x')); } }, { highWaterMark: 0 });
      const w = wrapped(source, isJson), r = w.body.getReader();
      await tick(); assert.equal(pulls, 0);
      await r.read(); await tick(); assert.equal(pulls, 1);
      await r.cancel('stop'); assert.equal(w.calls.length, 1);
    });
    test(`pending cancellation finalizes once and propagates reason (${isJson})`, async () => {
      const s = controlled(), w = wrapped(s.stream, isJson), r = w.body.getReader();
      const pending = r.read(); await tick();
      const reason = new Error('client stop');
      await r.cancel(reason); await pending; await tick();
      assert.deepEqual(s.reasons, [reason]);
      assert.deepEqual(w.calls, [['cancel', isJson ? undefined : '']]);
      assert.equal(s.stream.locked, false);
    });
    test(`source error preserves exception and prefix rules (${isJson})`, async () => {
      const s = controlled(), w = wrapped(s.stream, isJson), r = w.body.getReader();
      const first = r.read(); s.push('{}'); await first;
      const failure = new Error('upstream reset');
      const pending = r.read(); s.error(failure);
      await assert.rejects(pending, (e: unknown) => e === failure);
      assert.deepEqual(w.calls, [['error', isJson ? undefined : '{}']]);
      assert.equal(s.stream.locked, false);
    });
  }
  test('binary and split UTF-8 forwarding is byte exact', async () => {
    const chunks = [new Uint8Array([0xff, 0, 0xe3]), new Uint8Array([0x81, 0x82, 0xfe])];
    const source = new ReadableStream<Uint8Array>({ start(c) { chunks.forEach(v => c.enqueue(v)); c.close(); } });
    const w = wrapped(source, false);
    assert.deepEqual(new Uint8Array(await new Response(w.body).arrayBuffer()), new Uint8Array(chunks.flatMap(v => [...v])));
    assert.equal(w.calls.length, 1);
  });
  for (const [size, chunkSize, inspect] of [[8, 8, true], [9, 9, false], [9, 3, false], [8, 1, true]] as const) {
    test(`JSON cap: ${size} bytes in ${chunkSize}-byte chunks`, async () => {
      let sent = 0;
      const source = new ReadableStream({ pull(c) { if (sent === size) return c.close(); const n = Math.min(chunkSize, size-sent); sent += n; c.enqueue(enc.encode('x'.repeat(n))); } });
      const w = wrapped(source, true, 8);
      assert.equal(await new Response(w.body).text(), 'x'.repeat(size));
      assert.deepEqual(w.calls, [['eof', inspect ? 'x'.repeat(size) : undefined]]);
    });
  }
  test('actual oversized JSON budget still forwards every byte', async () => {
    const size = MAX_RESPONSE_LOG_INSPECTION_BYTES + 1;
    let sent = 0;
    const block = new Uint8Array(65536).fill(120);
    const source = new ReadableStream({ pull(c) { if (sent === size) return c.close(); const n = Math.min(block.length, size-sent); sent += n; c.enqueue(block.subarray(0,n)); } });
    const w = wrapped(source, true), r = w.body.getReader();
    let got = 0;
    for (;;) { const { done, value } = await r.read(); if (done) break; got += value.length; assert.equal(value[0], 120); }
    assert.equal(got, size);
    assert.deepEqual(w.calls, [['eof', undefined]]);
  });
  test('non-JSON prefix is byte bounded, not character bounded', async () => {
    const text = '한'.repeat(10000);
    const w = wrapped(new Response(text).body!, false);
    assert.equal(await new Response(w.body).text(), text);
    assert.deepEqual(w.calls, [['eof', new TextDecoder().decode(enc.encode(text).subarray(0, MAX_NON_JSON_ERROR_INSPECTION_BYTES))]]);
  });
  test('cancel before any read never pulls', async () => {
    let pulls = 0; let reason: unknown;
    const s = new ReadableStream({ pull() { ++pulls; }, cancel(r) { reason = r; } }, { highWaterMark: 0 });
    const w = wrapped(s, true);
    await w.body.cancel('before');
    assert.equal(pulls, 0); assert.equal(reason, 'before'); assert.equal(s.locked, false);
    assert.deepEqual(w.calls, [['cancel', undefined]]);
  });
  test('valid JSON prefix on cancellation is not treated as a complete response', async () => {
    const s = controlled(), w = wrapped(s.stream, true), r = w.body.getReader();
    const pending = r.read(); s.push('{"usage":{"total_tokens":900}}'); await pending;
    await r.cancel(); assert.deepEqual(w.calls, [['cancel', undefined]]);
  });
  for (const outcome of ['eof', 'cancel', 'error']) {
    test(`throwing logger does not disrupt ${outcome}`, async () => {
      const s = controlled(); let calls = 0;
      const body = relayResponseLogBody(s.stream, { isJson: false, onFinalize() { ++calls; throw new Error('logging failed'); } });
      const r = body.getReader(); const pending = r.read(); s.push('ok'); await pending;
      if (outcome === 'eof') { s.close(); assert.equal((await r.read()).done, true); }
      if (outcome === 'cancel') { await r.cancel('gone'); assert.deepEqual(s.reasons, ['gone']); }
      if (outcome === 'error') { const e = new Error('reset'); s.error(e); await assert.rejects(r.read(), (v: unknown) => v === e); }
      assert.equal(calls, 1); assert.equal(s.stream.locked, false);
    });
  }
  test('cancel rejection does not stall teardown', async () => {
    const source = new ReadableStream({ cancel() { return Promise.reject(new Error('cancel failed')); } });
    const w = wrapped(source, false); await w.body.cancel(); await tick();
    assert.equal(w.calls.length, 1); assert.equal(source.locked, false);
  });
  test('tee cancellation does not wait for sibling; sibling remains intact', async () => {
    const s = controlled(), [left, right] = s.stream.tee();
    const w = wrapped(left, false), reader = w.body.getReader(), sibling = right.getReader();
    const a = reader.read(), b = sibling.read(); s.push('first'); await a; await b;
    await reader.cancel('left stopped');
    assert.equal(w.calls.length, 1); assert.equal(s.reasons.length, 0);
    const next = sibling.read(); s.push('second'); assert.equal(new TextDecoder().decode((await next).value), 'second');
    s.close(); assert.equal((await sibling.read()).done, true);
  });
  test('cancel wins a racing source error without duplicate finalization', async () => {
    const s = controlled(), w = wrapped(s.stream, true), r = w.body.getReader();
    const pending = r.read(); await tick();
    s.error(new Error('reset'));
    await r.cancel('stop'); await pending; await tick();
    assert.deepEqual(w.calls, [['cancel', undefined]]);
  });
  test('retained inspection is a copy, not a view of forwarded storage', async () => {
    const s = controlled(), w = wrapped(s.stream, false), r = w.body.getReader();
    const buffer = enc.encode('original'); const read = r.read(); s.push(buffer); await read; buffer.fill(120);
    s.close(); await r.read(); assert.deepEqual(w.calls, [['eof', 'original']]);
  });
  test('empty JSON at zero cap and invalid limits', async () => {
    const w = wrapped(new Response('').body!, true, 0); await new Response(w.body).text(); assert.deepEqual(w.calls, [['eof', '']]);
    for (const limit of [-1, NaN, Infinity, 1.5]) {
      const source = controlled().stream;
      assert.throws(() => wrapped(source, true, limit), RangeError); assert.equal(source.locked, false);
    }
  });

}
