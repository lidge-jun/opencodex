/**
 * Whether this browser re-reads quota data on a timer ("Live quota updates"), and how often.
 *
 * Not to be confused with the Codex pool's `codexQuotaAutoRefresh`, a server setting that
 * activates quota windows upstream. This one is never stored on the server: a live update is a
 * plain re-read of what the proxy already holds (its TTL cache plus what live response headers
 * report), never `refresh=1`. The interval therefore does not set how often a provider is asked:
 * the proxy probes a credential again only once its cache entry has expired, so an open tab costs
 * at most one probe per credential per cache window, however short the interval.
 *
 * That bound is why only the per-account reads tick (`/api/oauth/accounts?…&quota=1` and
 * `/api/providers/keys?…&quota=1`, both served from per-credential TTL caches that also cache
 * failures). The summary strip's `/api/provider-quotas` and the Codex pool's
 * `/api/codex-auth/accounts` keep their fixed cadence: in some states a plain read of either
 * reaches upstream without such a bound — the provider report cache key moves with live Codex
 * pool usage, and a pool account answering 401/403 is neither cached nor backed off — so a
 * faster timer there would mean provider traffic at the timer's rate.
 *
 * Client-side and remembered per browser, like the OAuth open-browser choice: how lively a
 * dashboard should be belongs to whoever is looking at it, not to the machine running the proxy.
 *
 * Reads never throw. A browser with storage disabled gets the default, and a choice made there
 * still applies to this tab until it reloads.
 */
import { useSyncExternalStore } from "react";

const KEY = "ocx.quota.liveRefresh";

export interface QuotaLiveRefreshPref {
  enabled: boolean;
  intervalSeconds: number;
}

export const QUOTA_LIVE_REFRESH_MIN_SECONDS = 5;
export const QUOTA_LIVE_REFRESH_MAX_SECONDS = 600;
export const QUOTA_LIVE_REFRESH_DEFAULT: QuotaLiveRefreshPref = Object.freeze({ enabled: true, intervalSeconds: 15 });

/** Whole seconds inside the allowed range; anything that is not a finite number is the default. */
export function clampQuotaLiveRefreshSeconds(value: number): number {
  if (!Number.isFinite(value)) return QUOTA_LIVE_REFRESH_DEFAULT.intervalSeconds;
  return Math.min(QUOTA_LIVE_REFRESH_MAX_SECONDS, Math.max(QUOTA_LIVE_REFRESH_MIN_SECONDS, Math.round(value)));
}

/** Each field falls back on its own, so one bad field does not discard the other. */
export function parseQuotaLiveRefreshPref(raw: string | null): QuotaLiveRefreshPref {
  let value: unknown = null;
  try {
    if (raw !== null) value = JSON.parse(raw);
  } catch {
    value = null;
  }
  const record = value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  return {
    enabled: typeof record.enabled === "boolean" ? record.enabled : QUOTA_LIVE_REFRESH_DEFAULT.enabled,
    intervalSeconds: typeof record.intervalSeconds === "number"
      ? clampQuotaLiveRefreshSeconds(record.intervalSeconds)
      : QUOTA_LIVE_REFRESH_DEFAULT.intervalSeconds,
  };
}

/** Set only when storage refused a write; a successful write or another tab's change clears it. */
let unsaved: QuotaLiveRefreshPref | null = null;
/** useSyncExternalStore compares snapshots by identity, so one object per stored string. */
let snapshot: { raw: string | null; pref: QuotaLiveRefreshPref } | null = null;
const listeners = new Set<() => void>();

export function readQuotaLiveRefreshPref(): QuotaLiveRefreshPref {
  if (unsaved) return unsaved;
  let raw: string | null;
  try {
    raw = window.localStorage.getItem(KEY);
  } catch {
    return QUOTA_LIVE_REFRESH_DEFAULT;
  }
  if (!snapshot || snapshot.raw !== raw) snapshot = { raw, pref: parseQuotaLiveRefreshPref(raw) };
  return snapshot.pref;
}

/** Store the clamped value, tell this tab's subscribers, and return what was stored. */
export function writeQuotaLiveRefreshPref(next: QuotaLiveRefreshPref): QuotaLiveRefreshPref {
  const pref = { enabled: next.enabled, intervalSeconds: clampQuotaLiveRefreshSeconds(next.intervalSeconds) };
  try {
    window.localStorage.setItem(KEY, JSON.stringify(pref));
    unsaved = null;
  } catch {
    // A rejected write only costs the user the memory of the choice, not the choice.
    unsaved = pref;
  }
  for (const listener of listeners) listener();
  return pref;
}

/** Notified by writes in this tab and, through the `storage` event, by writes in other tabs. */
export function subscribeQuotaLiveRefreshPref(onChange: () => void): () => void {
  listeners.add(onChange);
  const onStorage = (event: StorageEvent) => {
    // A null key is another tab clearing all of this origin's storage.
    if (event.key !== null && event.key !== KEY) return;
    unsaved = null;
    onChange();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(onChange);
    window.removeEventListener("storage", onStorage);
  };
}

export function useQuotaLiveRefreshPref(): QuotaLiveRefreshPref {
  return useSyncExternalStore(subscribeQuotaLiveRefreshPref, readQuotaLiveRefreshPref, () => QUOTA_LIVE_REFRESH_DEFAULT);
}
