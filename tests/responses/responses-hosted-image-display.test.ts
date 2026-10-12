import { expect, test } from 'bun:test';
import { existsSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { isAbsolute } from "node:path";
import { beforeEach, afterEach } from "bun:test";
import { createTempHome, type TempHome } from "../helpers/temp-home";
import { item } from "../fixtures/hosted-image-display";
import { createHostedImageDisplayRewrite as factory, isLocalCodexImageClient, redactHostedImageDisplayPaths } from "../../src/server/responses-hosted-image-display";
let home: TempHome;
beforeEach(() => { home = createTempHome("hosted-image-display-"); });
afterEach(() => { home.remove(); });

const block = (event: unknown) => 'data: ' + JSON.stringify(event);
const events = (blocks: readonly string[]) => blocks.map(b => JSON.parse(b.split('data: ')[1]));

test('completed hosted image becomes a visible message pointing to identical saved bytes', () => {
  const rewrite = factory();
  const result = events(rewrite(block({ type: 'response.output_item.done', output_index: 0, item })));
  const message = result.find(e => e.type === 'response.output_item.done')?.item;
  expect(message?.type).toBe('message');
  expect(message?.phase).toBe('final_answer');
  const path = message.content[0].text.match(/!\[.*?\]\(<(.*?)>\)/)?.[1];
  expect(isAbsolute(path)).toBe(true);
  expect(readFileSync(path)).toEqual(Buffer.from(item.result, 'base64'));
  const terminal = events(rewrite(block({ type: 'response.completed', response: { status: 'completed', output: [item] } })));
  expect(terminal.at(-1).response.output[0]).toEqual(message);
  expect(terminal.filter(e => e.type === 'response.output_item.done')).toHaveLength(0);
  rewrite.dispose?.();
});

test('added/done/terminal have one consistent message identity and monotonic sequence numbers', () => {
  const rewrite = factory();
  const values = [
    { type: 'response.output_item.added', sequence_number: 0, output_index: 0, item: { ...item, status: 'in_progress', result: null } },
    { type: 'response.image_generation_call.in_progress', sequence_number: 1, output_index: 0, item_id: item.id },
    { type: 'response.output_item.done', sequence_number: 2, output_index: 0, item },
    { type: 'response.completed', sequence_number: 3, response: { status: 'completed', output: [item] } },
  ];
  const result = values.flatMap(e => events(rewrite(block(e))));
  expect(result.map(e => e.sequence_number)).toEqual(result.map((_, i) => i));
  expect(result.filter(e => e.type === 'response.output_item.added')).toHaveLength(1);
  expect(result.filter(e => e.type === 'response.output_item.done')).toHaveLength(1);
  const done = result.find(e => e.type === 'response.output_item.done').item;
  expect(result[0].item.phase).toBe('final_answer');
  expect(done.phase).toBe('final_answer');
  expect(result[0].item.id).toBe(done.id);
  expect(result.at(-1).response.output[0]).toEqual(done);
  expect(result.find(e => e.type === 'response.output_text.delta').delta).toBe(done.content[0].text);
  rewrite.dispose?.();
});

test('image events without an identity pass through without consuming shared state', () => {
  const rewrite = factory();
  try {
    for (const output_index of [undefined, -1, 0.5, '0', null]) {
      for (const id of [undefined, 123]) {
        for (const type of ['response.output_item.added', 'response.output_item.done']) {
          const value = block({ type, output_index, item: { ...item, id } });
          expect(rewrite(value)).toEqual([value]);
        }
      }
    }
    expect(existsSync(home.path('artifacts'))).toBe(false);
    const result = events(rewrite(block({ type: 'response.output_item.done', output_index: 0,
      item: { ...item, id: undefined } })));
    expect(result.at(-1).item.type).toBe('message');
    expect(result.at(-1).output_index).toBe(0);
    expect(readdirSync(home.path('artifacts'))).toHaveLength(1);
  } finally { rewrite.dispose?.(); }
});

test('image events with either an index or a string id retain distinct display state', () => {
  const rewrite = factory();
  try {
    const results = [
      { output_index: 1, item: { ...item, id: undefined } },
      { output_index: 2, item: { ...item, id: undefined } },
      { item },
      { item: { ...item, id: 'ig_second' } },
    ].map(value => {
      const added = events(rewrite(block({ ...value, type: 'response.output_item.added' })))[0].item;
      const done = events(rewrite(block({ ...value, type: 'response.output_item.done' }))).at(-1).item;
      expect(done.id).toBe(added.id);
      expect(done.type).toBe('message');
      return done.id;
    });
    expect(new Set(results).size).toBe(4);
    expect(readdirSync(home.path('artifacts'))).toHaveLength(4);
  } finally { rewrite.dispose?.(); }
});

test('terminal-only responses emit the missing complete message lifecycle', () => {
  const rewrite = factory();
  const result = events(rewrite(block({ type: 'response.completed', response: { status: 'completed', output: [item] } })));
  expect(result.map(e => e.type)).toEqual([
    'response.output_item.added', 'response.content_part.added', 'response.output_text.delta',
    'response.output_text.done', 'response.content_part.done', 'response.output_item.done', 'response.completed',
  ]);
  expect(result[0].item.phase).toBe('final_answer');
  expect(result.at(-1).response.output[0].phase).toBe('final_answer');
  rewrite.dispose?.();
});

test('invalid image bytes produce a visible failure, never false success or raw data', () => {
  const rewrite = factory();
  const result = events(rewrite(block({ type: 'response.output_item.done', output_index: 0, item: { ...item, result: 'invalid-secret-looking-data' } })));
  const message = result.at(-1).item;
  expect(message.status).toBe('incomplete');
  expect(message.content[0].text).toContain('could not be saved');
  expect(JSON.stringify(result)).not.toContain('invalid-secret-looking-data');
  rewrite.dispose?.();
});

test('text and ordinary tool calls remain byte-identical', () => {
  const rewrite = factory();
  for (const value of [
    { type: 'response.output_item.done', item: { type: 'function_call', name: 'imagegen', namespace: 'image_gen', arguments: '{}' } },
    { type: 'response.output_text.delta', delta: '你好', sequence_number: 4 },
    { type: 'response.completed', response: { status: 'completed', output: [] }, sequence_number: 5 },
  ]) expect(rewrite(block(value))).toEqual([block(value)]);
  expect(rewrite('data: [DONE]')).toEqual(['data: [DONE]']);
  rewrite.dispose?.();
});

test('non-streaming results have the same visible artifact contract', () => {
  const rewrite = factory();
  const result = JSON.parse(rewrite.json(JSON.stringify({ status: 'completed', output: [item] })));
  expect(result.output[0].type).toBe('message');
  expect(result.output[0].phase).toBe('final_answer');
  expect(result.output[0].content[0].text).toContain('![Generated image]');
  rewrite.dispose?.();
});

test('filesystem paths are never enabled for remote or generic API clients', async () => {
  const codex = new Headers({ originator: 'Codex Desktop' });
  expect(isLocalCodexImageClient(codex, 'loopback')).toBe(true);
  expect(isLocalCodexImageClient(codex, 'configured')).toBe(false);
  expect(isLocalCodexImageClient(new Headers(), 'loopback')).toBe(false);
  expect(isLocalCodexImageClient(codex, 'loopback', 'anthropic')).toBe(false);
  expect(isLocalCodexImageClient(codex)).toBe(false);
  expect(isLocalCodexImageClient(new Headers({ 'user-agent': 'codex_cli_rs/1.0' }), 'loopback')).toBe(true);
  expect(isLocalCodexImageClient(new Headers({ 'user-agent': 'not-codex' }), 'loopback')).toBe(false);
});

test('multiple images keep distinct identities and create one artifact per image', () => {
  const rewrite = factory();
  try {
    const images = [item, { ...item, id: 'ig_second' }];
    const response = { status: 'completed', output: images };
    const first = JSON.parse(rewrite.json(JSON.stringify(response)));
    const second = JSON.parse(rewrite.json(JSON.stringify(response)));
    expect(first).toEqual(second);
    expect(first.output[0].id).not.toBe(first.output[1].id);
    expect(first.output[0].content).not.toEqual(first.output[1].content);
    expect(readdirSync(home.path('artifacts'))).toHaveLength(2);
    expect(response.output).toEqual(images);
    for (const message of first.output) expect(message.phase).toBe('final_answer');
  } finally { rewrite.dispose?.(); }
});

test('a failed disk write returns a bounded message without leaking filesystem details', () => {
  writeFileSync(home.path('artifacts'), 'not a directory');
  const rewrite = factory();
  try {
    const output = JSON.parse(rewrite.json(JSON.stringify({ output: [item] }))).output[0];
    expect(output.status).toBe('incomplete');
    expect(output.content[0].text).toBe('The image result could not be saved for local display.');
    expect(JSON.stringify(output)).not.toContain(home.root);
    expect(JSON.stringify(output)).not.toContain(item.result);
  } finally { rewrite.dispose?.(); }
});

test('incomplete and failed terminals retain their status without claiming an image', () => {
  for (const status of ['incomplete', 'failed']) {
    const rewrite = factory();
    try {
      const result = events(rewrite(block({
        type: 'response.' + status,
        response: { status, output: [{ ...item, status, result: null }] },
      })));
      const response = result.at(-1).response;
      expect(response.status).toBe(status);
      expect(response.output[0].status).toBe('incomplete');
      expect(response.output[0].phase).toBe('final_answer');
      expect(response.output[0].content[0].text).not.toContain('![');
    } finally { rewrite.dispose?.(); }
  }
});

test('preserves routing metadata on the displayed message', () => {
  const rewrite = factory();
  try {
    const metadata = { synthetic: true };
    const response = JSON.parse(rewrite.json(JSON.stringify({
      output: [{ ...item, internal_chat_message_metadata_passthrough: metadata }],
    })));
    expect(response.output[0].internal_chat_message_metadata_passthrough).toEqual(metadata);
  } finally { rewrite.dispose?.(); }
});

test('completed URL-only or missing image data is reported without claiming generation failed', () => {
  for (const extra of [{ url: 'https://example.test/image.png' }, {}]) {
    const rewrite = factory();
    try {
      const unsupported = { ...item, result: null, ...extra };
      const added = events(rewrite(block({ type: 'response.output_item.added', output_index: 0,
        item: { ...unsupported, status: 'in_progress' } })))[0].item;
      const done = events(rewrite(block({ type: 'response.output_item.done', output_index: 0, item: unsupported }))).at(-1).item;
      expect(done.id).toBe(added.id);
      expect(done.content[0].text).toBe('The completed image result has no supported image data for local display.');
      expect(done.status).toBe('incomplete');
      expect(JSON.parse(rewrite.json(JSON.stringify({ output: [unsupported] }))).output[0]).toEqual(done);
      expect(JSON.stringify(done)).not.toContain('https://');
    } finally { rewrite.dispose?.(); }
  }
});

test('oversized JSON snapshots are rejected before creating any image artifacts', () => {
  const rewrite = factory();
  try {
    const output = Array.from({ length: 129 }, (_, i) => ({ ...item, id: 'ig_limit_' + i }));
    expect(() => rewrite.json(JSON.stringify({ output }))).toThrow('hosted image result count exceeds local display limit');
    expect(existsSync(home.path('artifacts'))).toBe(false);
  } finally { rewrite.dispose?.(); }
});

test('non-image JSON and malformed SSE pass through unchanged', () => {
  const rewrite = factory();
  try {
    for (const text of ['not json', 'null', '[]', '{ "output": [] }']) {
      expect(rewrite.json(text)).toBe(text);
    }
    for (const value of ['data: {', ': heartbeat', 'data: null', 'data: []']) {
      expect(rewrite(value)).toEqual([value]);
    }
  } finally { rewrite.dispose?.(); }
});

test('replay redaction survives pruning and preserves unrelated paths, roles and tool payloads', () => {
  const rewrite = factory();
  try {
    const message = JSON.parse(rewrite.json(JSON.stringify({ output: [item] }))).output[0];
    const text = message.content[0].text;
    const path = text.match(/<([^>]+)>/)[1];
    unlinkSync(path);
    const unrelated = '![Generated image](<' + home.path('private.png') + '>)';
    const unowned = text.replace('img-codex-', 'img-other-');
    const body = { input: [
      { role: 'assistant', content: [{ type: 'input_text', text: text + '\n' + unrelated + '\n' + unowned }] },
      { role: 'user', content: text },
      { type: 'function_call_output', output: text },
    ] };
    redactHostedImageDisplayPaths(body);
    const cleaned = body.input[0].content as Array<{ text: string }>;
    expect(cleaned[0].text).not.toContain(path);
    expect(cleaned[0].text).toContain('/v1/opencodex/artifacts/img-codex-');
    expect(cleaned[0].text).toContain(unrelated);
    expect(cleaned[0].text).toContain(unowned);
    expect(body.input[1].content).toBe(text);
    expect(body.input[2].output).toBe(text);
    const first = JSON.stringify(body);
    redactHostedImageDisplayPaths(body);
    expect(JSON.stringify(body)).toBe(first);
    for (const malformed of [null, [], {}, { input: [null, false, { role: 'assistant', content: [null, {}] }] }]) {
      expect(() => redactHostedImageDisplayPaths(malformed)).not.toThrow();
    }
  } finally { rewrite.dispose?.(); }
});

test('replay redaction recognizes file URLs, either separator and folded case only where the platform folds it', () => {
  const rewrite = factory();
  try {
    const text = JSON.parse(rewrite.json(JSON.stringify({ output: [item] }))).output[0].content[0].text;
    const path: string = text.match(/<([^>]+)>/)[1];
    const forward = path.replace(/\\/g, '/');
    const name = forward.slice(forward.lastIndexOf('/') + 1);
    const dir = forward.slice(0, forward.lastIndexOf('/'));
    const link = (value: string) => '![Generated image](<' + value + '>)';
    const reference = link('/v1/opencodex/artifacts/' + name);
    const run = (value: string, platform: NodeJS.Platform) => {
      const body = { input: [{ type: 'message', role: 'assistant', content: link(value) }] };
      redactHostedImageDisplayPaths(body, platform);
      return body.input[0]!.content;
    };
    const fileUrl = 'file://' + (forward.startsWith('/') ? '' : '/') + encodeURI(forward);
    for (const platform of ['linux', 'darwin', 'win32'] as const) {
      for (const value of [path, forward, forward.replace(/\//g, '\\'), fileUrl, 'FILE://localhost' + fileUrl.slice(7),
        dir + '/./' + name, dir + '/../artifacts/' + name]) {
        expect(run(value, platform)).toBe(reference);
      }
    }
    for (const platform of ['darwin', 'win32'] as const) expect(run(forward.toUpperCase(), platform)).toBe(reference);
    const unchanged = [
      forward.toUpperCase(),
      dir + '/nested/' + name,
      dir + '-other/' + name,
      dir + '/' + name.replace('img-codex-', 'img-other-'),
      dir + '/' + name + '.txt',
      'file://' + forward.replace(name, '%E0%A4%A'),
      name,
    ];
    for (const value of unchanged) expect(run(value, 'linux')).toBe(link(value));
    const user = { input: [{ role: 'user', content: link(fileUrl) }, { type: 'function_call_output', output: link(fileUrl) }] };
    redactHostedImageDisplayPaths(user, 'darwin');
    expect(JSON.stringify(user)).toContain(fileUrl);
  } finally { rewrite.dispose?.(); }
});
