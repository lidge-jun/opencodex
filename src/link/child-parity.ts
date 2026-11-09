/**
 * What a Remote Link Child tells its Home about the last settings apply (OCX-6).
 *
 * The Child knows when it last applied the Home's Codex settings, which digest it applied and when
 * its runtime started; the Home knows none of it. The Child reports these facts over the link
 * (`POST` to {@link LINK_CHILD_PARITY_PATH}, admitted by its link key) and the Home shows them on
 * each link row of `GET /api/link/status` (`lastApplyAt`, `runtimeStartedAt`,
 * `appliedCodexSettingsDigest`), so a peer can compare apply time with runtime start, and the
 * applied digest with the Home's own, without reading the Child.
 *
 * Display only. A report never admits, routes or changes anything on the Home, carries no setting
 * value, and lives in memory: a Home restart forgets it until the Child's next report (at most a
 * minute later).
 */
import { CODEX_SETTINGS_DIGEST_PATTERN } from "./codex-settings";
import { LINK_MANAGEMENT_PREFIX } from "./management-routes";

/** The one write a Child may send its Home over the link. */
export const LINK_CHILD_PARITY_PATH = `${LINK_MANAGEMENT_PREFIX}/child-parity`;
/** A report is four short fields; anything larger is refused while it is still being read. */
export const LINK_CHILD_PARITY_MAX_BYTES = 1024;

const LINK_ID = /^lnk_[0-9a-f]{16}$/;
/** 2001-09-09 .. 2286-11-20: any epoch-millisecond time a real clock reports. */
const MIN_EPOCH_MS = 1_000_000_000_000;
const MAX_EPOCH_MS = 9_999_999_999_999;

export interface LinkChildParityReport {
  linkId: string;
  /** Epoch ms of the Child's last successful apply of a different Home settings document. */
  lastApplyAt: number | null;
  /** Epoch ms of the Child runtime's process start. */
  runtimeStartedAt: number;
  /** `appliedCodexSettingsDigest` of the applied settings; null before any apply. */
  appliedCodexSettingsDigest: string | null;
  /**
   * Increases with every report this runtime process sends. With `runtimeStartedAt` it orders
   * reports, so a late POST from an older runtime or an earlier send never replaces a newer one.
   */
  sequence: number;
}

/** The per-link fields `GET /api/link/status` carries; every one is null until a report arrives. */
export interface LinkChildParity {
  lastApplyAt: number | null;
  runtimeStartedAt: number | null;
  appliedCodexSettingsDigest: string | null;
  /** Epoch ms the Home received the report (the Home's clock; the other times are the Child's). */
  reportedAt: number | null;
}

export const EMPTY_LINK_CHILD_PARITY: LinkChildParity = Object.freeze({
  lastApplyAt: null, runtimeStartedAt: null, appliedCodexSettingsDigest: null, reportedAt: null,
});

export function isEpochMs(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= MIN_EPOCH_MS && value <= MAX_EPOCH_MS;
}

function exactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every(key => keys.includes(key));
}

/** Strict: an unknown field, a non-integer time or a malformed digest rejects the report. */
export function parseLinkChildParityReport(value: unknown): LinkChildParityReport | null {
  if (!exactKeys(value, ["linkId", "lastApplyAt", "runtimeStartedAt", "appliedCodexSettingsDigest", "sequence"])) return null;
  const { linkId, lastApplyAt, runtimeStartedAt, appliedCodexSettingsDigest: digest, sequence } = value;
  if (typeof linkId !== "string" || !LINK_ID.test(linkId)) return null;
  if (lastApplyAt !== null && !isEpochMs(lastApplyAt)) return null;
  if (!isEpochMs(runtimeStartedAt)) return null;
  if (digest !== null && (typeof digest !== "string" || !CODEX_SETTINGS_DIGEST_PATTERN.test(digest))) return null;
  // An apply has both a time and a digest; before the first apply it has neither.
  if ((lastApplyAt === null) !== (digest === null)) return null;
  if (typeof sequence !== "number" || !Number.isSafeInteger(sequence) || sequence < 0) return null;
  return { linkId, lastApplyAt, runtimeStartedAt, appliedCodexSettingsDigest: digest, sequence };
}

export interface LinkChildParityStore {
  /**
   * Keep the report for its link unless a newer one is already kept (by `runtimeStartedAt`, then
   * `sequence`), dropping every entry whose link is not in `currentLinkIds`. True when kept.
   */
  record(report: LinkChildParityReport, currentLinkIds: ReadonlySet<string>): boolean;
  get(linkId: string): LinkChildParity;
  clear(): void;
}

export function createLinkChildParityStore(now: () => number = Date.now): LinkChildParityStore {
  const reports = new Map<string, LinkChildParity & { sequence: number }>();
  return {
    record(report, currentLinkIds) {
      for (const id of reports.keys()) if (!currentLinkIds.has(id)) reports.delete(id);
      if (!currentLinkIds.has(report.linkId)) return false;
      const kept = reports.get(report.linkId);
      if (kept && (kept.runtimeStartedAt! > report.runtimeStartedAt
        || (kept.runtimeStartedAt === report.runtimeStartedAt && kept.sequence >= report.sequence))) return false;
      reports.set(report.linkId, {
        lastApplyAt: report.lastApplyAt,
        runtimeStartedAt: report.runtimeStartedAt,
        appliedCodexSettingsDigest: report.appliedCodexSettingsDigest,
        reportedAt: now(),
        sequence: report.sequence,
      });
      return true;
    },
    get(linkId) {
      const kept = reports.get(linkId);
      if (!kept) return { ...EMPTY_LINK_CHILD_PARITY };
      const { sequence: _sequence, ...parity } = kept;
      return parity;
    },
    clear() { reports.clear(); },
  };
}

/** The Home's reports: one process-wide store, bounded by the link store on every write. */
export const homeLinkChildParity: LinkChildParityStore = createLinkChildParityStore();

/** Home link listener: is this the Child's report (exact path, POST, no query, no upgrade)? */
export function linkChildParityRouteAllowed(url: URL, req: Request): boolean {
  return url.pathname === LINK_CHILD_PARITY_PATH && req.method === "POST" && url.search === "" && !req.headers.has("upgrade");
}
