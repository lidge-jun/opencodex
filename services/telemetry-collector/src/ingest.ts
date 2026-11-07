import { validateTelemetryPayloadV1 } from "../../../src/telemetry/contract";
import type { CollectorEnv, D1PreparedStatement } from "./types";

export const MAX_INGEST_BODY_BYTES = 16 * 1024;
export const MAX_REPORTS_PER_HOUR = 30;
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
  const bytes = new TextEncoder().encode(`${salt}${ip}${bucketHour}`);
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

export async function handleIngest(
  request: Request,
  env: CollectorEnv,
  now: number = Date.now(),
): Promise<Response> {
  const contentLengthHeader = request.headers.get("content-length");
  if (contentLengthHeader !== null) {
    const declaredLength = Number(contentLengthHeader);
    if (Number.isFinite(declaredLength) && declaredLength > MAX_INGEST_BODY_BYTES) {
      return jsonResult({ ok: false, error: "payload exceeds 16 KiB limit" }, 413);
    }
  }

  const contentType = request.headers.get("content-type") ?? "";
  if (!/^application\/json\b/i.test(contentType.trim())) {
    return jsonResult({ ok: false, error: "content-type must be application/json" }, 400);
  }

  const rawBytes = new Uint8Array(await request.arrayBuffer());
  if (rawBytes.byteLength > MAX_INGEST_BODY_BYTES) {
    return jsonResult({ ok: false, error: "payload exceeds 16 KiB limit" }, 413);
  }
  if (rawBytes.byteLength === 0) {
    return jsonResult({ ok: false, error: "request body is empty" }, 400);
  }

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

  const bucketHour = formatBucketHour(now);
  const ipHash = await computeHourlyIpHash(
    env.RATE_LIMIT_SALT ?? "opencodex-telemetry-default-salt",
    extractClientIp(request),
    bucketHour,
  );
  const existingRate = await env.DB
    .prepare("SELECT hits FROM rate_limits WHERE bucket_hour = ?1 AND ip_hash = ?2")
    .bind(bucketHour, ipHash)
    .first<{ hits: number }>();
  const currentHits = Number(existingRate?.hits ?? 0);
  if (currentHits >= MAX_REPORTS_PER_HOUR) {
    const nextHourMs = (Math.floor(now / HOUR_MS) + 1) * HOUR_MS;
    const retryAfterSeconds = Math.max(1, Math.ceil((nextHourMs - now) / 1000));
    return jsonResult(
      { ok: false, error: "rate limit exceeded" },
      429,
      { "retry-after": String(retryAfterSeconds) },
    );
  }

  await env.DB
    .prepare(
      "INSERT INTO rate_limits (bucket_hour, ip_hash, hits) VALUES (?1, ?2, 1) " +
      "ON CONFLICT(bucket_hour, ip_hash) DO UPDATE SET hits = hits + 1",
    )
    .bind(bucketHour, ipHash)
    .run();

  const payload = validated.payload;
  const insertInstallResult = await env.DB
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
    )
    .run();

  const insertedNewInstallDay = Number(insertInstallResult.meta?.changes ?? 0) > 0;
  if (!insertedNewInstallDay) {
    return jsonResult({ ok: true, deduplicated: true }, 200);
  }

  let totalInput = 0;
  let totalCacheRead = 0;
  let totalCacheWrite = 0;
  let totalOutput = 0;
  let totalReasoning = 0;
  for (const row of payload.models) {
    totalInput += row.inputTokens;
    totalCacheRead += row.cacheReadTokens;
    totalCacheWrite += row.cacheWriteTokens;
    totalOutput += row.outputTokens;
    totalReasoning += row.reasoningTokens;
  }

  const rollupStatements: D1PreparedStatement[] = [
    env.DB
      .prepare(
        "INSERT INTO daily_totals (" +
        "day, reports, new_installs, active_minutes, " +
        "completed, failed, incomplete, aborted, " +
        "input, cache_read, cache_write, output, reasoning" +
        ") VALUES (?1, 1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12) " +
        "ON CONFLICT(day) DO UPDATE SET " +
        "reports = reports + 1, " +
        "new_installs = new_installs + excluded.new_installs, " +
        "active_minutes = active_minutes + excluded.active_minutes, " +
        "completed = completed + excluded.completed, " +
        "failed = failed + excluded.failed, " +
        "incomplete = incomplete + excluded.incomplete, " +
        "aborted = aborted + excluded.aborted, " +
        "input = input + excluded.input, " +
        "cache_read = cache_read + excluded.cache_read, " +
        "cache_write = cache_write + excluded.cache_write, " +
        "output = output + excluded.output, " +
        "reasoning = reasoning + excluded.reasoning",
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
      ),
  ];

  for (const row of payload.models) {
    rollupStatements.push(
      env.DB
        .prepare(
          "INSERT INTO daily_models (" +
          "day, provider_kind, model_family, requests, " +
          "input, cache_read, cache_write, output, reasoning" +
          ") VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9) " +
          "ON CONFLICT(day, provider_kind, model_family) DO UPDATE SET " +
          "requests = requests + excluded.requests, " +
          "input = input + excluded.input, " +
          "cache_read = cache_read + excluded.cache_read, " +
          "cache_write = cache_write + excluded.cache_write, " +
          "output = output + excluded.output, " +
          "reasoning = reasoning + excluded.reasoning",
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
        ),
    );
  }

  for (const [cause, count] of Object.entries(payload.errors)) {
    if (typeof count === "number" && count > 0) {
      rollupStatements.push(
        env.DB
          .prepare(
            "INSERT INTO daily_errors (day, cause, count) VALUES (?1, ?2, ?3) " +
            "ON CONFLICT(day, cause) DO UPDATE SET count = count + excluded.count",
          )
          .bind(payload.day, cause, count),
      );
    }
  }

  await env.DB.batch(rollupStatements);
  return jsonResult({ ok: true, deduplicated: false }, 200);
}
