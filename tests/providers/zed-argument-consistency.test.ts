import { expect, test } from 'bun:test';
import { translateZedOpenAiStream } from '../../src/adapters/zed-openai-stream';
import { zedEventStream } from '../../src/adapters/zed';
import { createTranslatorBudget, type TranslatorBudgetOptions } from '../../src/lib/translator-budget';
import { bridgeToResponsesSSE, buildResponseJSON } from '../../src/bridge';

async function collect(frames: unknown[], options?: TranslatorBudgetOptions) {
  const source = new Response(frames.map(event => JSON.stringify({event})+'\n').join('')+'{"status":"stream_ended"}\n').body!;
  const budget = createTranslatorBudget(options);
  try { return await Array.fromAsync(translateZedOpenAiStream(zedEventStream(source,'open_ai'),budget)); }
  finally { expect(budget.snapshot()).toMatchObject({currentBytes:0,activeCalls:0}); budget.dispose(); }
}
const item = (args: string) => ({type:'function_call',id:'a',call_id:'call',name:'shell',arguments:args,status:'completed'});
const added = {type:'response.output_item.added',item:{...item(''),status:'in_progress'}};
const delta = (args: string) => ({type:'response.function_call_arguments.delta',item_id:'a',delta:args});
const ended = (args: string) => ({type:'response.output_item.done',item:item(args)});
const completed = (output: unknown[] = []) => ({type:'response.completed',response:{output}});

for (const [label,streamed,final] of [
  ['whitespace','{"x":1}','{ "x": 1 }'],
  ['key order','{"x":1,"y":2}','{"y":2,"x":1}'],
  ['nested order','{"x":{"a":1,"b":2}}','{"x":{"b":2,"a":1}}'],
  ['partial with whitespace','{"x":','{ "x": 1 }'],
] as const) test(`function lexical snapshot consistency: ${label}`,async()=>{
  const events = await collect([added,delta(streamed),ended(final),completed()]);
  if (label.includes('order')) {
    expect(events.at(-1)?.type).toBe('error');
    expect(events.some(e => e.type === 'tool_call_end' && !e.incomplete)).toBe(false);
    return;
  }
  expect(events.at(-1)?.type).toBe('done');
  expect(events).toContainEqual({type:'tool_call_end'});
  expect(buildResponseJSON(events,'fixture').status).toBe('completed');
});

const argumentDeltas = (events: Awaited<ReturnType<typeof collect>>) =>
  events.filter(event => event.type === 'tool_call_delta').map(event => event.arguments).join('');

for (const [label, prefix, final] of [
  ['full whitespace', '{"x":1}', '{ "x": 1 }'],
  ['partial whitespace', '{"x":', '{ "x": 1 }'],
  ['partial string whitespace', '{"x":"a ', '{ "x": "a b" }'],
  ['nested key order', '{"x":{"a":1,"b":2}}', '{"x":{"b":2,"a":1}}'],
  ['array values', '[1,{"a":true,"b":null}]', '[1, {"b": null, "a": true}]'],
] as const) {
  for (const streaming of [false, true]) test(`function wire preserves delivered bytes: ${label}, stream=${streaming}`, async () => {
    const events = await collect([added, delta(prefix), ended(final), completed()]);
    if (label === 'nested key order' || label === 'array values') {
      expect(events.at(-1)?.type).toBe('error');
      expect(buildResponseJSON(events, 'fixture').status).toBe('failed');
      return;
    }
    const delivered = argumentDeltas(events);
    expect(delivered.startsWith(prefix)).toBe(true);
    expect(JSON.parse(delivered)).toEqual(JSON.parse(final));
    let result = buildResponseJSON(events, 'fixture');
    if (streaming) {
      const wire = await new Response(bridgeToResponsesSSE((async function* () { yield* events; })(), 'fixture')).text();
      result = wire.split('\n').filter(line => line.startsWith('data: {')).map(line => JSON.parse(line.slice(6)))
        .findLast(event => event.type === 'response.completed')?.response;
    }
    expect(result.status).toBe('completed');
    expect(result.output).toContainEqual(expect.objectContaining({ type: 'function_call', arguments: delivered, status: 'completed' }));
  });
}

