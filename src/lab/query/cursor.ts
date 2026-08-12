import { LAB_QUERY_CURSOR_VERSION, LAB_QUERY_MAX_CURSOR_BYTES } from "./constants";
import { InvalidCursorError } from "./errors";

export type VerdictCursorPayload = {
  v: typeof LAB_QUERY_CURSOR_VERSION;
  k: "verdicts";
  a: number;
  p: string;
  f: string;
};

export type ObservationCursorPayload = {
  v: typeof LAB_QUERY_CURSOR_VERSION;
  k: "observations";
  c: number;
  e: string;
  f: string;
};

export type EventCursorPayload = {
  v: typeof LAB_QUERY_CURSOR_VERSION;
  k: "events";
  r: number;
  e: string;
  f: string;
};

export type SubjectCursorPayload = {
  v: typeof LAB_QUERY_CURSOR_VERSION;
  k: "subjects";
  s: string;
  f: string;
};

export type ArtifactCursorPayload = {
  v: typeof LAB_QUERY_CURSOR_VERSION;
  k: "artifacts";
  d: string;
  f: string;
};

export type LabCursorPayload =
  | VerdictCursorPayload
  | ObservationCursorPayload
  | EventCursorPayload
  | SubjectCursorPayload
  | ArtifactCursorPayload;

function stableFilterKey(filters: Record<string, unknown>): string {
  const entries = Object.entries(filters)
    .filter(([, v]) => v !== undefined && v !== null)
    .sort(([a], [b]) => a.localeCompare(b));
  return JSON.stringify(entries);
}

export function encodeLabCursor(payload: LabCursorPayload): string {
  return Buffer.from(JSON.stringify(payload)).toString("base64url");
}

export function decodeLabCursor(raw: string | null | undefined): LabCursorPayload | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > LAB_QUERY_MAX_CURSOR_BYTES) return null;
  try {
    const parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as Record<string, unknown>;
    if (parsed.v !== LAB_QUERY_CURSOR_VERSION || typeof parsed.k !== "string") return null;
    if (parsed.k === "verdicts") {
      if (typeof parsed.a !== "number" || !Number.isFinite(parsed.a)) return null;
      if (typeof parsed.p !== "string" || parsed.p.length === 0 || parsed.p.length > 256) return null;
      if (typeof parsed.f !== "string") return null;
      return parsed as VerdictCursorPayload;
    }
    if (parsed.k === "observations") {
      if (typeof parsed.c !== "number" || !Number.isFinite(parsed.c)) return null;
      if (typeof parsed.e !== "string" || parsed.e.length === 0 || parsed.e.length > 256) return null;
      if (typeof parsed.f !== "string") return null;
      return parsed as ObservationCursorPayload;
    }
    if (parsed.k === "events") {
      if (typeof parsed.r !== "number" || !Number.isFinite(parsed.r)) return null;
      if (typeof parsed.e !== "string" || parsed.e.length === 0 || parsed.e.length > 256) return null;
      if (typeof parsed.f !== "string") return null;
      return parsed as EventCursorPayload;
    }
    if (parsed.k === "subjects") {
      if (typeof parsed.s !== "string" || parsed.s.length === 0 || parsed.s.length > 256) return null;
      if (typeof parsed.f !== "string") return null;
      return parsed as SubjectCursorPayload;
    }
    if (parsed.k === "artifacts") {
      if (typeof parsed.d !== "string" || parsed.d.length === 0 || parsed.d.length > 128) return null;
      if (typeof parsed.f !== "string") return null;
      return parsed as ArtifactCursorPayload;
    }
    return null;
  } catch {
    return null;
  }
}

export function assertCursorFilters(
  cursor: LabCursorPayload,
  filters: Record<string, unknown>,
  kind: LabCursorPayload["k"],
): void {
  if (cursor.k !== kind) throw new InvalidCursorError();
  const expected = stableFilterKey(filters);
  const actual = (cursor as { f: string }).f;
  if (actual !== expected) throw new InvalidCursorError();
}

export function filterKeyFor(filters: Record<string, unknown>): string {
  return stableFilterKey(filters);
}

export function verdictCursor(asOf: number, projectionKey: string, filters: Record<string, unknown>): VerdictCursorPayload {
  return { v: LAB_QUERY_CURSOR_VERSION, k: "verdicts", a: asOf, p: projectionKey, f: stableFilterKey(filters) };
}

export function observationCursor(completedAt: number, eventId: string, filters: Record<string, unknown>): ObservationCursorPayload {
  return { v: LAB_QUERY_CURSOR_VERSION, k: "observations", c: completedAt, e: eventId, f: stableFilterKey(filters) };
}

export function eventCursor(recordedAt: number, eventId: string, filters: Record<string, unknown>): EventCursorPayload {
  return { v: LAB_QUERY_CURSOR_VERSION, k: "events", r: recordedAt, e: eventId, f: stableFilterKey(filters) };
}

export function subjectCursor(subjectId: string, filters: Record<string, unknown>): SubjectCursorPayload {
  return { v: LAB_QUERY_CURSOR_VERSION, k: "subjects", s: subjectId, f: stableFilterKey(filters) };
}

export function artifactCursor(digest: string, filters: Record<string, unknown>): ArtifactCursorPayload {
  return { v: LAB_QUERY_CURSOR_VERSION, k: "artifacts", d: digest, f: stableFilterKey(filters) };
}
