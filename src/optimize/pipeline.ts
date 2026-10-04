import type { OcxConfig } from "../types/config";
import type { OcxParsedRequest } from "../types/request";
import type { RequestLogContext } from "../server/request-log";
import { compressParsedMessages, compressRawBody, formatRtkLog } from "./rtk";
import { injectPonytail, injectPonytailToRawBody } from "./ponytail";
import { compressWithHeadroom, compressRawBodyWithHeadroom } from "./headroom";

export async function applyOptimizations(
  parsed: OcxParsedRequest,
  config: OcxConfig,
  logCtx?: RequestLogContext,
): Promise<void> {
  const opt = config.optimize;
  if (!opt) return;

  // 1. RTK compression (fail-open)
  if (opt.rtkEnabled !== false) {
    try {
      const statsContext = compressParsedMessages(parsed, true);
      const statsRaw = compressRawBody(parsed._rawBody, true);
      const hits = [...(statsContext?.hits ?? []), ...(statsRaw?.hits ?? [])];
      const bytesBefore = (statsContext?.bytesBefore ?? 0) + (statsRaw?.bytesBefore ?? 0);
      const bytesAfter = (statsContext?.bytesAfter ?? 0) + (statsRaw?.bytesAfter ?? 0);
      const combined = { bytesBefore, bytesAfter, hits };
      if (combined.hits.length > 0) {
        const logLine = formatRtkLog(combined);
        if (logLine) {
          console.log(`[Optimize] ${logLine}`);
        }
      }
    } catch (e) {
      console.warn("[Optimize] RTK error:", (e as any)?.message || e);
    }
  }

  // 2. Headroom context compression (fail-open)
  if (opt.headroomEnabled === true && opt.headroomUrl) {
    try {
      const headroomStats = await compressWithHeadroom(parsed, {
        enabled: true,
        url: opt.headroomUrl,
        timeoutMs: opt.headroomTimeoutMs,
        model: parsed.modelId,
      });
      if (headroomStats && (headroomStats.tokens_saved ?? 0) > 0) {
        console.log(
          `[Optimize] [Headroom] compressed context: saved ${headroomStats.tokens_saved} tokens (${headroomStats.tokens_before} → ${headroomStats.tokens_after})`,
        );
      }
    } catch (e) {
      console.warn("[Optimize] Headroom error:", (e as any)?.message || e);
    }
  }

  // 3. Ponytail lazy senior dev instructions (fail-open)
  if (opt.ponytailEnabled === true) {
    try {
      injectPonytail(parsed, opt.ponytailLevel || "full");
    } catch (e) {
      console.warn("[Optimize] Ponytail error:", (e as any)?.message || e);
    }
  }
}

export async function applyOptimizationsToRawBody(
  body: unknown,
  config: OcxConfig,
  modelId?: string,
  logCtx?: RequestLogContext,
): Promise<void> {
  const opt = config.optimize;
  if (!opt || !body || typeof body !== "object") return;

  // 1. RTK compression (fail-open)
  if (opt.rtkEnabled !== false) {
    try {
      const stats = compressRawBody(body, true);
      if (stats && stats.hits.length > 0) {
        const logLine = formatRtkLog(stats);
        if (logLine) {
          console.log(`[Optimize] ${logLine}`);
        }
      }
    } catch (e) {
      console.warn("[Optimize] RTK error:", (e as any)?.message || e);
    }
  }

  // 2. Headroom context compression (fail-open)
  if (opt.headroomEnabled === true && opt.headroomUrl) {
    try {
      const headroomStats = await compressRawBodyWithHeadroom(body, {
        enabled: true,
        url: opt.headroomUrl,
        timeoutMs: opt.headroomTimeoutMs,
        model: modelId,
      });
      if (headroomStats && (headroomStats.tokens_saved ?? 0) > 0) {
        console.log(
          `[Optimize] [Headroom] compressed context: saved ${headroomStats.tokens_saved} tokens (${headroomStats.tokens_before} → ${headroomStats.tokens_after})`,
        );
      }
    } catch (e) {
      console.warn("[Optimize] Headroom error:", (e as any)?.message || e);
    }
  }

  // 3. Ponytail lazy senior dev instructions (fail-open)
  if (opt.ponytailEnabled === true) {
    try {
      injectPonytailToRawBody(body, opt.ponytailLevel || "full");
    } catch (e) {
      console.warn("[Optimize] Ponytail error:", (e as any)?.message || e);
    }
  }
}
