/**
 * The protocol pair of each Lab subject the compatibility matrix shows, for its protocol
 * filters.
 *
 * The Lab subject list carries only ids and kinds; the pair lives in each subject's detail.
 * Details are read only while a protocol filter is active, for the subjects the matrix shows,
 * a few at a time and at most `SUBJECT_DETAIL_LIMIT` of them, and cached per target because a
 * subject id is a digest of the subject and never changes meaning.
 */
import { useEffect, useState } from "react";
import { fetchSubjectDetail } from "./compatibility-matrix-api";
import { subjectProtocolPair, type SubjectProtocolPair } from "./compatibility-matrix-shared";

export const SUBJECT_DETAIL_LIMIT = 200;
const DETAIL_CONCURRENCY = 6;
const CACHE_LIMIT = 2000;
const LIST_SEPARATOR = "\n";

/** `null` records a subject whose detail could not be read, so it is not retried every render. */
const pairCache = new Map<string, SubjectProtocolPair | null>();

function cacheKey(apiBase: string, subjectId: string): string {
  return JSON.stringify([apiBase, subjectId]);
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
  /** Subjects whose pair is unknown: an unreadable detail, or past the detail limit. */
  unresolved: number;
}

const IDLE: SubjectProtocolPairs = { pairs: new Map(), loading: false, unresolved: 0 };

export function useSubjectProtocolPairs(apiBase: string, subjectIds: readonly string[], enabled: boolean): SubjectProtocolPairs {
  // Bumped when a batch lands, so the render re-reads the cache.
  const [, setLanded] = useState(0);
  const readable = enabled ? subjectIds.slice(0, SUBJECT_DETAIL_LIMIT) : [];
  const missingKey = readable.filter(subjectId => !pairCache.has(cacheKey(apiBase, subjectId))).join(LIST_SEPARATOR);

  useEffect(() => {
    if (!missingKey) return;
    const controller = new AbortController();
    const queue = missingKey.split(LIST_SEPARATOR);
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
      if (!controller.signal.aborted) setLanded(value => value + 1);
    });
    return () => controller.abort();
  }, [apiBase, missingKey]);

  if (!enabled) return IDLE;
  const pairs = new Map<string, SubjectProtocolPair>();
  let unresolved = Math.max(0, subjectIds.length - SUBJECT_DETAIL_LIMIT);
  for (const subjectId of readable) {
    const cached = pairCache.get(cacheKey(apiBase, subjectId));
    if (cached) pairs.set(subjectId, cached);
    else if (cached === null) unresolved += 1;
  }
  return { pairs, loading: missingKey.length > 0, unresolved };
}
