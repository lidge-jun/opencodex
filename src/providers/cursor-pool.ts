/**
 * Weighted credential routing for Cursor accounts.
 *
 * Transfer from yelixir-dev/cursor-ai-proxy-bridge credentials.ts:
 * weighted round-robin selection with per-credential auth-failure cooldown
 * and one-retry failover on a different account before surfacing the error.
 *
 * OpenCodex already has JWT-based multi-account identification (src/oauth/cursor.ts)
 * and Anthropic-specific 429 rotation; this module adds Cursor-aware weighted
 * routing on top of those primitives.
 */

export interface CursorCredential {
  readonly id: string;
  weight: number;
}

interface CredentialState {
  readonly credential: CursorCredential;
  currentWeight: number;
  disabledUntil: number;
}

export class NoAvailableCursorCredentialError extends Error {
  constructor(message = "No available Cursor credentials") { super(message); }
}

export class CursorCredentialRouter {
  private states: CredentialState[] = [];
  private readonly cooldownMs: number;

  constructor(credentials: ReadonlyArray<CursorCredential>, cooldownMs = 300_000) {
    this.cooldownMs = cooldownMs;
    this.replace(credentials);
  }

  replace(credentials: ReadonlyArray<CursorCredential>): void {
    this.states = credentials.map(c => ({
      credential: { ...c, weight: Math.max(1, c.weight || 1) },
      currentWeight: 0,
      disabledUntil: 0,
    }));
  }

  pick(excludeIds: ReadonlySet<string> = new Set()): CursorCredential {
    const now = Date.now();
    const candidates = this.states.filter(s =>
      !excludeIds.has(s.credential.id) && s.disabledUntil <= now,
    );
    if (candidates.length === 0) throw new NoAvailableCursorCredentialError();
    let selected: CredentialState | undefined;
    let totalWeight = 0;
    for (const state of candidates) {
      state.currentWeight += state.credential.weight;
      totalWeight += state.credential.weight;
      if (!selected || state.currentWeight > selected.currentWeight) selected = state;
    }
    if (!selected) throw new NoAvailableCursorCredentialError();
    selected.currentWeight -= totalWeight;
    return { ...selected.credential };
  }

  disable(id: string): void {
    const state = this.states.find(s => s.credential.id === id);
    if (state) state.disabledUntil = Date.now() + this.cooldownMs;
  }

  get snapshot(): ReadonlyArray<{ id: string; disabled: boolean }> {
    const now = Date.now();
    return this.states.map(s => ({ id: s.credential.id, disabled: s.disabledUntil > now }));
  }
}
