/** Process-local cooldown state shared by selection validation and key failover. */
const keyCooldowns = new Map<string, { cooldownUntil: number; quotaSpentUntil?: number }>();

function cooldownKey(providerName: string, keyId: string): string {
  return `${providerName}\0${keyId}`;
}

/**
 * `quotaSpent` marks a refusal that proved the key's quota or credit is spent. A rate limit leaves
 * it unset, because that key serves again once the window passes.
 */
export function setKeyCooldown(providerName: string, keyId: string, cooldownUntil: number, quotaSpent = false): void {
  const key = cooldownKey(providerName, keyId);
  const previous = keyCooldowns.get(key);
  const quotaSpentUntil = Math.max(previous?.quotaSpentUntil ?? 0, quotaSpent ? cooldownUntil : 0);
  keyCooldowns.set(key, {
    cooldownUntil: Math.max(previous?.cooldownUntil ?? 0, cooldownUntil),
    ...(quotaSpentUntil > 0 ? { quotaSpentUntil } : {}),
  });
}

export function isKeyInCooldown(providerName: string, keyId: string, now = Date.now()): boolean {
  const entry = keyCooldowns.get(cooldownKey(providerName, keyId));
  if (!entry) return false;
  if (entry.cooldownUntil <= now) {
    keyCooldowns.delete(cooldownKey(providerName, keyId));
    return false;
  }
  return true;
}

export function getKeyCooldownUntil(providerName: string, keyId: string, now = Date.now()): number | null {
  const entry = keyCooldowns.get(cooldownKey(providerName, keyId));
  if (!entry) return null;
  return entry.cooldownUntil > now ? entry.cooldownUntil : null;
}

/** True while the key is cooling because a refusal proved its quota or credit spent. */
export function isKeyQuotaSpent(providerName: string, keyId: string, now = Date.now()): boolean {
  return (keyCooldowns.get(cooldownKey(providerName, keyId))?.quotaSpentUntil ?? 0) > now;
}

export function sweepExpiredApiKeyCooldowns(now = Date.now()): number {
  let removed = 0;
  for (const [key, cooldown] of keyCooldowns) {
    if (cooldown.cooldownUntil > now) continue;
    keyCooldowns.delete(key);
    removed += 1;
  }
  return removed;
}

/** Manual key management clears this provider's cooldowns. */
export function clearKeyCooldowns(providerName?: string): void {
  if (!providerName) {
    keyCooldowns.clear();
    return;
  }
  const prefix = `${providerName}\0`;
  for (const key of keyCooldowns.keys()) {
    if (key.startsWith(prefix)) keyCooldowns.delete(key);
  }
}
