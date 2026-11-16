import { jsonResponse } from "../../server/auth-cors";
import { hasHumanDashboardSession } from "../../server/management/consent-session";
import type { ManagementContext } from "../../server/management/context";
import {
  ProfileActionError,
  buildProfileStatusSnapshot,
  connectTelemetryProfile,
  disconnectTelemetryProfile,
  fetchConnectedProfileRank,
} from "./service";
import { isProfileSchedulerRunning, nudgeProfileScheduler, startProfileScheduler } from "./sync";

/**
 * Management routes for the opt-in public profile (`/api/telemetry/profile`). Connecting needs a
 * human dashboard session, like the telemetry decision; reading and disconnecting do not, because
 * leaving must always be possible. No response ever carries the profile secret.
 */

function errorResponse(ctx: ManagementContext, error: ProfileActionError): Response {
  return jsonResponse({ ok: false, code: error.code, error: error.message }, error.status, ctx.req, ctx.config);
}

export async function handleGetProfileRoute(ctx: ManagementContext): Promise<Response> {
  const snapshot = await buildProfileStatusSnapshot({ cachePreview: true });
  // A profile connected from the CLI while this proxy runs: start its loop on the next read.
  if ((snapshot.connected || snapshot.unreadable) && !isProfileSchedulerRunning()) startProfileScheduler();
  return jsonResponse({ ok: true, ...snapshot }, 200, ctx.req, ctx.config);
}

export async function handleGetProfileRankRoute(ctx: ManagementContext): Promise<Response> {
  const result = await fetchConnectedProfileRank();
  if (!result.ok) {
    const status = result.code === "not_connected" ? 404 : result.code === "revoked" ? 410 : 502;
    return jsonResponse({ ok: false, code: result.code, error: result.error }, status, ctx.req, ctx.config);
  }
  return jsonResponse({ ok: true, rank: result.rank }, 200, ctx.req, ctx.config);
}

export async function handlePostProfileRoute(ctx: ManagementContext): Promise<Response> {
  if (!hasHumanDashboardSession(ctx)) {
    return jsonResponse(
      {
        ok: false,
        code: "agent_consent_required",
        error: "Connecting a public profile requires a human dashboard session.",
        message:
          "Refused: this request carries no human dashboard session. A public profile must be connected by the user in the dashboard or an interactive terminal.",
      },
      403,
      ctx.req,
      ctx.config,
    );
  }
  let body: unknown;
  try {
    body = await ctx.req.json();
  } catch {
    return jsonResponse({ ok: false, code: "invalid_json", error: "invalid JSON body" }, 400, ctx.req, ctx.config);
  }
  const record = body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : null;
  if (!record || record.acknowledgePublic !== true) {
    return jsonResponse(
      { ok: false, code: "acknowledgement_required", error: "acknowledgePublic must be true: the profile is public." },
      400,
      ctx.req,
      ctx.config,
    );
  }
  try {
    const profile = await connectTelemetryProfile({
      handle: record.handle,
      displayName: record.displayName,
      avatar: record.avatar,
    });
    nudgeProfileScheduler();
    const snapshot = await buildProfileStatusSnapshot();
    return jsonResponse({ ok: true, ...snapshot, profile }, 200, ctx.req, ctx.config);
  } catch (error) {
    if (error instanceof ProfileActionError) return errorResponse(ctx, error);
    throw error;
  }
}

export async function handleDeleteProfileRoute(ctx: ManagementContext): Promise<Response> {
  try {
    const outcome = await disconnectTelemetryProfile();
    if (outcome.status === "deletion_pending") nudgeProfileScheduler();
    return jsonResponse(
      { ok: true, status: outcome.status, deleted: outcome.status === "deleted" || outcome.status === "not_connected" },
      200,
      ctx.req,
      ctx.config,
    );
  } catch (error) {
    if (error instanceof ProfileActionError) return errorResponse(ctx, error);
    throw error;
  }
}

