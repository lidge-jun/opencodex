import { createHash } from "node:crypto";

const MAX_HOMES = 8;
const MAX_FINGERPRINTS = 4;
type HomeState = { observed?: string; refused: boolean; unknown: boolean; fingerprints: Set<string> };

/** Bounded process-local metadata only. Losing refusal history always strengthens admission. */
export class NativeMainRefusals {
  private readonly homes = new Map<string, HomeState>();
  private evictedRefusal = false;

  private state(home: string): HomeState {
    const existing = this.homes.get(home);
    if (existing) return existing;
    if (this.homes.size === MAX_HOMES) {
      // Prefer forgetting harmless observations; never forget a refusal without closing
      // admission for every untracked home (a bounded map cannot remember evicted names).
      const oldest = [...this.homes].find(([, value]) => !value.refused) ?? this.homes.entries().next().value!;
      if (oldest[1].refused) this.evictedRefusal = true;
      this.homes.delete(oldest[0]);
    }
    const state: HomeState = { refused: this.evictedRefusal, unknown: this.evictedRefusal, fingerprints: new Set() };
    this.homes.set(home, state);
    return state;
  }

  has(home: string): boolean {
    return this.homes.get(home)?.refused ?? this.evictedRefusal;
  }

  refuses(home: string, bearer: string): boolean {
    const state = this.homes.get(home);
    return state ? state.refused && (state.unknown || state.fingerprints.has(fingerprint(bearer))) : this.evictedRefusal;
  }

  refuse(home: string, bearer?: string): void {
    const state = this.state(home);
    state.refused = true;
    const candidates = [state.observed, bearer ? fingerprint(bearer) : undefined];
    for (const candidate of candidates) {
      if (!candidate || state.unknown || state.fingerprints.has(candidate)) continue;
      if (state.fingerprints.size === MAX_FINGERPRINTS) {
        state.unknown = true;
        state.fingerprints.clear();
        break;
      }
      state.fingerprints.add(candidate);
    }
    if (state.fingerprints.size === 0) state.unknown = true;
  }

  /** Remember an accepted owned RPC; the caller verifies identity for refusal recovery. */
  observe(home: string, bearer: string): void {
    const state = this.state(home);
    state.observed = fingerprint(bearer);
    state.refused = false;
    state.unknown = false;
    state.fingerprints.clear();
  }

  /** Recovery authority: a committed, identity-checked native-main device login. */
  verifiedLogin(home: string): void {
    const state = this.state(home);
    state.observed = undefined;
    state.refused = false;
    state.unknown = false;
    state.fingerprints.clear();
  }
}

function fingerprint(bearer: string): string {
  return createHash("sha256").update(`opencodex:native-main:refused-bearer:v1\0${bearer}`).digest("hex");
}

export const nativeMainRefusals = new NativeMainRefusals();
