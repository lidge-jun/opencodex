import { expect, test } from 'bun:test';
import { translateZedOpenAiStream } from '../../src/adapters/zed-openai-stream';
import { zedEventStream } from '../../src/adapters/zed';
import { createTranslatorBudget } from '../../src/lib/translator-budget';
import { bridgeToResponsesSSE, buildResponseJSON } from '../../src/bridge';
import { ZedJsonScanner, zedJsonTokens, ZED_JSON_MAX_DEPTH } from '../../src/adapters/zed-json-tokens';
import { ZedArgumentAuthority, reconcileZedArguments, zedArgumentFingerprint } from '../../src/adapters/zed-tool-arguments';

const item = (argumentsText: string, id = 'a') => ({ type: 'function_call', id,
  call_id: 'call-' + id, name: 'fixture', status: 'completed', arguments: argumentsText });
const added = (id = 'a') => ({ type: 'response.output_item.added', item: { ...item('', id), status: 'in_progress' } });
const delta = (text: string, id = 'a') => ({ type: 'response.function_call_arguments.delta', item_id: id, delta: text });
const argsDone = (text: string) => ({ type: 'response.function_call_arguments.done', item_id: 'a', arguments: text });
const ended = (text: string, id = 'a') => ({ type: 'response.output_item.done', item: item(text, id) });
const completed = (output: unknown[] = []) => ({ type: 'response.completed', response: { output } });

async function collect(frames: unknown[]) {
  const budget = createTranslatorBudget();
  try {
    const source = new Response(frames.map(event => JSON.stringify({ event }) + '\n').join('')
      + '{"status":"stream_ended"}\n').body!;
    return await Array.fromAsync(translateZedOpenAiStream(zedEventStream(source, 'open_ai'), budget));
  } finally {
    expect(budget.snapshot()).toMatchObject({ currentBytes: 0, activeCalls: 0 });
    budget.dispose();
  }
}

for (const [name, left, right] of [
  ['integer precision', '{"id":9007199254740992}', '{"id":9007199254740993}'],
  ['fraction precision', '{"x":1}', '{"x":1.0000000000000001}'],
  ['underflow', '{"x":0}', '{"x":1e-400}'],
  ['overflow', '{"x":1e400}', '{"x":2e400}'],
] as const) for (const mode of ['visible', 'buffered', 'late', 'replay'] as const) {
  test(`round3 rejects distinct numbers: ${name}, ${mode}`, async () => {
    const id = mode === 'buffered' ? 'b' : 'a';
    const frames = mode === 'late' ? [added(), argsDone(left), delta(right), completed()]
      : mode === 'replay' ? [added(), delta(left), ended(left), completed([item(right)])]
      : [...(mode === 'buffered' ? [added()] : []), added(id), delta(left, id), ended(right, id),
        ...(mode === 'buffered' ? [ended('{}')] : []), completed()];
    const events = await collect(frames);
    expect(events.at(-1)?.type).toBe('error');
    expect(buildResponseJSON(events, 'fixture').status).toBe('failed');
    const wire = await new Response(bridgeToResponsesSSE((async function* () { yield* events; })(), 'fixture')).text();
    const terminal = wire.split('\n').filter(line => line.startsWith('data: {')).map(line => JSON.parse(line.slice(6)))
      .findLast(event => ['response.completed', 'response.failed', 'response.incomplete'].includes(event.type));
    expect(terminal?.response.status).toBe('failed');
  });
}

test('round3 equivalent object-rooted JSON at depth 50000 succeeds iteratively', async () => {
  const text = '{"x":' + '['.repeat(50000) + '1' + ']'.repeat(50000) + '}';
  const events = await collect([added(), delta(text), ended(' ' + text), completed()]);
  expect(events.at(-1)?.type).toBe('done');
});

test('round3 one MiB late fragments do only linear JSON parsing and byte measurement', async () => {
  const text = '{"x":"' + 'a'.repeat(1048500) + '"}';
  const frames = [added(), argsDone(text)];
  for (let i = 0; i < text.length; i += 64) frames.push(delta(text.slice(i, i + 64)) as typeof frames[number]);
  frames.push(ended(text) as typeof frames[number], completed() as typeof frames[number]);
  const parse = JSON.parse;
  const byteLength = Buffer.byteLength;
  let measured = 0;
  JSON.parse = ((input: string, ...rest: []) => { measured += input.length; return parse(input, ...rest); }) as typeof JSON.parse;
  Buffer.byteLength = ((input: Parameters<typeof byteLength>[0], ...rest: [BufferEncoding?]) => {
    measured += input.length;
    return byteLength(input, ...rest);
  }) as typeof byteLength;
  let events;
  try { events = await collect(frames); }
  finally { JSON.parse = parse; Buffer.byteLength = byteLength; }
  expect(events.at(-1)?.type).toBe('done');
  expect(measured).toBeLessThan(text.length * 100);
}, 30000);

