import { createHash } from "node:crypto";
import { resolveCodexHomeDir } from "./home";
import type { CodexAuthContext } from "./auth-context";

const MAX_HOMES = 8;
const MAX_FINGERPRINTS = 4;
type HomeState = { observed?: string; refused: boolean; unknown: boolean; fingerprints: Set<string>; generation: number };
export type NativeMainAuthentication = Readonly<{ home: string; fingerprint: string; generation: number }>;

/** Bounded process-local metadata only. Losing refusal history always strengthens admission. */
export class NativeMainRefusals {
  private readonly homes = new Map<string, HomeState>();
  private evictedRefusal = false;
  private generation = 0;

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
    const state: HomeState = { refused: this.evictedRefusal, unknown: this.evictedRefusal, fingerprints: new Set(), generation: ++this.generation };
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
    state.generation = ++this.generation;
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

  /** Read observations remember candidates; they never recover a refused home. */
  observe(home: string, bearer: string): void {
    const state = this.state(home);
    state.observed = fingerprint(bearer);
  }

  capture(home: string, bearer: string): NativeMainAuthentication | undefined {
    const state = this.state(home);
    if (this.refuses(home, bearer)) return undefined;
    return { home, fingerprint: fingerprint(bearer), generation: state.generation };
  }

  current(proof: NativeMainAuthentication): boolean {
    const state = this.homes.get(proof.home);
    return !!state && state.generation === proof.generation && !state.unknown
      && !state.fingerprints.has(proof.fingerprint);
  }

  /** Recovery authority: a committed, identity-checked native-main device login. */
  verifiedLogin(home: string): void {
    const state = this.state(home);
    state.generation = ++this.generation;
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

/** Common admission boundary for every owned main file/keyring bearer reader. */
export function nativeMainBearerAllowed(bearer: string, home = resolveCodexHomeDir()): boolean {
  return !nativeMainRefusals.refuses(home, bearer);
}

export function nativeMainAuthenticationIsCurrent(proof: NativeMainAuthentication): boolean {
  return proof.home === resolveCodexHomeDir() && nativeMainRefusals.current(proof);
}

/** Keep the captured home and inspect the actual bearer after pacing, on every attempt. */
export function guardNativeMainDispatch(
  ctx: CodexAuthContext,
  guard: ((headers: Headers) => void) | undefined,
  refused: () => Error,
): ((headers: Headers) => void) | undefined {
  if (ctx.kind === "pool") return guard;
  const home = resolveCodexHomeDir();
  return headers => {
    if (ctx.kind === "main-pool" || ctx.mainQuotaDispatch) {
      const bearer = headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1];
      if (home !== resolveCodexHomeDir() || !bearer || !nativeMainBearerAllowed(bearer, home)) throw refused();
    }
    guard?.(headers);
  };
}
