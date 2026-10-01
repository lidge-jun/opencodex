import { expect, test } from 'bun:test';
import { readFileSync, statSync } from 'node:fs';
import { deliverPassthroughResponse, setRelayPlatformForTests } from "../../src/server/responses/passthrough-delivery";
import { createTranslatorBudget } from "../../src/lib/translator-budget";
import { createTempHome, type TempHome } from "../helpers/temp-home";
import { beforeEach, afterEach } from "bun:test";
let home: TempHome;
beforeEach(() => { home = createTempHome("hosted-image-delivery-"); });
afterEach(() => { setRelayPlatformForTests(undefined); home.remove(); });

import { item } from "../fixtures/hosted-image-display";
import { handleResponses, handleResponsesCompact } from "../../src/server/responses";
import { createHostedImageDisplayRewrite } from "../../src/server/responses-hosted-image-display";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import { artifactHttpUrl } from "../../src/images/artifacts";
import { getDefaultConfig } from "../../src/config";
import type { OcxConfig } from "../../src/types";
const finalMessage = { id: 'msg_final_fixture', type: 'message', role: 'assistant', status: 'completed', phase: 'final_answer', content: [{ type: 'output_text', text: 'Done.', annotations: [] }] };
const response = { id: 'resp_image_fixture', object: 'response', model: 'fixture', created_at: 1790666489, status: 'completed', output: [item, finalMessage] };
const nl = String.fromCharCode(10);

test('full client history replay removes generated artifact paths before upstream dispatch', async () => {
  const release = acquireOwnedSpendHome();
  const originalFetch = globalThis.fetch;
  const rewrite = createHostedImageDisplayRewrite();
  const requests: any[] = [];
  try {
    const message = JSON.parse(rewrite.json(JSON.stringify({ output: [item] }))).output[0];
    const displayedText = message.content[0].text;
    const path = displayedText.match(/<([^>]+)>/)[1];
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      requests.push(JSON.parse(String(init?.body)));
      return Response.json({ id: 'resp_replay_fixture', status: 'completed', output: [] });
    }) as typeof fetch;
    const config = { port: 0, defaultProvider: 'fixture', providers: { fixture: {
      adapter: 'openai-responses', baseUrl: 'https://fixture.test/v1', authMode: 'key', apiKey: 'fixture-key',
    } } } as OcxConfig;
    for (const content of [message.content, displayedText]) {
      // Clients may omit the synthetic item id when serializing their full history.
      const result = await handleResponses(new Request('http://localhost/v1/responses', {
        method: 'POST', headers: { 'content-type': 'application/json', originator: 'Codex Desktop' },
        body: JSON.stringify({ model: 'fixture/fixture-model', stream: false,
          input: [{ role: 'assistant', content }, { role: 'user', content: 'Describe the previous result.' }] }),
      }), config, { model: '', provider: '' }, { admission: { kind: 'loopback', source: 'loopback' }, inboundWire: 'responses' });
      await result.text();
      expect(result.status).toBe(200);
    }
    expect(requests).toHaveLength(2);
    for (const request of requests) {
      expect(JSON.stringify(request.input)).not.toContain(home.root);
      expect(JSON.stringify(request.input)).toContain(artifactHttpUrl(path));
      expect(JSON.stringify(request.input)).toContain('Describe the previous result.');
    }
    expect(message.content[0].text).toBe(displayedText);
    expect(readFileSync(path)).toEqual(Buffer.from(item.result, 'base64'));
  } finally { globalThis.fetch = originalFetch; rewrite.dispose?.(); release(); }
});

