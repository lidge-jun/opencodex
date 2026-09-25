/**
 * Inbound / upstream protocol filters for the compatibility matrix.
 *
 * The Lab subject list carries only ids and kinds; the protocol pair lives in each subject's
 * detail. Details are read only while a protocol filter is active, for the subjects the matrix
 * shows, a few at a time and at most `SUBJECT_DETAIL_LIMIT` of them, and cached per target
 * because a subject id is a digest of the subject and never changes meaning.
 *
 * The filter reads Lab verdicts only. Delivery mode (native, translated) is how a request
 * travels and belongs to the path preview; the two are never folded into one badge here.
 */
import { useEffect, useMemo, useState } from "react";
import { PROTOCOLS, type Protocol } from "../../../src/protocols/contract";
import { protocolHopLabel } from "../components/protocols/protocol-labels";
import { useT } from "../i18n/shared";
import { Select } from "../ui";
import type { ProtocolPairFilter } from "../protocol-deep-links";
import { fetchSubjectDetail } from "./compatibility-matrix-api";
import {
  protocolFilterActive,
  subjectProtocolPair,
  type ProtocolPairEvidence,
  type SubjectProtocolPair,
} from "./compatibility-matrix-shared";

export const SUBJECT_DETAIL_LIMIT = 200;
const DETAIL_CONCURRENCY = 6;
const CACHE_LIMIT = 2000;

/** `null` records a subject whose detail could not be read, so it is not retried every render. */
const pairCache = new Map<string, SubjectProtocolPair | null>();

function cacheKey(apiBase: string, subjectId: string): string {
  return `${apiBase}\u0000${subjectId}`;
}

/** Test seam. */
export function clearSubjectProtocolPairCache(): void {
  pairCache.clear();
}

function remember(key: string, value: SubjectProtocolPair | null): void {
  pairCache.set(key, value);
  while (pairCache.size > CACHE_LIMIT) {
    const oldest = pairCache.keys().next().value;
    if (oldest === undefined) break;
    pairCache.delete(oldest);
  }
}

export interface SubjectProtocolPairs {
  pairs: ReadonlyMap<string, SubjectProtocolPair>;
  loading: boolean;
  /** Subjects whose pair is unknown: unreadable detail, or past the detail limit. */
  unresolved: number;
}

function collect(apiBase: string, subjectIds: readonly string[]): SubjectProtocolPairs {
  const pairs = new Map<string, SubjectProtocolPair>();
  let unresolved = 0;
  subjectIds.forEach((subjectId, index) => {
    const cached = index < SUBJECT_DETAIL_LIMIT ? pairCache.get(cacheKey(apiBase, subjectId)) : null;
    if (cached) pairs.set(subjectId, cached);
    else if (cached === null) unresolved += 1;
  });
  return { pairs, loading: false, unresolved };
}

export function useSubjectProtocolPairs(apiBase: string, subjectIds: readonly string[], enabled: boolean): SubjectProtocolPairs {
  const idsKey = subjectIds.join("\n");
  const [revision, setRevision] = useState(0);
  const missing = useMemo(
    () => enabled
      ? subjectIds.slice(0, SUBJECT_DETAIL_LIMIT).filter(subjectId => !pairCache.has(cacheKey(apiBase, subjectId)))
      : [],
    // `revision` re-reads the cache after a batch lands.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- idsKey stands in for subjectIds
    [apiBase, enabled, idsKey, revision],
  );

  useEffect(() => {
    if (missing.length === 0) return;
    const controller = new AbortController();
    const queue = [...missing];
    const worker = async () => {
      for (let subjectId = queue.shift(); subjectId !== undefined; subjectId = queue.shift()) {
        try {
          const detail = await fetchSubjectDetail(apiBase, subjectId, controller.signal);
          remember(cacheKey(apiBase, subjectId), subjectProtocolPair(detail));
        } catch {
          if (controller.signal.aborted) return;
          remember(cacheKey(apiBase, subjectId), null);
        }
      }
    };
    void Promise.all(Array.from({ length: Math.min(DETAIL_CONCURRENCY, queue.length) }, worker)).then(() => {
      if (!controller.signal.aborted) setRevision(value => value + 1);
    });
    return () => controller.abort();
  }, [apiBase, missing]);

  return useMemo(() => {
    if (!enabled) return { pairs: new Map(), loading: false, unresolved: 0 };
    const collected = collect(apiBase, subjectIds);
    const pastLimit = Math.max(0, subjectIds.length - SUBJECT_DETAIL_LIMIT);
    return { ...collected, loading: missing.length > 0, unresolved: collected.unresolved + pastLimit };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- idsKey stands in for subjectIds
  }, [apiBase, enabled, idsKey, missing, revision]);
}

function useProtocolName() {
  const t = useT();
  return (protocol: Protocol | "") => protocol ? protocolHopLabel(protocol, t) : t("compatProtocol.anyProtocol");
}

export function ProtocolPairFilters({ value, onChange }: {
  value: ProtocolPairFilter;
  onChange: (next: ProtocolPairFilter) => void;
}) {
  const t = useT();
  const protocolName = useProtocolName();
  const options = [
    { value: "", label: t("lab.filter.all") },
    ...PROTOCOLS.map(protocol => ({ value: protocol, label: protocolName(protocol) })),
  ];
  return (
    <>
      <div className="lab-filter-field">
        <label htmlFor="lab-filter-inbound">{t("compatProtocol.filter.inbound")}</label>
        <Select
          id="lab-filter-inbound"
          value={value.inbound}
          options={options}
          onChange={next => onChange({ ...value, inbound: next as Protocol | "" })}
          label={t("compatProtocol.filter.inbound")}
          portal={false}
        />
      </div>
      <div className="lab-filter-field">
        <label htmlFor="lab-filter-upstream">{t("compatProtocol.filter.upstream")}</label>
        <Select
          id="lab-filter-upstream"
          value={value.upstream}
          options={options}
          onChange={next => onChange({ ...value, upstream: next as Protocol | "" })}
          label={t("compatProtocol.filter.upstream")}
          portal={false}
        />
      </div>
    </>
  );
}

/**
 * The one line that states what the Lab knows about the filtered pair. With no matching row
 * the pair is unverified; nothing here ever calls it failed or unsupported.
 */
export function ProtocolPairStatus({ filter, evidence, resolution }: {
  filter: ProtocolPairFilter;
  evidence: ProtocolPairEvidence;
  resolution: Pick<SubjectProtocolPairs, "loading" | "unresolved">;
}) {
  const t = useT();
  const protocolName = useProtocolName();
  if (!protocolFilterActive(filter)) return null;
  const pair = t("compatProtocol.pair", { inbound: protocolName(filter.inbound), upstream: protocolName(filter.upstream) });
  return (
    <div className="lab-protocol-status" data-pair-evidence={resolution.loading ? "loading" : evidence}>
      {resolution.loading ? (
        <p className="muted small" role="status">{t("compatProtocol.loading")}</p>
      ) : evidence === "unverified" ? (
        // Plain text, not a Notice: every Notice tone reads as success, degradation or failure.
        <p className="lab-protocol-unverified" role="status">{t("compatProtocol.unverified", { pair })}</p>
      ) : null}
      {resolution.unresolved > 0 && !resolution.loading && (
        <p className="muted small">{t("compatProtocol.unresolved", { count: resolution.unresolved })}</p>
      )}
      <p className="muted small">{t("compatProtocol.axisNote")}</p>
    </div>
  );
}