test('scanner steps bound one MiB of 64-byte fragments linearly', () => {
  const text = '{"x":"' + 'a'.repeat(1048500) + '"}';
  const authority = new ZedArgumentAuthority(text, false);
  for (let i = 0; i < text.length; i += 64) authority.push(text.slice(i, i + 64));
  expect(authority.steps).toBe(text.length);
});

test('explicit nesting limit accepts its boundary and refuses the next container clearly', async () => {
  const text = '['.repeat(ZED_JSON_MAX_DEPTH) + '0' + ']'.repeat(ZED_JSON_MAX_DEPTH);
  expect(() => zedJsonTokens(text)).not.toThrow();
  expect(() => zedJsonTokens('[' + text + ']')).toThrow(`JSON nesting depth limit exceeded (${ZED_JSON_MAX_DEPTH})`);
  const events = await collect([added(), delta('[' + text + ']'), ended(' [' + text + ']'), completed()]);
  expect(events.at(-1)).toMatchObject({ type: 'error', message: expect.stringContaining('nesting depth limit') });
  expect(events.some(e => e.type === 'tool_call_end' && !e.incomplete)).toBe(false);
});

for (const [left, right, equal] of [
  ['{"x":1}', '{ "x" : 1 }', true],
  ['{"x":1}', '{"x":1.0}', false],
  ['{"x":1}', '{"x":1e0}', false],
  ['{"x":1e0}', '{"x":1E0}', false],
  ['{"x":1,"y":2}', '{"y":2,"x":1}', false],
  ['{"x":1,"x":2}', '{"x":2}', false],
  ['{"x":"\\u0041"}', '{"\\u0078":"A"}', true],
  ['{"x":"\\ud83d\\ude00"}', '{"x":"😀"}', true],
  ['{"x":"\\ud800"}', '{"x":"\\ud801"}', false],
  ['{"x":"\\u00e9"}', '{"x":"e\\u0301"}', false],
  ['{"__proto__":1,"constructor":2}', '{ "__proto__": 1, "constructor": 2 }', true],
] as const) test(`lexical comparison and replay share tokens: ${left} -> ${right}`, async () => {
  expect(zedArgumentFingerprint(left, false) === zedArgumentFingerprint(right, false)).toBe(equal);
  const events = await collect([added(), delta(left), ended(right), completed([item(right)])]);
  expect(events.at(-1)?.type).toBe(equal ? 'done' : 'error');
});

for (const prefix of ['{"x":"\\', '{"x":"\\u', '{"x":"\\u0', '{"x":"\\u00', '{"x":"\\u004']) {
  test(`split Unicode escape can complete without rewriting delivered bytes: ${prefix}`, () => {
    const result = reconcileZedArguments(prefix, '{ "x": "A" }', false);
    expect(result?.startsWith(prefix)).toBe(true);
    expect(JSON.parse(result!)).toEqual({ x: 'A' });
  });
}

for (const text of ['0', '-0', '-123.45e+67', 'true', 'false', 'null', '[]', '{}', '{"x":[true,null,"a"]}']) {
  test(`valid JSON scanner survives every fragment boundary: ${text}`, () => {
    const expected = zedJsonTokens(text);
    for (let split = 0; split <= text.length; split++) {
      const actual: number[] = [];
      const scanner = new ZedJsonScanner(token => actual.push(token));
      scanner.push(text.slice(0, split)); scanner.push(text.slice(split)); scanner.finish();
      expect(actual).toEqual(Array.from(expected));
      expect(scanner.steps).toBe(text.length);
    }
  });
}

for (const text of ['', '01', '+1', '1.', '1e', '-', '[1,]', '{"x":}', '{"x",1}', '{x:1}', 'true false',
  '"\\v"', '"\\u000x"', '"\n"', '[}', '{]', '{"a":1,}', 'nullx', '1 2']) {
  test(`invalid lexical JSON fails without recursion: ${JSON.stringify(text)}`, () => {
    expect(() => zedJsonTokens(text)).toThrow();
  });
}

test('custom input fingerprints preserve exact bytes including lone surrogates', () => {
  expect(zedArgumentFingerprint('echo A', true)).not.toBe(zedArgumentFingerprint('echo  A', true));
  expect(zedArgumentFingerprint('\ud800', true)).not.toBe(zedArgumentFingerprint('\ud801', true));
});

test('cancelling after authority emission releases retained tokens and scanner state', async () => {
  const text = '{"x":"' + 'a'.repeat(65536) + '"}';
  const source = new Response([added(), argsDone(text)].map(event => 'data: ' + JSON.stringify(event) + '\n\n').join(''));
  const budget = createTranslatorBudget();
  const stream = translateZedOpenAiStream(source.body, budget);
  try {
    expect((await stream.next()).value).toMatchObject({ type: 'tool_call_start' });
    expect((await stream.next()).value).toMatchObject({ type: 'tool_call_delta', arguments: text });
    expect(budget.snapshot().currentBytes).toBeGreaterThan(text.length * 4);
  } finally {
    await stream.return();
    expect(budget.snapshot()).toMatchObject({ currentBytes: 0, activeCalls: 0 });
    budget.dispose();
  }
});
