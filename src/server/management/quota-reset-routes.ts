/**
 * Read-only view of recently detected quota resets.
 *
 * Loaded on demand from src/server/management-api.ts, which is the FOURTH entry in the protected
 * set of tests/core-lab-boundary.test.ts — added precisely because eagerly importing handlers
 * there put ~70 modules on every dashboard request. A static import here would make this
 * subsystem the next instance of that bug.
 *
 * Authentication is inherited: every /api route passes through requireManagementAuth before the
 * chain runs, so a read-only GET adds no auth code of its own. It spends no user identity and
 * mutates nothing.
 */

import { jsonResponse } from "../auth-cors";
import type { ManagementContext } from "./context";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

export async function handleQuotaResetRoutes(ctx: ManagementContext): Promise<Response | null> {
  const { url, req, config } = ctx;
  if (url.pathname !== "/api/quota-resets") return null;
  if (req.method !== "GET") return null;

  const rawLimit = url.searchParams.get("limit");
  if (rawLimit !== null && !/^\d+$/.test(rawLimit)) {
    return jsonResponse(
      { error: { code: "invalid_limit", message: "limit must be a non-negative integer" } },
      400,
      req,
      config,
    );
  }
  const limit = rawLimit === null
    ? DEFAULT_LIMIT
    : Math.min(MAX_LIMIT, Number.parseInt(rawLimit, 10));

  // Imported here rather than at module scope so a dashboard request that never touches this
  // route does not load the store or its state file.
  const [{ listRecentQuotaResetEvents }, { isQuotaResetNotificationEnabled }] = await Promise.all([
    import("../../quota/reset-seen-store"),
    import("../../quota/reset-notify-config"),
  ]);

  // `enabled` is reported alongside the events because an empty list is ambiguous on its own:
  // it means either "nothing has reset" or "detection was never turned on", and an operator
  // debugging a missing notification needs to tell those apart.
  return jsonResponse(
    {
      enabled: isQuotaResetNotificationEnabled(),
      events: listRecentQuotaResetEvents(limit),
    },
    200,
    req,
    config,
  );
}
