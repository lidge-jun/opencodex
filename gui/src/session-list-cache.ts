/**
 * SessionStorage helpers for non-secret GUI list/summary shapes (SWR seeds).
 * Never store API keys, tokens, or credentials here — XSS can read sessionStorage.
 */

export function readSessionListCache<T>(key: string): T | null {
  try {
    const raw = sessionStorage.getItem(key);
    if (!raw) return null;
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export function writeSessionListCache(key: string, value: unknown): void {
  try {
    sessionStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* private mode / quota */
  }
}

export function clearSessionListCache(key: string): void {
  try {
    sessionStorage.removeItem(key);
  } catch {
    /* ignore */
  }
}