for (const [first, full, late] of [
  ['{"x":', '{"x":1}', ' 1}'],
  ['{"x":1}', '{ "x": 1 }', ' '],
  ['', '{"x":1,"y":2}', '{"y":2,"x":1}'],
] as const) test(`late equivalent function bytes never rewrite delivered input: ${JSON.stringify(late)}`, async () => {
  const events = await collect([added, delta(first),
    { type: 'response.function_call_arguments.done', item_id: 'a', arguments: full },
    delta(late), ended(full), completed()]);
  if (first === '') {
    expect(events.at(-1)?.type).toBe('error');
    expect(events.some(e => e.type === 'tool_call_end' && !e.incomplete)).toBe(false);
    return;
  }
  expect(events.at(-1)?.type).toBe('done');
  const delivered = argumentDeltas(events);
  expect(JSON.parse(delivered)).toEqual(JSON.parse(full));
  expect(delivered).toBe(first === '' ? full : first === '{"x":' ? '{"x":1}' : first);
});

for (const kind of ['function_call', 'custom_tool_call'] as const) {
  const field = kind === 'function_call' ? 'arguments' : 'input';
  const event = kind === 'function_call' ? 'response.function_call_arguments' : 'response.custom_tool_call_input';
  for (const parallel of [false, true]) {
    for (const contradictory of ['{"x":2}', '{"x":1} extra']) test(`${kind} refuses late contradiction with zero/visible emission: ${parallel}, ${contradictory}`, async () => {
      const target = { type: kind, id: 'b', call_id: 'call-b', name: 'fixture_tool', [field]: '' };
      const events = await collect([
        ...(parallel ? [added] : []),
        { type: 'response.output_item.added', item: target },
        { type: `${event}.done`, item_id: 'b', [field]: '{"x":1}' },
        { type: `${event}.delta`, item_id: 'b', delta: contradictory },
        ...(parallel ? [delta('{}'), ended('{}')] : []), completed(),
      ]);
      expect(events.at(-1)?.type).toBe('error');
      expect(events.some(value => value.type === 'tool_call_end' && !value.incomplete)).toBe(false);
      expect(events).toContainEqual({ type: 'tool_call_end', incomplete: true });
    });
  }
  test(`${kind} accepts identical late delivery behind a parallel call`, async () => {
    const target = { type: kind, id: 'b', call_id: 'call-b', name: 'fixture_tool', [field]: '' };
    const events = await collect([added, { type: 'response.output_item.added', item: target },
      { type: `${event}.done`, item_id: 'b', [field]: '{"x":1}' },
      { type: `${event}.delta`, item_id: 'b', delta: '{"x":1}' },
      delta('{}'), ended('{}'), completed()]);
    expect(events.at(-1)?.type).toBe('done');
    expect(events.filter(value => value.type === 'tool_call_end' && !value.incomplete)).toHaveLength(2);
  });
  test(`${kind} refuses extension of authoritative empty input without an added item`, async () => {
    const events = await collect([
      { type: `${event}.done`, item_id: 'a', [field]: '' },
      { type: `${event}.delta`, item_id: 'a', delta: '{}' },
      { type: 'response.output_item.done', item: { type: kind, id: 'a', name: 'fixture_tool', [field]: '{}' } },
      completed(),
    ]);
    expect(events.at(-1)?.type).toBe('error');
    expect(events.some(value => value.type === 'tool_call_end' && !value.incomplete)).toBe(false);
  });
}

for (const conflicting of ['{"x":2}', '{"x":', '{"x":"1"}', '[1,2]', '{"x":1} trailing']) {
  test(`completed function replay rejects changed or malformed values: ${conflicting}`, async () => {
    const events = await collect([added, delta('{"x":1}'), ended('{"x":1}'), completed([item(conflicting)])]);
    expect(events.at(-1)?.type).toBe('error');
    expect(events.filter(value => value.type === 'tool_call_end')).toHaveLength(1);
  });
}

test('semantic argument reconstruction still enforces the call ceiling and releases every lease', async () => {
  await expect(collect([added, delta('{"x":'), ended('{ "x": "long value" }'), completed()],
    { maxCallArgumentBytes: 12 })).rejects.toMatchObject({ name: 'TranslatorBudgetExceededError' });
});

