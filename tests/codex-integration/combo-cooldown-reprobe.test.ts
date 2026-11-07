import { describe, test, expect } from 'bun:test';
import { pickComboTarget, pickComboTargetWithWait, advanceComboAfterFailure, clearComboSelectionState, settleComboReprobeSuccess } from '../../src/combos/resolve';
import { clearComboTargetCooldowns, comboTargetCooldownRevision, coolComboTarget, isComboTargetInCooldown } from '../../src/combos/failover';
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
    clearComboTargetCooldowns(id, ['openai/test-b']);
    expect(pickComboTarget(config, id, { now })!.target.model).toBe('test-b');
    expect(isComboTargetInCooldown(id, targets[0]!, now)).toBe(true);
  });
  test('recovery preserves cooldowns for targets ineligible for this request', () => {
    const { id, config } = setup();
    const pick = pickComboTarget(config, id, { now, eligible: target => target.model === 'test-a' });
    expect(pick!.target.model).toBe('test-a');
    expect(isComboTargetInCooldown(id, targets[0]!, now)).toBe(true);
    expect(isComboTargetInCooldown(id, targets[1]!, now)).toBe(true);
  });
  test('a reserved pass does not make cooled targets visible to concurrent requests', () => {
    const { id, config } = setup();
    const reserved = pickComboTarget(config, id, { now })!;
    expect(reserved.target.model).toBe('test-a');
    expect(isComboTargetInCooldown(id, targets[0]!, now)).toBe(true);
    expect(pickComboTarget(config, id, { now })).toBeNull();
    const second = advanceComboAfterFailure(config, reserved, {
      now, status: 429, retryAfter: '36000', cooldownScope: 'target',
    });
    expect(second!.target.model).toBe('test-b');
    expect(pickComboTarget(config, id, { now })).toBeNull();
  });
  test('a failed single-target reprobe cannot bypass the same absolute Retry-After again', async () => {
    const { id, config } = setup();
    config.combos![id]!.targets = [targets[0]!];
    const retryAfter = new Date(now + 30_000).toUTCString();
    coolComboTarget(id, targets[0]!, { now, retryAfter, status: 429 });
    const reserved = pickComboTarget(config, id, { now })!;
    expect(advanceComboAfterFailure(config, reserved, {
      now: now + 1_000, status: 429, retryAfter, cooldownScope: 'target',
    })).toBeNull();
    const sleeps: number[] = [];
    const retried = await pickComboTargetWithWait(config, id, {
      now: now + 1_000, waitForCooldownMs: 1_000, allowCooldownReprobe: false,
      cooldownReprobeTargets: Object.entries(reserved.cooldownReprobeTargets!),
      sleep: async delay => { sleeps.push(delay); },
    });
    expect(retried).toBeNull();
    expect(sleeps).toEqual([]);
    expect(isComboTargetInCooldown(id, targets[0]!, now + 1_000)).toBe(true);
  });
  test('a provider failure replaces same-expiry reservations for every sibling', () => {
    const { id, config } = setup();
    const retryAfter = new Date(now + 30_000).toUTCString();
    for (const target of targets) coolComboTarget(id, target, { now, retryAfter, status: 429 });
    const reserved = pickComboTarget(config, id, { now })!;
    expect(advanceComboAfterFailure(config, reserved, {
      now: now + 1_000, status: 429, retryAfter, cooldownScope: 'provider',
    })).toBeNull();
    expect(targets.every(target => isComboTargetInCooldown(id, target, now + 1_000))).toBe(true);
  });
  test('successful reprobe settlement preserves a replacement with the same expiry', () => {
    const { id, config } = setup();
    const reserved = pickComboTarget(config, id, { now })!;
    // A concurrent failure can write identical expiry and status, even in the same tick.
    coolComboTarget(id, reserved.target, { now, retryAfter: '36000', status: 429 });
    settleComboReprobeSuccess(reserved);
    expect(isComboTargetInCooldown(id, reserved.target, now)).toBe(true);
    expect(pickComboTarget(config, id, { now })).toBeNull();
  });
  test('successful reprobe settlement releases only the unchanged dispatched target', () => {
    const { id, config } = setup();
    const reserved = pickComboTarget(config, id, { now })!;
    settleComboReprobeSuccess(reserved);
    expect(isComboTargetInCooldown(id, reserved.target, now)).toBe(false);
    expect(isComboTargetInCooldown(id, targets[1]!, now)).toBe(true);
    expect(pickComboTarget(config, id, { now })!.target.model).toBe('test-a');
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
  for (const policy of [undefined, 'before-last-resort'] as const) {
    for (const afterWait of ['usable', 'disabled', 'ineligible', 'recooled'] as const) {
      test(`wait rechecks a reserved target's current eligibility (${policy ?? 'ordinary'}, ${afterWait})`, async () => {
        const id = `reprobe-wait-${++sequence}`;
        const waitedTargets = ['a', 'b', 'c', ...(policy ? ['d'] : [])].map(provider => ({
          provider, model: `test-${provider}`, lastResort: provider === 'd',
        }));
        const config = {
          providers: Object.fromEntries(waitedTargets.map(target => [target.provider, {
            baseUrl: 'https://example.invalid', apiKey: 'test',
          }])),
          combos: { [id]: { strategy: 'failover', targets: waitedTargets,
            cooldownReprobe: { enabled: true }, ...(policy ? { cooldownWaitPolicy: policy } : {}) } },
        } as OcxConfig;
        for (const target of waitedTargets) coolComboTarget(id, target, { now, retryAfter: '36000', status: 429 });
        const first = (await pickComboTargetWithWait(config, id, { now, waitForCooldownMs: 1000 }))!;
        expect(first.target.provider).toBe('a');
        const reservedB = first.cooldownReprobeTargets!['b/test-b'];
        expect(reservedB).toBe(comboTargetCooldownRevision(id, waitedTargets[1]!, now));

        // While A is in flight, B is disabled and C gets a newer, shorter cooldown.
        // C's replacement invalidates its reservation and makes a real wait necessary.
        config.providers.b!.disabled = true;
        coolComboTarget(id, waitedTargets[2]!, { now, retryAfter: '1', status: 429 });
        expect(advanceComboAfterFailure(config, first, {
          now, status: 429, retryAfter: '36000', cooldownScope: 'target',
        })).toBeNull();
        let bEligible = true;
        const sleeps: number[] = [];
        const pick = await pickComboTargetWithWait(config, id, {
          now, waitForCooldownMs: 1000, allowCooldownReprobe: false,
          exclude: first.attempted, cooldownReprobeTargets: Object.entries(first.cooldownReprobeTargets!),
          eligible: target => target.provider !== 'b' || bEligible,
          sleep: async delay => {
            sleeps.push(delay);
            expect(comboTargetCooldownRevision(id, waitedTargets[1]!, now)).toBe(reservedB);
            config.providers.b!.disabled = afterWait === 'disabled';
            bEligible = afterWait !== 'ineligible';
            if (afterWait === 'recooled') {
              coolComboTarget(id, waitedTargets[1]!, { now, retryAfter: '36000', status: 429 });
            }
          },
        });
        expect(sleeps).toEqual([1000]);
        expect(pick!.target.provider).toBe(afterWait === 'usable' ? 'b' : 'c');
        expect(isComboTargetInCooldown(id, waitedTargets[1]!, now + 1000)).toBe(true);
        if (afterWait === 'usable') {
          expect(pick!.cooldownReprobeTargets!['b/test-b']).toBe(reservedB);
          expect(comboTargetCooldownRevision(id, waitedTargets[1]!, now + 1000)).toBe(reservedB);
          settleComboReprobeSuccess(pick!);
          expect(isComboTargetInCooldown(id, waitedTargets[1]!, now + 1000)).toBe(false);
          expect(isComboTargetInCooldown(id, waitedTargets[0]!, now + 1000)).toBe(true);
        }
      });
    }
  }
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
