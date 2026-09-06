import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { getConfigDir } from "../config/paths";
import { computeFailureFingerprint, sanitizeSignature } from "./fingerprint";
import type { FailureEvent, FailureFingerprint, LedgerRecord, RemediationStatus } from "./types";

export interface TelemetryLedgerOptions {
  maxRecords?: number;
  maxOccurrences?: number;
}

interface StoredRow {
  fingerprint: string;
  first_seen: number;
  last_seen: number;
  count: number;
  status: RemediationStatus;
  details: string | null;
  occurrences: string;
}

const FORBIDDEN_DETAILS_KEY = /^(prompt|response|body|headers?|authorization|auth|api[_-]?key|key|token|secret|credential|password|account|cookie|path)/i;

function parseStoredDetails(raw: string | null): Record<string, unknown> | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw);
    return sanitizeDetails(parsed);
  } catch {
    return undefined;
  }
}

export function sanitizeDetails(details?: Record<string, unknown>): Record<string, unknown> | undefined {
  if (!details || typeof details !== "object" || Array.isArray(details)) return undefined;
  const safe: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(details)) {
    if (FORBIDDEN_DETAILS_KEY.test(k)) continue;
    if (typeof v === "string") {
      safe[k] = sanitizeSignature(v).slice(0, 256);
    } else if (typeof v === "number" || typeof v === "boolean") {
      safe[k] = v;
    }
  }
  return Object.keys(safe).length > 0 ? safe : undefined;
}

export class TelemetryLedger {
  private readonly db: Database;
  private readonly maxRecords: number;
  private readonly maxOccurrences: number;

  constructor(path?: string, options: TelemetryLedgerOptions = {}) {
    const resolvedPath = path ?? join(getConfigDir(), "telemetry-issues.sqlite");
    if (resolvedPath !== ":memory:") {
      mkdirSync(dirname(resolvedPath), { recursive: true });
    }
    this.db = new Database(resolvedPath, { create: true });
    this.maxRecords = options.maxRecords ?? 1000;
    this.maxOccurrences = options.maxOccurrences ?? 100;
    this.db.run(
      "CREATE TABLE IF NOT EXISTS failure_events (" +
      "fingerprint TEXT PRIMARY KEY, " +
      "first_seen INTEGER NOT NULL, " +
      "last_seen INTEGER NOT NULL, " +
      "count INTEGER NOT NULL, " +
      "status TEXT NOT NULL, " +
      "details TEXT, " +
      "occurrences TEXT NOT NULL" +
      ")"
    );
  }

  recordFailure(event: FailureEvent, windowMs: number, details?: Record<string, unknown>): LedgerRecord {
    const fingerprint = computeFailureFingerprint(event);
    const timestamp = typeof event.timestamp === "number" && Number.isFinite(event.timestamp) ? event.timestamp : Date.now();
    const old = this.db.query("SELECT * FROM failure_events WHERE fingerprint = ?").get(fingerprint) as StoredRow | null;

    let priorOccurrences: number[] = [];
    if (old?.occurrences) {
      try {
        const parsed = JSON.parse(old.occurrences);
        if (Array.isArray(parsed)) priorOccurrences = parsed;
      } catch {
        priorOccurrences = [];
      }
    }

    const lastSeen = Math.max(old?.last_seen ?? timestamp, timestamp);
    const minTimestamp = lastSeen - Math.max(0, windowMs);
    const occurrences = [...priorOccurrences, timestamp]
      .filter(seen => Number.isFinite(seen) && seen >= minTimestamp && seen <= lastSeen)
      .sort((a, b) => a - b)
      .slice(-this.maxOccurrences);

    const mergedDetails = {
      ...(parseStoredDetails(old?.details ?? null) ?? {}),
      ...(sanitizeDetails(details) ?? {}),
    };
    const cleanDetails = Object.keys(mergedDetails).length > 0 ? mergedDetails : undefined;

    const record: LedgerRecord = {
      fingerprint,
      firstSeen: Math.min(old?.first_seen ?? timestamp, timestamp),
      lastSeen,
      count: occurrences.length,
      status: old?.status ?? "monitoring",
      ...(cleanDetails ? { details: cleanDetails } : {}),
    };

    this.db.query(
      "INSERT INTO failure_events (fingerprint, first_seen, last_seen, count, status, details, occurrences) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?) " +
      "ON CONFLICT(fingerprint) DO UPDATE SET " +
      "first_seen=excluded.first_seen, " +
      "last_seen=excluded.last_seen, " +
      "count=excluded.count, " +
      "status=excluded.status, " +
      "details=excluded.details, " +
      "occurrences=excluded.occurrences"
    ).run(
      fingerprint,
      record.firstSeen,
      record.lastSeen,
      record.count,
      record.status,
      cleanDetails ? JSON.stringify(cleanDetails) : null,
      JSON.stringify(occurrences),
    );

    this.pruneIfNeeded();
    return record;
  }