test('semantic replay fingerprint distinguishes overflowing JSON numbers from null and opposite infinity', async () => {
  for (const conflicting of ['{"x":null}', '{"x":-1e400}']) {
    const events = await collect([added, delta('{"x":1e400}'), ended('{"x":1e400}'), completed([item(conflicting)])]);
    expect(events.at(-1)?.type).toBe('error');
  }
});

for (const parallel of [false, true]) test(`late reordered function JSON conflicts across split token boundaries (parallel=${parallel})`, async () => {
  const target = { ...item(''), id: 'b', call_id: 'call-b' };
  const events = await collect([
    ...(parallel ? [added] : []), { type: 'response.output_item.added', item: target },
    { type: 'response.function_call_arguments.done', item_id: 'b', arguments: '{"x":1,"y":2}' },
    ...['{"y":2,', '"x":1}'].map(value => ({ type: 'response.function_call_arguments.delta', item_id: 'b', delta: value })),
    ...(parallel ? [delta('{}'), ended('{}')] : []), completed(),
  ]);
  expect(events.at(-1)?.type).toBe('error');
  expect(events.some(value => value.type === 'tool_call_end' && !value.incomplete)).toBe(false);
});

test('malformed function replay cannot impersonate the canonical fingerprint input', async () => {
  const events = await collect([added, delta('{}'), ended('{}'), completed([item('object:0:')])]);
  expect(events.at(-1)?.type).toBe('error');
});

for (const [full, late] of [
  ['{"x":1,"y":2}', '{"y":2,"x":1}'],
  ['{"x":{"a":1,"b":2},"y":[true,null]}', '{"y":[true,null],"x":{"b":2,"a":1}}'],
  ['{"x":"a b"}', '{"\\u0078":"\\u0061 b"}'],
  ['{"x":"a\\\"\\\\b\\n"}', '{"x":"a\\u0022\\u005cb\\u000a"}'],
] as const) {
  for (const parallel of [false, true]) test(`late equivalent JSON survives single-character fragments: ${late}, parallel=${parallel}`, async () => {
    const target = { ...item(''), id: 'b', call_id: 'call-b' };
    const events = await collect([...(parallel ? [added] : []),
      { type: 'response.output_item.added', item: target },
      { type: 'response.function_call_arguments.done', item_id: 'b', arguments: full },
      ...late.split('').map(value => ({ type: 'response.function_call_arguments.delta', item_id: 'b', delta: value })),
      ...(parallel ? [delta('{}'), ended('{}')] : []), completed()]);
    if (full.includes('"y"')) {
      expect(events.at(-1)?.type).toBe('error');
      expect(events.some(value => value.type === 'tool_call_end' && !value.incomplete)).toBe(false);
      return;
    }
    expect(events.at(-1)?.type).toBe('done');
    expect(events.filter(value => value.type === 'tool_call_end' && !value.incomplete)).toHaveLength(parallel ? 2 : 1);
    expect(buildResponseJSON(events, 'fixture').output).toContainEqual(expect.objectContaining({ call_id: 'call-b', arguments: full, status: 'completed' }));
  });
}

for (const late of ['{"y":3,', '{"unknown":', '{"y":[', '{"x":"wrong', '{"y":2 "x"', '{"x":1,"x":']) {
  test(`partial semantic input rejects proven contradictions: ${late}`, async () => {
    const events = await collect([added,
      { type: 'response.function_call_arguments.done', item_id: 'a', arguments: '{"x":1,"y":2}' },
      delta(late), completed()]);
    expect(events.at(-1)?.type).toBe('error');
    expect(events.some(value => value.type === 'tool_call_end' && !value.incomplete)).toBe(false);
  });
}

test('raw function arguments cannot impersonate a later parsed JSON replay', async () => {
  const events = await collect([added, delta('object:0:'), ended('object:0:'), completed([item('{}')])]);
  expect(events.at(-1)?.type).toBe('error');
});

