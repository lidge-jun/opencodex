import { describe, test, expect } from 'bun:test';
import { pickComboTarget, pickComboTargetWithWait, advanceComboAfterFailure, clearComboSelectionState } from '../../src/combos/resolve';
import { clearComboTargetCooldowns, coolComboTarget, isComboTargetInCooldown } from '../../src/combos/failover';
import { comboConfigIssues, normalizeComboConfig } from '../../src/combos/types';
import { routeModel } from '../../src/router';
import type { OcxConfig, OcxComboConfig } from '../../src/types';

const targets = [{ provider: 'openai', model: 'test-a', weight: 1 }, { provider: 'openai', model: 'test-b', weight: 1 }];
const now = 1_000_000;
let sequence = 0;
function setup(reprobe: OcxComboConfig['cooldownReprobe'] = { enabled: true }) {
  const id = `reprobe-${++sequence}`;
  const config = { providers: { openai: { baseUrl: 'https://example.invalid', apiKey: 'test' } },
    combos: { [id]: { strategy: 'failover', targets, ...(reprobe ? { cooldownReprobe: reprobe } : {}) } } } as OcxConfig;
  cool(id);
  return { id, config };
}
function cool(id: string, time = now) {
  for (const target of targets) coolComboTarget(id, target, { now: time, retryAfter: '36000', status: 429 });
}

describe('opt-in cooldown recovery', () => {
  test('omitted and explicitly disabled preserve current behavior', () => {
    for (const value of [undefined, { enabled: false }]) {
      const { id, config } = setup(value);
      if (!value) delete config.combos![id]!.cooldownReprobe;
      expect(pickComboTarget(config, id, { now })).toBeNull();
      expect(isComboTargetInCooldown(id, targets[0]!, now)).toBe(true);
    }
  });
  test('one ordered pass; errors re-cool; no second pass before default interval', () => {
    const { id, config } = setup();
    const first = pickComboTarget(config, id, { now })!;
    expect(first.target.model).toBe('test-a');
    const second = advanceComboAfterFailure(config, first, { now, status: 429, retryAfter: '36000', cooldownScope: 'target' })!;
    expect(second.target.model).toBe('test-b');
    expect(advanceComboAfterFailure(config, second, { now, status: 402, retryAfter: '36000', cooldownScope: 'target' })).toBeNull();
    expect(pickComboTarget(config, id, { now: now + 299999 })).toBeNull();
    expect(pickComboTarget(config, id, { now: now + 300000 })!.target.model).toBe('test-a');
  });
  test('interval is configurable and reservations are isolated by combo', () => {
    const a = setup({ enabled: true, intervalMs: 1000 });
    const b = setup({ enabled: true, intervalMs: 1000 });
    expect(pickComboTarget(a.config, a.id, { now })).not.toBeNull();
    cool(a.id);
    expect(pickComboTarget(a.config, a.id, { now: now + 999 })).toBeNull();
    expect(pickComboTarget(b.config, b.id, { now })).not.toBeNull();
    expect(pickComboTarget(a.config, a.id, { now: now + 1000 })).not.toBeNull();
  });
  test('preview and in-flight exclusions do not reopen targets', () => {
    const { id, config } = setup();
    expect(pickComboTarget(config, id, { now, preview: true })).toBeNull();
    expect(pickComboTarget(config, id, { now, exclude: ['openai/test-a'] })).toBeNull();
    expect(isComboTargetInCooldown(id, targets[0]!, now)).toBe(true);
  });
  test('available targets prevent a reset of siblings', () => {
    const { id, config } = setup();
    pickComboTarget(config, id, { now });
    coolComboTarget(id, targets[0]!, { now, retryAfter: '36000', status: 402 });
    expect(pickComboTarget(config, id, { now })!.target.model).toBe('test-b');
    expect(isComboTargetInCooldown(id, targets[0]!, now)).toBe(true);
  });
  test('recovery preserves cooldowns for targets ineligible for this request', () => {
    const { id, config } = setup();
    const pick = pickComboTarget(config, id, { now, eligible: target => target.model === 'test-a' });
    expect(pick!.target.model).toBe('test-a');
    expect(isComboTargetInCooldown(id, targets[0]!, now)).toBe(false);
    expect(isComboTargetInCooldown(id, targets[1]!, now)).toBe(true);
  });
  for (const wait of [false, true]) {
    test(`a cooled throwing predicate cannot block an available sibling (wait=${wait})`, async () => {
      const { id, config } = setup();
      clearComboTargetCooldowns(id, ['openai/test-b']);
      let cooledChecks = 0;
      const eligible = (target: typeof targets[number]) => {
        if (target.model === 'test-a') { cooledChecks++; throw new Error('unavailable metadata'); }
        return true;
      };
      const pick = wait
        ? await pickComboTargetWithWait(config, id, { now, eligible, waitForCooldownMs: 0 })
        : pickComboTarget(config, id, { now, eligible });
      expect(pick!.target.model).toBe('test-b');
      expect(cooledChecks).toBe(0);
      expect(isComboTargetInCooldown(id, targets[0]!, now)).toBe(true);
    });
    test(`reprobe treats a throwing predicate as ineligible (wait=${wait})`, async () => {
      const { id, config } = setup();
      const eligible = (target: typeof targets[number]) => {
        if (target.model === 'test-a') throw new Error('unavailable metadata');
        return true;
      };
      const pick = wait
        ? await pickComboTargetWithWait(config, id, { now, eligible, waitForCooldownMs: 0 })
        : pickComboTarget(config, id, { now, eligible });
      expect(pick!.target.model).toBe('test-b');
      expect(isComboTargetInCooldown(id, targets[0]!, now)).toBe(true);
    });
  }
  test('scoped cooldown clearing preserves other targets and combos', () => {
    const a = setup();
    const b = setup();
    clearComboTargetCooldowns(a.id, []);
    expect(isComboTargetInCooldown(a.id, targets[0]!, now)).toBe(true);
    clearComboTargetCooldowns(a.id, ['openai/test-a']);
    expect(isComboTargetInCooldown(a.id, targets[0]!, now)).toBe(false);
    expect(isComboTargetInCooldown(a.id, targets[1]!, now)).toBe(true);
    expect(isComboTargetInCooldown(b.id, targets[0]!, now)).toBe(true);
    clearComboTargetCooldowns(a.id);
    expect(isComboTargetInCooldown(a.id, targets[1]!, now)).toBe(false);
    expect(isComboTargetInCooldown(b.id, targets[1]!, now)).toBe(true);
  });
  test('explicit opt-out preserves cooldowns without consuming a recovery reservation', async () => {
    const { id, config } = setup();
    expect(pickComboTarget(config, id, { now, allowCooldownReprobe: false })).toBeNull();
    expect(await pickComboTargetWithWait(config, id, {
      now, waitForCooldownMs: 0, allowCooldownReprobe: false,
    })).toBeNull();
    expect(isComboTargetInCooldown(id, targets[0]!, now)).toBe(true);
    expect(await pickComboTargetWithWait(config, id, { now, waitForCooldownMs: 0 })).not.toBeNull();
  });
  test('in-flight retries wait for normal cooldown expiry even after the reprobe interval', async () => {
    const { id, config } = setup({ enabled: true, intervalMs: 1000 });
    expect(pickComboTarget(config, id, { now })).not.toBeNull();
    for (const target of targets) coolComboTarget(id, target, { now, retryAfter: '2', status: 429 });
    const sleeps: number[] = [];
    const pick = await pickComboTargetWithWait(config, id, {
      now: now + 1000, waitForCooldownMs: 1000, allowCooldownReprobe: false,
      sleep: async delay => { sleeps.push(delay); },
    });
    expect(sleeps).toEqual([1000]);
    expect(pick!.target.model).toBe('test-a');
  });
  test('wait path reserves synchronously across concurrent callers', async () => {
    const { id, config } = setup();
    const first = await pickComboTargetWithWait(config, id, { now, waitForCooldownMs: 0 });
    expect(first!.target.model).toBe('test-a');
    cool(id);
    const results = await Promise.all(Array.from({ length: 4 }, () =>
      pickComboTargetWithWait(config, id, { now, waitForCooldownMs: 0 })));
    expect(results).toEqual([null, null, null, null]);
  });
  test('eligibility, disabled providers, and cancellation remain enforced', async () => {
    const { id, config } = setup();
    expect(pickComboTarget(config, id, { now, eligible: () => false })).toBeNull();
    expect(isComboTargetInCooldown(id, targets[0]!, now)).toBe(true);
    const abort = new AbortController(); abort.abort();
    expect(await pickComboTargetWithWait(config, id, { now, waitForCooldownMs: 0, abortSignal: abort.signal })).toBeNull();
    expect(isComboTargetInCooldown(id, targets[0]!, now)).toBe(true);
    config.providers.openai!.disabled = true;
    expect(pickComboTarget(config, id, { now })).toBeNull();
  });
  test('selection-state reset releases reservation', () => {
    const { id, config } = setup();
    pickComboTarget(config, id, { now }); cool(id);
    clearComboSelectionState(id);
    expect(pickComboTarget(config, id, { now })).not.toBeNull();
  });
  test('route-level selection cannot reopen targets without request eligibility', () => {
    const { id, config } = setup();
    // Router uses the real clock; keep these cooldowns ahead of it.
    cool(id, Date.now());
    expect(() => routeModel(config, `combo/${id}`)).toThrow();
    expect(isComboTargetInCooldown(id, targets[0]!, Date.now())).toBe(true);
    expect(isComboTargetInCooldown(id, targets[1]!, Date.now())).toBe(true);
    expect(pickComboTarget(config, id, { now: Date.now(), eligible: target => target.model === 'test-a' })).not.toBeNull();
    expect(isComboTargetInCooldown(id, targets[1]!, Date.now())).toBe(true);
  });
});

