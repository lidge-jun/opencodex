import { handleIngest } from "./ingest";
import { handleLeaderboard, handleProfileByHandle } from "./leaderboard";
import { profileError } from "./profile-http";
import {
  handleCreateProfile,
  handleDeleteOwnProfile,
  handleGetOwnProfile,
  handleSubmitProfileDay,
} from "./profiles";
import { pruneCollectorTables } from "./prune";
import { handleStats } from "./stats";
import type { CollectorEnv, ExecutionContext, ScheduledController } from "./types";

export const ALLOWED_CORS_ORIGINS = Object.freeze([
  "https://opencodex.me",
  "http://localhost:4321",
] as const);

const ALLOWED_ORIGIN_SET: ReadonlySet<string> = new Set(ALLOWED_CORS_ORIGINS);

export function resolveCorsHeaders(request: Request): Record<string, string> {
  const origin = request.headers.get("origin")?.trim() ?? "";
  if (!ALLOWED_ORIGIN_SET.has(origin)) {
    return { vary: "Origin" };
  }
  return {
    "access-control-allow-origin": origin,
    vary: "Origin",
  };
}

function withCors(request: Request, response: Response): Response {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(resolveCorsHeaders(request))) {
    headers.set(key, value);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function handlePreflight(request: Request, allowedMethods: string): Response {
  const headers = new Headers(resolveCorsHeaders(request));
  headers.set("access-control-allow-methods", allowedMethods);
  headers.set("access-control-allow-headers", "content-type");
  headers.set("access-control-max-age", "86400");
  return new Response(null, { status: 204, headers });
}

function jsonError(status: number, error: string, extraHeaders?: Record<string, string>): Response {
  return new Response(JSON.stringify({ ok: false, error }), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...(extraHeaders ?? {}),
    },
  });
}

/**
 * Opt-in profile routes. Write and bearer routes get no CORS preflight, so a browser page cannot
 * send the profile secret cross-origin; only the public reads are preflighted.
 */
async function handleProfileRoutes(
  request: Request,
  env: CollectorEnv,
  pathname: string,
  method: string,
  now: number,
): Promise<Response | null> {
  const methodNotAllowed = (allow: string) => profileError(405, "method not allowed", { allow });
  if (pathname === "/v1/leaderboard") {
    if (method === "OPTIONS") return handlePreflight(request, "GET, OPTIONS");
    if (method !== "GET") return withCors(request, methodNotAllowed("GET, OPTIONS"));
    return withCors(request, await handleLeaderboard(request, env, now));
  }
  const byHandle = /^\/v1\/profiles\/by-handle\/([^/]+)$/.exec(pathname);
  if (byHandle) {
    if (method === "OPTIONS") return handlePreflight(request, "GET, OPTIONS");
    if (method !== "GET") return withCors(request, methodNotAllowed("GET, OPTIONS"));
    return withCors(request, await handleProfileByHandle(request, env, byHandle[1]!, now));
  }
  if (pathname === "/v1/profiles") {
    if (method !== "POST") return methodNotAllowed("POST");
    return handleCreateProfile(request, env, now);
  }
  if (pathname === "/v1/profiles/me/days") {
    if (method !== "POST") return methodNotAllowed("POST");
    return handleSubmitProfileDay(request, env, now);
  }
  if (pathname === "/v1/profiles/me") {
    if (method === "GET") return handleGetOwnProfile(request, env, now);
    if (method === "DELETE") return handleDeleteOwnProfile(request, env, now);
    return methodNotAllowed("GET, DELETE");
  }
  return null;
}

export async function handleCollectorFetch(
  request: Request,
  env: CollectorEnv,
  _ctx?: ExecutionContext,
  now: number = Date.now(),
): Promise<Response> {
  try {
    const url = new URL(request.url);
    const pathname = url.pathname.replace(/\/+$/, "") || "/";
    const method = request.method.toUpperCase();

    if (pathname === "/v1/events") {
      if (method === "OPTIONS") {
        return handlePreflight(request, "POST, OPTIONS");
      }
      if (method !== "POST") {
        return withCors(
          request,
          jsonError(405, "method not allowed", { allow: "POST, OPTIONS" }),
        );
      }
      return withCors(request, await handleIngest(request, env, now));
    }

    if (pathname === "/v1/stats") {
      if (method === "OPTIONS") {
        return handlePreflight(request, "GET, OPTIONS");
      }
      if (method !== "GET") {
        return withCors(
          request,
          jsonError(405, "method not allowed", { allow: "GET, OPTIONS" }),
        );
      }
      return withCors(request, await handleStats(request, env, now));
    }

    if (pathname === "/v1/leaderboard" || pathname.startsWith("/v1/profiles")) {
      const profileResponse = await handleProfileRoutes(request, env, pathname, method, now);
      if (profileResponse) return profileResponse;
    }

    if (method === "OPTIONS") {
      return handlePreflight(request, "GET, POST, OPTIONS");
    }

    return withCors(request, jsonError(404, "not found"));
  } catch {
    return withCors(request, jsonError(500, "internal error"));
  }
}

export async function handleCollectorScheduled(
  controller: ScheduledController | undefined,
  env: CollectorEnv,
  ctx?: ExecutionContext,
): Promise<void> {
  const now = typeof controller?.scheduledTime === "number" ? controller.scheduledTime : Date.now();
  const task = pruneCollectorTables(env.DB, now);
  ctx?.waitUntil(task);
  await task;
}

const worker = {
  fetch: handleCollectorFetch,
  scheduled: handleCollectorScheduled,
};

export default worker;
