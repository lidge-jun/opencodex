import { validateTelemetryPayloadV1 } from "../../../src/telemetry/contract";
import type { CollectorEnv, D1PreparedStatement } from "./types";

export const MAX_INGEST_BODY_BYTES = 16 * 1024;
export const MAX_REPORTS_PER_HOUR = 120;
export const MAX_VERSION_LENGTH = 32;
export const MAX_REPORT_REQUEST_COUNT = 10_000_000;
export const MAX_REPORT_TOKEN_COUNT = 1_000_000_000_000;
const MAX_SAFE_SQL_INT = Number.MAX_SAFE_INTEGER;
const HOUR_MS = 3_600_000;

export function formatBucketHour(now: number): string {
  return new Date(now).toISOString().slice(0, 13);
}

export function extractClientIp(request: Request): string {
  const cfIp = request.headers.get("cf-connecting-ip")?.trim();
  if (cfIp) return cfIp;
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim();
    if (first) return first;
  }
  return "0.0.0.0";
}

export async function computeHourlyIpHash(
  salt: string,
  ip: string,
  bucketHour: string,
): Promise<string> {
  const bytes = new TextEncoder().encode(`${salt}\0${bucketHour}\0${ip}`);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const view = new Uint8Array(digest);
  let hex = "";
  for (let i = 0; i < view.length; i++) {
    hex += view[i]!.toString(16).padStart(2, "0");
  }
  return hex;
}

function jsonResult(body: Record<string, unknown>, status: number, extraHeaders?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...(extraHeaders ?? {}),
    },
  });
}

function clampedAddSql(column: string, deltaExpr: string): string {
  return `CASE WHEN ${column} >= ${MAX_SAFE_SQL_INT} - (${deltaExpr}) THEN ${MAX_SAFE_SQL_INT} ELSE ${column} + (${deltaExpr}) END`;
}

async function readBoundedBody(
  request: Request,
  maxBytes: number,
): Promise<{ ok: true; bytes: Uint8Array } | { ok: false; status: 400 | 413; error: string }> {
  const contentLengthHeader = request.headers.get("content-length");
  if (contentLengthHeader !== null) {
    const trimmed = contentLengthHeader.trim();
    if (!/^\d+$/.test(trimmed)) {
      return { ok: false, status: 400, error: "invalid content-length header" };
    }
    const declaredLength = Number(trimmed);
    if (!Number.isSafeInteger(declaredLength) || declaredLength > maxBytes) {
      return { ok: false, status: 413, error: "payload exceeds 16 KiB limit" };
    }
  }

  if (!request.body) {
    return { ok: false, status: 400, error: "request body is empty" };
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value && value.byteLength > 0) {
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        try {
          await reader.cancel();
        } catch {
          // Ignore stream cancellation errors once the size limit is exceeded.
        }
        return { ok: false, status: 413, error: "payload exceeds 16 KiB limit" };
      }
      chunks.push(value);
    }
  }

  if (totalBytes === 0) {
    return { ok: false, status: 400, error: "request body is empty" };
  }

  const rawBytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    rawBytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, bytes: rawBytes };
}