for (const streaming of [false, true]) test(`split reordered late JSON fails client projection (stream=${streaming})`, async () => {
  const events = await collect([added,
    { type: 'response.function_call_arguments.done', item_id: 'a', arguments: '{"x":1,"y":2}' },
    delta('{"y":2,'), delta('"x":1}'), ended('{"x":1,"y":2}'), completed()]);
  let result = buildResponseJSON(events, 'fixture');
  if (streaming) {
    const wire = await new Response(bridgeToResponsesSSE((async function* () { yield* events; })(), 'fixture')).text();
    result = wire.split('\n').filter(line => line.startsWith('data: {')).map(line => JSON.parse(line.slice(6)))
      .findLast(event => event.type === 'response.failed')?.response;
  }
  expect(result.status).toBe('failed');
  expect(result.output).toContainEqual(expect.objectContaining({ type: 'function_call', status: 'incomplete' }));
});

for (const [full, pieces] of [
  ['0.25', ['2', '.5e-1']],
  ['{"x":1}', ['{"x":1,"', 'x":1}']],
] as const) test(`changed numeric or duplicate-member serialization conflicts across fragments: ${full}`, async () => {
  const events = await collect([added,
    { type: 'response.function_call_arguments.done', item_id: 'a', arguments: full },
    ...pieces.map(value => delta(value)), completed()]);
  expect(events.at(-1)?.type).toBe('error');
  expect(events.some(e => e.type === 'tool_call_end' && !e.incomplete)).toBe(false);
});

for (const [full, late] of [['{"x":[1]}', '{"x":[1,'], ['{"x":1}', '{"x":1.e']] as const) {
  test(`impossible late prefix cannot reach executable closure: ${late}`, async () => {
    const events = await collect([added,
      { type: 'response.function_call_arguments.done', item_id: 'a', arguments: full }, delta(late), completed()]);
    expect(events.at(-1)?.type).toBe('error');
    expect(events.some(value => value.type === 'tool_call_end' && !value.incomplete)).toBe(false);
  });
}

test('signed zero is distinct in both complete comparison and completed replay', async () => {
  for (const frames of [
    [added, delta('{"x":-0}'), ended('{"x":0}'), completed()],
    [added, delta('{"x":-0}'), ended('{"x":-0}'), completed([item('{"x":0}')])],
    [added, { type: 'response.function_call_arguments.done', item_id: 'a', arguments: '{"x":-0}' },
      { type: 'response.function_call_arguments.done', item_id: 'a', arguments: '{"x":0}' }, completed()],
  ]) expect((await collect(frames)).at(-1)?.type).toBe('error');
});

test('reordered response replay after item completion fails the turn',async()=>{
  const events = await collect([added,delta('{"x":1,"y":2}'),ended('{"x":1,"y":2}'),completed([item('{"y":2,"x":1}')])]);
  expect(events.at(-1)?.type).toBe('error');
  expect(buildResponseJSON(events,'fixture').status).toBe('failed');
});

test('parallel buffered function rejects a reordered final JSON snapshot',async()=>{
  const b={...item(''),id:'b',call_id:'call-b'};
  const events=await collect([added,{type:'response.output_item.added',item:b},
    {type:'response.function_call_arguments.delta',item_id:'b',delta:'{"x":1,"y":2}'},
    {type:'response.output_item.done',item:{...b,arguments:'{"y":2,"x":1}'}},
    delta('{}'),ended('{}'),completed()]);
  expect(events.at(-1)?.type).toBe('error');
  expect(events.some(e=>e.type==='tool_call_end'&&!e.incomplete)).toBe(false);
});

test('custom input must not extend beyond authoritative input.done before response completion',async()=>{
  const custom={type:'custom_tool_call',id:'a',call_id:'call',name:'shell',input:'',status:'in_progress'};
  const events=await collect([{type:'response.output_item.added',item:custom},
    {type:'response.custom_tool_call_input.delta',item_id:'a',delta:'echo'},
    {type:'response.custom_tool_call_input.done',item_id:'a',input:'echo safe'},
    {type:'response.custom_tool_call_input.delta',item_id:'a',delta:' safe; destructive'},completed()]);
  expect(events.some(e=>e.type==='tool_call_end'&&!e.incomplete)).toBe(false);
  expect(events.at(-1)?.type).toBe('error');
});