describe('configuration validation', () => {
  test('defaults to disabled, and enabled defaults to five minutes', () => {
    expect(normalizeComboConfig({ targets }).cooldownReprobe).toBeUndefined();
    expect(normalizeComboConfig({ targets, cooldownReprobe: { enabled: false } }).cooldownReprobe).toBeUndefined();
    expect(normalizeComboConfig({ targets, cooldownReprobe: { enabled: true } }).cooldownReprobe).toEqual({ enabled: true, intervalMs: 300000 });
  });
  test('accepts interval bounds and rejects invalid/unknown settings', () => {
    const providers = { openai: { baseUrl: 'https://example.invalid' } };
    for (const intervalMs of [1000, 86400000]) {
      expect(comboConfigIssues('valid', { targets, cooldownReprobe: { enabled: true, intervalMs } }, providers)).toEqual([]);
    }
    for (const cooldownReprobe of [null, [], true, {}, { enabled: 'yes' },
      { enabled: true, intervalMs: 0 }, { enabled: true, intervalMs: 1000.5 },
      { enabled: true, intervalMs: 86400001 }, { enabled: true, intervalMs: '300000' },
      { enabled: true, extra: true }]) {
      expect(comboConfigIssues('invalid', { targets, cooldownReprobe }, providers).some(i => i.path[0] === 'cooldownReprobe')).toBe(true);
    }
  });
});
