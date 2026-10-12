import { afterEach, beforeEach, expect, test } from 'bun:test';
import { existsSync, readdirSync } from 'node:fs';
import { createTempHome, type TempHome } from '../helpers/temp-home';
import { item } from '../fixtures/hosted-image-display';
import { createHostedImageDisplayRewrite as factory } from '../../src/server/responses-hosted-image-display';
import { TRANSLATOR_MAX_TURN_BYTES } from '../../src/lib/translator-budget';

let home: TempHome;
beforeEach(() => { home = createTempHome('hosted-image-limits-'); });
afterEach(() => { home.remove(); });
const block = (event: unknown) => 'data: ' + JSON.stringify(event);
const failed = { ...item, status: 'failed', result: null };

for (const format of ['json', 'terminal', 'snapshot'] as const) {
  for (const conflict of ['duplicate', 'non-image'] as const) {
    test(`${format} refuses ${conflict} snapshot identities before saving artifacts`, () => {
      const rewrite = factory();
      const output = [item, conflict === 'duplicate' ? { ...item, status: 'failed', result: null }
        : { id: item.id, type: 'message', role: 'assistant', content: [] }];
      try {
        expect(() => format === 'json' ? rewrite.json(JSON.stringify({ output }))
          : rewrite(block({ type: format === 'terminal' ? 'response.completed' : 'response.in_progress', response: { output } })))
          .toThrow();
        expect(existsSync(home.path('artifacts'))).toBe(false);
      } finally { rewrite.dispose?.(); }
    });
  }
}

test('the reported oversized repeated failed-item snapshot is refused', () => {
  const rewrite = factory();
  const output = Array.from({ length: 256 }, (_, index) => ({ ...failed,
    ...(index === 0 ? { internal_chat_message_metadata_passthrough: { value: 'x'.repeat(256 * 1024) } } : {}),
  }));
  try {
    expect(() => rewrite.json(JSON.stringify({ output }))).toThrow();
    expect(existsSync(home.path('artifacts'))).toBe(false);
  } finally { rewrite.dispose?.(); }
});

test('failed lifecycle reuse charges metadata once per distinct identity', () => {
  const rewrite = factory();
  const metadata = { value: 'x'.repeat(60 * 1024) };
  const image = (index: number) => ({ ...failed, id: 'retained_' + index,
    internal_chat_message_metadata_passthrough: metadata });
  try {
    const first = image(0);
    const emitted = [
      { type: 'response.output_item.added', output_index: 0, item: { ...first, status: 'in_progress' } },
      { type: 'response.output_item.done', output_index: 0, item: first },
      { type: 'response.completed', response: { output: [first] } },
    ].flatMap(event => rewrite(block(event))).map(value => JSON.parse(value.split('data: ')[1]!));
    const done = emitted.find(event => event.type === 'response.output_item.done').item;
    expect(done.internal_chat_message_metadata_passthrough).toEqual(metadata);
    expect(emitted.at(-1).response.output[0]).toEqual(done);
    expect(emitted.filter(event => event.type === 'response.output_item.done')).toHaveLength(1);
    // Sixteen unique items retain about 960 KiB. Recharging lifecycle repeats would overflow.
    expect(() => {
      for (let index = 1; index < 16; index++) {
        rewrite(block({ type: 'response.output_item.done', output_index: index, item: image(index) }));
      }
    }).not.toThrow();
    // Seventeen still fit (including identity/envelope bytes); eighteen exceed the 1 MiB cap.
    expect(() => { rewrite(block({ type: 'response.output_item.done', output_index: 16, item: image(16) })); }).not.toThrow();
    expect(() => { rewrite(block({ type: 'response.output_item.done', output_index: 17, item: image(17) })); })
      .toThrow('hosted image result exceeds local display limits');
    expect(existsSync(home.path('artifacts'))).toBe(false);
  } finally { rewrite.dispose?.(); }
});

