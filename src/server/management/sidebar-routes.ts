/**
 * /api/github/star and /api/update/badge — the two cheap polls behind the
 * sidebar's GitHub star and update controls.
 *
 * Both ride the standard management gate (auth + origin check happen before
 * dispatch), and both are scalar-only: a star state enum, a repo slug, version
 * strings, and a fixed error code. No GitHub token, account login, or raw `gh`/npm
 * output is ever serialized here — starring runs through the user's own `gh` CLI and
 * this surface only learns the yes/no answer. `gh` writes the authenticated account
 * name to stderr, so that output is discarded at the source rather than forwarded.
 */
import { jsonResponse } from "../auth-cors";
import type { ManagementContext } from "./context";

export async function handleSidebarRoutes(ctx: ManagementContext): Promise<Response | null> {
  const { req, url } = ctx;

  if (url.pathname === "/api/github/star" && req.method === "GET") {
    const { getStarStatus } = await import("../../github/star-state");
    return jsonResponse(await getStarStatus());
  }

  if (url.pathname === "/api/github/star" && req.method === "POST") {
    const { starRepository } = await import("../../github/star-state");
    const result = await starRepository();
    return jsonResponse({
      ...result.status,
      ok: result.ok,
      ...(result.code ? { code: result.code } : {}),
    });
  }

  if (url.pathname === "/api/update/badge" && req.method === "GET") {
    const { readUpdateBadge } = await import("../../update/badge");
    return jsonResponse(readUpdateBadge());
  }

  return null;
}