test('remote compaction removes generated artifact paths before the upstream request', async () => {
  const release = acquireOwnedSpendHome();
  const originalFetch = globalThis.fetch;
  const rewrite = createHostedImageDisplayRewrite();
  const requests: Array<{ url: string; body: string }> = [];
  try {
    const displayedText = JSON.parse(rewrite.json(JSON.stringify({ output: [item] }))).output[0].content[0].text;
    const path = displayedText.match(/<([^>]+)>/)[1];
    globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
      requests.push({ url: String(url), body: String(init?.body) });
      return Response.json({ output: [{ type: 'compaction', encrypted_content: 'native-summary' }] });
    }) as typeof fetch;
    const config = { ...getDefaultConfig(), defaultProvider: 'openai-apikey', providers: { 'openai-apikey': {
      adapter: 'openai-responses', baseUrl: 'https://api.openai.com/v1', authMode: 'key', apiKey: 'fixture-key',
    } } } as OcxConfig;
    const result = await handleResponsesCompact(new Request('http://localhost/v1/responses/compact', {
      method: 'POST', headers: { 'content-type': 'application/json', originator: 'Codex Desktop' },
      body: JSON.stringify({ model: 'openai-apikey/gpt-5.6-luna', input: [
        { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: displayedText }] },
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Keep the task state.' }] },
      ] }),
    }), config, { model: '', provider: '' });
    await result.text();
    expect(result.status).toBe(200);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.url).toBe('https://api.openai.com/v1/responses/compact');
    expect(requests[0]!.body).not.toContain(home.root);
    expect(requests[0]!.body).not.toContain(JSON.stringify(path).slice(1, -1));
    expect(requests[0]!.body).toContain(artifactHttpUrl(path));
    expect(requests[0]!.body).toContain('Keep the task state.');
  } finally { globalThis.fetch = originalFetch; rewrite.dispose?.(); release(); }
});