for (const format of ['json', 'added', 'done', 'terminal'] as const) {
  test(`${format} refuses oversized failed-item metadata without artifacts`, () => {
    const rewrite = factory();
    const large = { ...failed, internal_chat_message_metadata_passthrough: { value: 'x'.repeat(256 * 1024) } };
    try {
      expect(() => format === 'json' ? rewrite.json(JSON.stringify({ output: [item, large] }))
        : rewrite(block(format === 'terminal' ? { type: 'response.failed', response: { output: [item, large] } }
          : { type: 'response.output_item.' + format, output_index: 0, item: large }))).toThrow();
      expect(existsSync(home.path('artifacts'))).toBe(false);
    } finally { rewrite.dispose?.(); }
  });
}

test('cached items still validate incoming metadata before early lifecycle returns', () => {
  const rewrite = factory();
  try {
    rewrite(block({ type: 'response.output_item.done', output_index: 0, item: failed }));
    const large = { ...failed, internal_chat_message_metadata_passthrough: '\u0000'.repeat(12 * 1024) };
    expect(() => rewrite(block({ type: 'response.output_item.done', output_index: 0, item: large }))).toThrow();
    expect(existsSync(home.path('artifacts'))).toBe(false);
  } finally { rewrite.dispose?.(); }
});

test('retained identity and aggregate metadata are bounded before snapshot artifacts', () => {
  for (const output of [
    [item, { ...failed, id: 'x'.repeat(128 * 1024) }],
    Array.from({ length: 18 }, (_, index) => ({ ...item, id: 'image_' + index,
      internal_chat_message_metadata_passthrough: { value: 'x'.repeat(60 * 1024) } })),
  ]) {
    const rewrite = factory();
    try {
      expect(() => rewrite.json(JSON.stringify({ output }))).toThrow();
      expect(existsSync(home.path('artifacts'))).toBe(false);
    } finally { rewrite.dispose?.(); }
  }
});

for (const format of ['json', 'terminal'] as const) {
  test(`${format} preflights cached metadata expansion before saving artifacts`, () => {
    const rewrite = factory();
    try {
      rewrite(block({ type: 'response.output_item.added', output_index: 0,
        item: { ...item, status: 'in_progress', result: null,
          internal_chat_message_metadata_passthrough: { value: 'x'.repeat(60 * 1024) } } }));
      const response = { output: [item], padding: 'x'.repeat(TRANSLATOR_MAX_TURN_BYTES - 1024) };
      expect(() => format === 'json' ? rewrite.json(JSON.stringify(response))
        : rewrite(block({ type: 'response.completed', response }))).toThrow();
      expect(existsSync(home.path('artifacts'))).toBe(false);
    } finally { rewrite.dispose?.(); }
  });
}

test('ordinary metadata survives added/done/terminal reuse exactly once', () => {
  const rewrite = factory();
  const metadata = { synthetic: true, routing: { lane: 'image', labels: ['日本語', 'a\nb'] } };
  const image = { ...item, internal_chat_message_metadata_passthrough: metadata };
  try {
    const emitted = [
      { type: 'response.output_item.added', output_index: 0, item: { ...image, status: 'in_progress', result: null } },
      { type: 'response.output_item.done', output_index: 0, item: image },
      { type: 'response.completed', response: { output: [image] } },
    ].flatMap(event => rewrite(block(event))).map(value => JSON.parse(value.split('data: ')[1]!));
    const added = emitted.find(event => event.type === 'response.output_item.added').item;
    const done = emitted.find(event => event.type === 'response.output_item.done').item;
    expect(added.id).toBe(done.id);
    expect(done.internal_chat_message_metadata_passthrough).toEqual(metadata);
    expect(emitted.at(-1).response.output[0]).toEqual(done);
    expect(emitted.filter(event => event.type === 'response.output_item.done')).toHaveLength(1);
    expect(readdirSync(home.path('artifacts'))).toHaveLength(1);
  } finally { rewrite.dispose?.(); }
});

test('literal upstream ids cannot alias the fallback index namespace', () => {
  const rewrite = factory();
  try {
    const result = JSON.parse(rewrite.json(JSON.stringify({ output: [
      { ...item, id: undefined }, { ...failed, id: 'index:0' },
    ] })));
    expect(result.output[0].id).not.toBe(result.output[1].id);
    expect(result.output[0].status).toBe('completed');
    expect(result.output[1].status).toBe('incomplete');
    expect(readdirSync(home.path('artifacts'))).toHaveLength(1);
  } finally { rewrite.dispose?.(); }
});
