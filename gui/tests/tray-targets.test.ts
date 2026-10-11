import { describe, expect, test } from 'bun:test';
import type { ApiTarget, ApiTargets } from '../src/api-targets';
import { resolveTrayApiBase, type TrayTargetDeps } from '../src/pages/tray-targets';

// #6920: the tray popup resolves its management targets the way App does before polling.
const target = (id: 'machine' | 'shared', baseUrl: string, serverOrigin: string, transport: ApiTarget['transport']): ApiTarget =>
  ({ id, baseUrl, serverOrigin, bootstrapPath: `${baseUrl}/opencodex-session`, transport });

const standalone: ApiTargets = {
  connected: false,
  machine: target('machine', '', 'http://127.0.0.1:10100', 'same-origin'),
  shared: target('shared', '', 'http://127.0.0.1:10100', 'same-origin'),
};
const direct: ApiTargets = {
  connected: true,
  machine: target('machine', '', 'http://127.0.0.1:10100', 'same-origin'),
  shared: target('shared', 'https://hub.example.test', 'https://hub.example.test', 'direct'),
  apiKeyId: 'key-1',
};
const relay: ApiTargets = {
  ...direct,
  shared: target('shared', '/api/machine/hub-relay', 'https://hub.example.test', 'relay'),
};

function deps(targets: ApiTargets | Error, session = false) {
  const calls: string[] = [];
  const value: TrayTargetDeps = {
    discover: async (base, signal) => {
      calls.push(`discover:${base}:${signal.aborted}`);
      if (targets instanceof Error) throw targets;
      return targets;
    },
    configure: next => { calls.push(`configure:${next.shared.baseUrl}`); },
    hasSharedSession: () => session,
    bootstrapShared: async () => { calls.push('bootstrap:shared'); return true; },
  };
  return { calls, value };
}

describe('tray target resolution', () => {
  test('a standalone runtime keeps same-origin requests and bootstraps nothing', async () => {
    const { calls, value } = deps(standalone);
    expect(await resolveTrayApiBase(new AbortController().signal, '', value)).toBe('');
    expect(calls).toEqual(['discover::false', 'configure:']);
  });

  test('a connected client sends tray requests to the hub and bootstraps its shared session once', async () => {
    const { calls, value } = deps(direct);
    expect(await resolveTrayApiBase(new AbortController().signal, '', value)).toBe('https://hub.example.test');
    expect(calls).toEqual(['discover::false', 'configure:https://hub.example.test', 'bootstrap:shared']);
  });

  test('an existing shared session is reused', async () => {
    const { calls, value } = deps(direct, true);
    await resolveTrayApiBase(new AbortController().signal, '', value);
    expect(calls).not.toContain('bootstrap:shared');
  });

  test('a relay connection routes through the local relay prefix', async () => {
    const { value } = deps(relay);
    expect(await resolveTrayApiBase(new AbortController().signal, '', value)).toBe('/api/machine/hub-relay');
  });

  test('a discovery failure rejects and installs no targets', async () => {
    const { calls, value } = deps(new Error('local machine plane unavailable'));
    await expect(resolveTrayApiBase(new AbortController().signal, '', value)).rejects.toThrow('local machine plane unavailable');
    expect(calls.some(call => call.startsWith('configure:'))).toBe(false);
  });

  test('cancellation during discovery rejects without installing the late targets', async () => {
    const controller = new AbortController();
    const calls: string[] = [];
    const pending = resolveTrayApiBase(controller.signal, '', {
      discover: () => new Promise<ApiTargets>(resolve => setTimeout(() => resolve(direct), 0)),
      configure: () => { calls.push('configure'); },
      hasSharedSession: () => false,
      bootstrapShared: async () => { calls.push('bootstrap'); return true; },
    });
    controller.abort();
    await expect(pending).rejects.toThrow('cancelled');
    expect(calls).toEqual([]);
  });
});