const cases: Array<{ platform: 'darwin' | 'linux' | 'win32'; format: string; client: string; cache: string }> = [];
for (const platform of ['darwin', 'linux', 'win32'] as const) {
  for (const format of ['sse', 'json', 'json-to-sse']) {
    for (const client of ['local', 'generic', 'remote']) cases.push({ platform, format, client, cache: 'raw' });
  }
  for (const cache of ['plaintext', 'envelope']) cases.push({ platform, format: 'sse', client: 'local', cache });
}
for (const platform of ['darwin', 'linux', 'win32'] as const) {
  for (const format of ['sse', 'json', 'json-to-sse']) cases.push({ platform, format, client: 'local', cache: 'overflow' });
}
for (const { platform, format, client, cache } of cases) {
  const local = client === 'local';
  test(platform + '/' + format + '/' + client + '/' + cache, async () => {
    setRelayPlatformForTests(platform);
    const upstream = new AbortController();
    const budget = createTranslatorBudget();
    const remembered: any[] = [];
    let resolveRemembered!: () => void;
    const didRemember = new Promise<void>(resolve => { resolveRemembered = resolve; });
    const currentResponse = cache === 'overflow'
      ? { ...response, output: Array.from({ length: 129 }, (_, i) => ({ ...item, id: 'ig_limit_' + i, status: 'failed', result: null })) }
      : response;
    const payload = format !== 'sse' ? JSON.stringify(currentResponse) : [
      { type: 'response.created', response: { ...response, status: 'in_progress', output: [] } },
      { type: 'response.output_item.added', output_index: 0, item: { ...item, status: 'in_progress', result: null } },
      { type: 'response.output_item.done', output_index: 0, item },
      { type: 'response.output_item.added', output_index: 1, item: { ...finalMessage, status: 'in_progress', content: [] } },
      { type: 'response.output_item.done', output_index: 1, item: finalMessage },
      { type: 'response.completed', response: currentResponse },
    ].map(e => 'data: ' + JSON.stringify(e) + nl + nl).join('') + 'data: [DONE]' + nl + nl;
    const req = new Request('http://127.0.0.1:10100/v1/responses', {
      headers: client !== 'generic' ? { originator: 'Codex Desktop' } : {},
    });
    const native = {
      upstreamResponse: new Response(payload, { headers: { 'content-type': format === 'sse' ? 'text/event-stream' : 'application/json' } }),
      upstream, request: req, connectMs: 1000,
      imageGenCallAliases: new Map(), selfNamedNamespaceScrubAuthorization: new Set(), authorizedBareNamespaceToolAliases: new Map(),
      routedCustomToolNames: new Set(), routedCustomToolRepairNames: new Set(), declaredWireToolNames: new Set(),
      routedToolSearchNames: new Set(), functionRepairSchemas: new Map(), declaredNamelessClientCallTypes: new Set(),
      providerExecutedCallTypes: new Set(), declaredBareWireToolNames: new Set(), undeclaredToolGuardActive: false,
      rememberPassthroughResponse: true, rememberPassthroughResponseChecked: (value: any) => { remembered.push(value); resolveRemembered(); },
      normalizeFunctionCompletionJson: (value: string) => value,
      outboundRequestBody: '{}',
    };
    try {
      const result = await deliverPassthroughResponse(
        { req, config: { providers: {}, streamMode: 'auto' }, logCtx: {}, options: { admission: { kind: client === 'remote' ? 'configured' : 'loopback', source: 'loopback' } } } as any,
        { authCtx: { kind: 'none' } } as any,
        { parsed: { stream: format === 'sse', modelId: 'fixture', _rawBody: { previous_response_id: 'resp_synthetic_prior' } }, clientRequestedStream: format !== 'json', translatorBudget: budget,
          route: { provider: { adapter: 'openai-responses', ...(cache === 'envelope' ? { baseUrl: 'https://api.x.ai/v1' } : {}) }, providerName: 'fixture', modelId: 'fixture', staticPolicy: { model: format === 'json-to-sse' ? { responsesUpstreamStreaming: false } : {} } } } as any,
        { requestBindings: new Map() } as any,
        {} as any,
        { plaintextV2AgentMessageToolNames: new Set(cache === 'plaintext' ? ['synthetic_agent'] : []), plaintextV2AgentMessageAliasedToolNames: new Set(),
          routedMuseToolNameAliases: new Map(), routedNamespaceToolAliases: new Map(),
          commitReasoningReplayServingRoute: () => {}, recordTerminalOutcomes: false } as any,
        native as any,
      );
      if (cache === 'overflow' && format !== 'sse') {
        expect(result.status).toBe(502);
        const body = await result.text();
        expect(body).toContain('hosted image result count exceeds local display limit');
        expect(body).not.toContain(home.root);
        return;
      }
      expect(result.status).toBe(200);
      expect(result.headers.get('content-type')?.includes('text/event-stream')).toBe(format !== 'json');
      const body = await result.text();
      if (cache === 'overflow') {
        const terminal = body.split(nl).filter(l => l.startsWith('data: {'))
          .map(l => JSON.parse(l.slice(6))).find(e => e.type === 'response.failed');
        expect(terminal).toBeDefined();
        expect(body).not.toContain(item.result);
        return;
      }
      const completed = format === 'json' ? JSON.parse(body) : body.split(nl).filter(l => l.startsWith('data: {'))
        .map(l => JSON.parse(l.slice(6))).find(e => e.type === 'response.completed')?.response;
      expect(completed?.output[0]?.type).toBe(local ? 'message' : 'image_generation_call');
      if (local) {
        expect(completed.output[0].phase).toBe('final_answer');
        expect(completed.output[1]).toEqual(finalMessage);
        if (format !== 'json') {
          const lifecycle = body.split(nl).filter(l => l.startsWith('data: {')).map(l => JSON.parse(l.slice(6)))
            .filter(e => e.item?.id === completed.output[0].id);
          // Bounded JSON synthesis intentionally emits only output_item.done.
          if (format === 'sse') expect(lifecycle.some(e => e.type === 'response.output_item.added')).toBe(true);
          expect(lifecycle.some(e => e.type === 'response.output_item.done')).toBe(true);
          for (const event of lifecycle) expect(event.item.phase).toBe('final_answer');
        }
        const path = completed.output[0].content[0].text.match(/<([^>]+)>/)?.[1];
        expect(path).toBeDefined();
        expect(readFileSync(path)).toEqual(Buffer.from(item.result, 'base64'));
        if (process.platform !== 'win32') expect(statSync(path).mode & 0o777).toBe(0o600);
        expect(body).not.toContain(item.result);
      }
      else expect(completed.output[0].result).toBe(item.result);
      await didRemember;
      expect(remembered.some(r => r.output?.[0]?.type === 'image_generation_call')).toBe(true);
      expect(JSON.stringify(remembered)).not.toContain('img-codex-');
    } finally {
      upstream.abort();
      budget.dispose();
    }
  });
}