export async function handleIngest(
  request: Request,
  env: CollectorEnv,
  now: number = Date.now(),
): Promise<Response> {
  const rateLimitSalt = typeof env.RATE_LIMIT_SALT === "string" ? env.RATE_LIMIT_SALT.trim() : "";
  if (rateLimitSalt.length === 0) {
    return jsonResult({ ok: false, error: "collector rate-limit salt is not configured" }, 503);
  }

  const contentType = request.headers.get("content-type") ?? "";
  if (!/^application\/json\b/i.test(contentType.trim())) {
    return jsonResult({ ok: false, error: "content-type must be application/json" }, 400);
  }

  const bodyResult = await readBoundedBody(request, MAX_INGEST_BODY_BYTES);
  if (!bodyResult.ok) {
    return jsonResult({ ok: false, error: bodyResult.error }, bodyResult.status);
  }
  const rawBytes = bodyResult.bytes;

  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(rawBytes));
  } catch {
    return jsonResult({ ok: false, error: "invalid JSON body" }, 400);
  }

  const validated = validateTelemetryPayloadV1(parsed, now);
  if (!validated.ok) {
    return jsonResult({ ok: false, error: validated.error }, 400);
  }

  const payload = validated.payload;
  if (payload.env.version.length > MAX_VERSION_LENGTH) {
    return jsonResult({ ok: false, error: "env.version exceeds maximum length of 32 characters" }, 400);
  }

  const totalOutcomeRequests =
    payload.requests.completed +
    payload.requests.failed +
    payload.requests.incomplete +
    payload.requests.aborted;
  if (totalOutcomeRequests > MAX_REPORT_REQUEST_COUNT) {
    return jsonResult({ ok: false, error: "total requests exceed per-report limit" }, 400);
  }

  let totalModelRequests = 0;
  let totalInput = 0;
  let totalCacheRead = 0;
  let totalCacheWrite = 0;
  let totalOutput = 0;
  let totalReasoning = 0;
  for (const row of payload.models) {
    const rowTokens =
      row.inputTokens +
      row.cacheReadTokens +
      row.cacheWriteTokens +
      row.outputTokens +
      row.reasoningTokens;
    if (row.requests === 0 && rowTokens > 0) {
      return jsonResult({ ok: false, error: "model row with zero requests cannot report tokens" }, 400);
    }
    if (rowTokens > MAX_REPORT_TOKEN_COUNT) {
      return jsonResult({ ok: false, error: "model row tokens exceed per-report limit" }, 400);
    }
    totalModelRequests += row.requests;
    totalInput += row.inputTokens;
    totalCacheRead += row.cacheReadTokens;
    totalCacheWrite += row.cacheWriteTokens;
    totalOutput += row.outputTokens;
    totalReasoning += row.reasoningTokens;
  }
  const totalReportTokens =
    totalInput + totalCacheRead + totalCacheWrite + totalOutput + totalReasoning;
  if (totalModelRequests > MAX_REPORT_REQUEST_COUNT) {
    return jsonResult({ ok: false, error: "total model requests exceed per-report limit" }, 400);
  }
  if (totalReportTokens > MAX_REPORT_TOKEN_COUNT) {
    return jsonResult({ ok: false, error: "total report tokens exceed per-report limit" }, 400);
  }

  let totalErrorCount = 0;
  for (const count of Object.values(payload.errors)) {
    if (typeof count === "number" && count > 0) {
      totalErrorCount += count;
    }
  }
  if (totalErrorCount > MAX_REPORT_REQUEST_COUNT) {
    return jsonResult({ ok: false, error: "total error count exceeds per-report limit" }, 400);
  }

  const bucketHour = formatBucketHour(now);
  const ipHash = await computeHourlyIpHash(
    rateLimitSalt,
    extractClientIp(request),
    bucketHour,
  );
  const rateResult = await env.DB
    .prepare(
      "INSERT INTO rate_limits (bucket_hour, ip_hash, hits) VALUES (?1, ?2, 1) " +
      "ON CONFLICT(bucket_hour, ip_hash) DO UPDATE SET hits = hits + 1 WHERE rate_limits.hits < ?3",
    )
    .bind(bucketHour, ipHash, MAX_REPORTS_PER_HOUR)
    .run();
  if (Number(rateResult.meta?.changes ?? 0) === 0) {
    const nextHourMs = (Math.floor(now / HOUR_MS) + 1) * HOUR_MS;
    const retryAfterSeconds = Math.max(1, Math.ceil((nextHourMs - now) / 1000));
    return jsonResult(
      { ok: false, error: "rate limit exceeded" },
      429,
      { "retry-after": String(retryAfterSeconds) },
    );
  }

  const rollupStatements: D1PreparedStatement[] = [
    env.DB
      .prepare(
        "INSERT INTO daily_totals (" +
        "day, reports, new_installs, active_minutes, " +
        "completed, failed, incomplete, aborted, " +
        "input, cache_read, cache_write, output, reasoning" +
        ") SELECT ?1, 1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12 " +
        "WHERE NOT EXISTS (SELECT 1 FROM daily_installs WHERE day = ?1 AND install_day_hash = ?13) " +
        "ON CONFLICT(day) DO UPDATE SET " +
        `reports = ${clampedAddSql("reports", "1")}, ` +
        `new_installs = ${clampedAddSql("new_installs", "excluded.new_installs")}, ` +
        `active_minutes = ${clampedAddSql("active_minutes", "excluded.active_minutes")}, ` +
        `completed = ${clampedAddSql("completed", "excluded.completed")}, ` +
        `failed = ${clampedAddSql("failed", "excluded.failed")}, ` +
        `incomplete = ${clampedAddSql("incomplete", "excluded.incomplete")}, ` +
        `aborted = ${clampedAddSql("aborted", "excluded.aborted")}, ` +
        `input = ${clampedAddSql("input", "excluded.input")}, ` +
        `cache_read = ${clampedAddSql("cache_read", "excluded.cache_read")}, ` +
        `cache_write = ${clampedAddSql("cache_write", "excluded.cache_write")}, ` +
        `output = ${clampedAddSql("output", "excluded.output")}, ` +
        `reasoning = ${clampedAddSql("reasoning", "excluded.reasoning")}`,
      )
      .bind(
        payload.day,
        payload.newInstall ? 1 : 0,
        payload.activeMinutes,
        payload.requests.completed,
        payload.requests.failed,
        payload.requests.incomplete,
        payload.requests.aborted,
        totalInput,
        totalCacheRead,
        totalCacheWrite,
        totalOutput,
        totalReasoning,
        payload.installDayHash,
      ),
  ];

  for (const row of payload.models) {
    if (row.requests <= 0) continue;
    rollupStatements.push(
      env.DB
        .prepare(
          "INSERT INTO daily_models (" +
          "day, provider_kind, model_family, installs, requests, " +
          "input, cache_read, cache_write, output, reasoning" +
          ") SELECT ?1, ?2, ?3, 1, ?4, ?5, ?6, ?7, ?8, ?9 " +
          "WHERE NOT EXISTS (SELECT 1 FROM daily_installs WHERE day = ?1 AND install_day_hash = ?10) " +
          "ON CONFLICT(day, provider_kind, model_family) DO UPDATE SET " +
          `installs = ${clampedAddSql("installs", "1")}, ` +
          `requests = ${clampedAddSql("requests", "excluded.requests")}, ` +
          `input = ${clampedAddSql("input", "excluded.input")}, ` +
          `cache_read = ${clampedAddSql("cache_read", "excluded.cache_read")}, ` +
          `cache_write = ${clampedAddSql("cache_write", "excluded.cache_write")}, ` +
          `output = ${clampedAddSql("output", "excluded.output")}, ` +
          `reasoning = ${clampedAddSql("reasoning", "excluded.reasoning")}`,
        )
        .bind(
          payload.day,
          row.providerKind,
          row.modelFamily,
          row.requests,
          row.inputTokens,
          row.cacheReadTokens,
          row.cacheWriteTokens,
          row.outputTokens,
          row.reasoningTokens,
          payload.installDayHash,
        ),
    );
  }

  for (const [cause, count] of Object.entries(payload.errors)) {
    if (typeof count === "number" && count > 0) {
      rollupStatements.push(
        env.DB
          .prepare(
            "INSERT INTO daily_errors (day, cause, installs, count) " +
            "SELECT ?1, ?2, 1, ?3 " +
            "WHERE NOT EXISTS (SELECT 1 FROM daily_installs WHERE day = ?1 AND install_day_hash = ?4) " +
            "ON CONFLICT(day, cause) DO UPDATE SET " +
            `installs = ${clampedAddSql("installs", "1")}, ` +
            `count = ${clampedAddSql("count", "excluded.count")}`,
          )
          .bind(payload.day, cause, count, payload.installDayHash),
      );
    }
  }

  rollupStatements.push(
    env.DB
      .prepare(
        "INSERT OR IGNORE INTO daily_installs " +
        "(day, install_day_hash, version, release_channel, os, arch, install_channel, new_install, active_minutes) " +
        "VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
      )
      .bind(
        payload.day,
        payload.installDayHash,
        payload.env.version,
        payload.env.releaseChannel,
        payload.env.os,
        payload.env.arch,
        payload.env.installChannel,
        payload.newInstall ? 1 : 0,
        payload.activeMinutes,
      ),
  );

  const batchResults = await env.DB.batch(rollupStatements);
  const installInsertResult = batchResults[batchResults.length - 1];
  const insertedNewInstallDay = Number(installInsertResult?.meta?.changes ?? 0) > 0;
  return jsonResult({ ok: true, deduplicated: !insertedNewInstallDay }, 200);
}