test('custom full-input contradiction is detected even while another call blocks emission',async()=>{
  const custom={type:'custom_tool_call',id:'b',call_id:'call-b',name:'shell',input:'',status:'in_progress'};
  const events=await collect([added,{type:'response.output_item.added',item:custom},
    {type:'response.custom_tool_call_input.done',item_id:'b',input:'echo safe'},
    {type:'response.custom_tool_call_input.delta',item_id:'b',delta:'echo other'},
    delta('{}'),ended('{}'),completed()]);
  expect(events.at(-1)?.type).toBe('error');
  expect(events.filter(e=>e.type==='tool_call_start'&&e.id==='call-b')).toHaveLength(1);
  const at=events.findIndex(e=>e.type==='tool_call_start'&&e.id==='call-b');
  expect(events.slice(at).some(e=>e.type==='tool_call_end'&&!e.incomplete)).toBe(false);
});

test('success preserves every known counter and opaque success usage through both bridges',async()=>{
  const usage={input_tokens:11,output_tokens:7,total_tokens:18,
    input_tokens_details:{cached_tokens:3,cache_write_tokens:4,cache_write_1h_tokens:2},
    output_tokens_details:{reasoning_tokens:5},vendor:{fixture:'safe'}};
  const events=await collect([{type:'response.completed',response:{output:[],usage}}]);
  expect(events.at(-1)).toMatchObject({type:'done',usage:{inputTokens:11,outputTokens:7,totalTokens:18,
    cachedInputTokens:3,cacheCreationInputTokens:4,cacheCreation1hInputTokens:2,reasoningOutputTokens:5,rawUsage:usage}});
  expect(buildResponseJSON(events,'fixture').usage).toMatchObject(usage);
  const wire=await new Response(bridgeToResponsesSSE((async function*(){yield* events;})(),'fixture')).text();
  expect(wire).toContain('"cache_write_1h_tokens":2');
  expect(wire).toContain('"vendor":{"fixture":"safe"}');
});

test('literal prefix function completion remains successful',async()=>{
  const events=await collect([added,delta('{"x":'),ended('{"x":1}'),completed()]);
  expect(events.at(-1)?.type).toBe('done');
});

test('custom whitespace differences remain genuine conflicts',async()=>{
  const custom={type:'custom_tool_call',id:'a',call_id:'call',name:'shell',input:'',status:'in_progress'};
  const events=await collect([{type:'response.output_item.added',item:custom},
    {type:'response.custom_tool_call_input.delta',item_id:'a',delta:'echo a'},
    {type:'response.output_item.done',item:{...custom,status:'completed',input:'echo  a'}},completed()]);
  expect(events.at(-1)?.type).toBe('error');
  expect(events.some(e=>e.type==='tool_call_end'&&!e.incomplete)).toBe(false);
});

for (const streaming of [false,true]) test(`wire projection refuses changed custom input after input.done (stream=${streaming})`,async()=>{
  const custom={type:'custom_tool_call',id:'a',call_id:'call',name:'fixture_custom',input:'',status:'in_progress'};
  const events=await collect([{type:'response.output_item.added',item:custom},
    {type:'response.custom_tool_call_input.delta',item_id:'a',delta:'echo'},
    {type:'response.custom_tool_call_input.done',item_id:'a',input:'echo safe'},
    {type:'response.custom_tool_call_input.delta',item_id:'a',delta:' safe; destructive'},completed()]);
  const freeform=new Set(['fixture_custom']);
  let result: any;
  if(streaming){
    const text=await new Response(bridgeToResponsesSSE((async function*(){yield* events;})(),'fixture',undefined,freeform)).text();
    result=text.split('\n').filter(line=>line.startsWith('data: {')).map(line=>JSON.parse(line.slice(6)))
      .findLast(event=>['response.completed','response.failed','response.incomplete'].includes(event.type))?.response;
  }else result=buildResponseJSON(events,'fixture',{freeformToolNames:freeform});
  expect(result.output).toContainEqual(expect.objectContaining({type:'custom_tool_call',call_id:'call',status:'incomplete'}));
  expect(result.status).toBe('failed');
});
