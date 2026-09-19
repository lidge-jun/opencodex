import { readUsageSnapshotForManagement } from "../../usage/log";
import { createTimelineAccumulator, parseTimelineQuery } from "../../usage/timeline";
import { jsonResponse } from "../auth-cors";
import type { ManagementContext } from "./context";

const TIMELINE_CACHE_TTL_MS = 15_000;
const cache = new Map<string, { expiresAt: number; promise: Promise<ReturnType<ReturnType<typeof createTimelineAccumulator>["finish"]>> }>();

export async function handleUsageTimelineRoutes(ctx: ManagementContext): Promise<Response | undefined> {
  const { req, url } = ctx;
  if (url.pathname !== "/api/usage/timeline" || req.method !== "GET") return undefined;
  const query = parseTimelineQuery(url.searchParams, Date.now());
  if ("error" in query) return jsonResponse(query, 400, req, ctx.config);
  const bucketMs = query.bucketMinutes * 60_000;
  const roundedNow = Math.floor(query.now / bucketMs) * bucketMs;
  const normalized = { ...query, now: roundedNow };
  const key = JSON.stringify(normalized);
  const current = Date.now();
  const cached = cache.get(key);
  if (cached && cached.expiresAt > current) return jsonResponse(await cached.promise, 200, req, ctx.config);
  let promise: Promise<ReturnType<ReturnType<typeof createTimelineAccumulator>["finish"]>>;
  promise = (async () => {
    const accumulator = createTimelineAccumulator(normalized);
    const snapshot = await readUsageSnapshotForManagement(ctx.config.managementUsageMaxReadBytes);
    for (const entry of snapshot.entries) accumulator.add(entry);
    return {
      ...accumulator.finish(),
      truncated: snapshot.truncatedPrefixBytes > 0 || snapshot.entriesTruncated,
    };
  })().catch(error => {
    const entry = cache.get(key);
    if (entry?.promise === promise) cache.delete(key);
    throw error;
  });
  cache.set(key, { expiresAt: current + TIMELINE_CACHE_TTL_MS, promise });
  try {
    return jsonResponse(await promise, 200, req, ctx.config);
  } finally {
    setTimeout(() => {
      const entry = cache.get(key);
      if (entry?.promise === promise && entry.expiresAt <= Date.now()) cache.delete(key);
    }, TIMELINE_CACHE_TTL_MS + 1);
  }
}