  getRecord(fingerprint: FailureFingerprint): LedgerRecord | null {
    const row = this.db.query(
      "SELECT fingerprint, first_seen, last_seen, count, status, details FROM failure_events WHERE fingerprint = ?"
    ).get(fingerprint) as {
      fingerprint: string;
      first_seen: number;
      last_seen: number;
      count: number;
      status: RemediationStatus;
      details: string | null;
    } | null;

    if (!row) return null;
    const details = parseStoredDetails(row.details);
    return {
      fingerprint: row.fingerprint,
      firstSeen: row.first_seen,
      lastSeen: row.last_seen,
      count: row.count,
      status: row.status,
      ...(details ? { details } : {}),
    };
  }

  updateStatus(fingerprint: FailureFingerprint, status: RemediationStatus, details?: Record<string, unknown>): void {
    if (details === undefined) {
      this.db.query("UPDATE failure_events SET status = ? WHERE fingerprint = ?").run(status, fingerprint);
      return;
    }
    const row = this.db.query("SELECT details FROM failure_events WHERE fingerprint = ?").get(fingerprint) as {
      details: string | null;
    } | null;
    const mergedDetails = {
      ...(parseStoredDetails(row?.details ?? null) ?? {}),
      ...(sanitizeDetails(details) ?? {}),
    };
    const safeDetails = Object.keys(mergedDetails).length > 0 ? mergedDetails : undefined;
    this.db.query("UPDATE failure_events SET status = ?, details = ? WHERE fingerprint = ?").run(
      status,
      safeDetails ? JSON.stringify(safeDetails) : null,
      fingerprint,
    );
  }

  shouldDispatch(fingerprint: FailureFingerprint, threshold: number, windowMs: number): boolean {
    const row = this.db.query(
      "SELECT status, last_seen, occurrences FROM failure_events WHERE fingerprint = ?"
    ).get(fingerprint) as { status: RemediationStatus; last_seen: number; occurrences: string } | null;

    if (!row || row.status !== "monitoring") return false;
    let occurrences: number[] = [];
    try {
      const parsed = JSON.parse(row.occurrences);
      if (Array.isArray(parsed)) occurrences = parsed;
    } catch {
      return false;
    }
    const active = occurrences.filter(seen => seen >= row.last_seen - Math.max(0, windowMs));
    return active.length >= threshold;
  }

  listRecords(): LedgerRecord[] {
    const rows = this.db.query(
      "SELECT fingerprint, first_seen, last_seen, count, status, details FROM failure_events ORDER BY last_seen DESC"
    ).all() as Array<{
      fingerprint: string;
      first_seen: number;
      last_seen: number;
      count: number;
      status: RemediationStatus;
      details: string | null;
    }>;

    return rows.map(row => {
      const details = parseStoredDetails(row.details);
      return {
        fingerprint: row.fingerprint,
        firstSeen: row.first_seen,
        lastSeen: row.last_seen,
        count: row.count,
        status: row.status,
        ...(details ? { details } : {}),
      };
    });
  }

  private pruneIfNeeded(): void {
    if (this.maxRecords <= 0) return;
    const countRow = this.db.query("SELECT COUNT(*) as total FROM failure_events").get() as { total: number } | null;
    if (!countRow || countRow.total <= this.maxRecords) return;
    const excess = countRow.total - this.maxRecords;
    this.db.query(
      "DELETE FROM failure_events WHERE fingerprint IN (" +
      "SELECT fingerprint FROM failure_events " +
      "ORDER BY CASE status WHEN 'fixed' THEN 0 WHEN 'ignored' THEN 0 WHEN 'dispatched' THEN 1 ELSE 2 END, last_seen ASC LIMIT ?" +
      ")"
    ).run(excess);
  }

  close(): void {
    this.db.close();
  }
}
