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
 *
 * The star POST additionally requires a dashboard session. Management auth proves
 * the caller reached the admin token, not that a person chose to star: a coding
 * agent runs on the user's machine and can read that token from disk, so the CLI's
 * "ask the user" deferral would be bypassable with one `curl` here.
 *
 * The requirement is unconditional, and that is the point. It used to apply only
 * when `isAgentDriven()` was true — but that function reads the SERVER's
 * environment, not the caller's, so a proxy already running as a service (no agent
 * markers, the normal remote setup) accepted a raw-token star from anyone who could
 * read the token, which includes every agent on the machine. The provenance of the
 * HTTP caller is not knowable from the server's env; only the credential is. So the
 * mutation asks for a GUI session this process minted for a browser, which the auth
 * gate accepts only after matching origin and the per-session CSRF token.
 */
import { jsonResponse } from "../auth-cors";
import { verifyLocalDesktopSnapshotBody } from "../local-desktop-snapshot-auth";
import { agentDrivenMarkers } from "../../cli/agent-driven";
import type { ManagementContext } from "./context";

/**
 * True only when a minted GUI session authorized this request.
 *
 * The previous version of this check looked for an `Origin` plus the CSRF headers
 * and reasoned that the auth gate had already validated them. It had not: the gate
 * accepts a raw admin token BEFORE it ever consults the session table, so a caller
 * holding that token (any process running as the user, a coding agent included)
 * could add three nonempty headers of its choosing and satisfy this check without
 * a browser ever being involved. The credential itself is the only part of the
 * request an agent cannot fabricate, so that is what this now reads.
 */
function hasBrowserSessionEvidence(ctx: ManagementContext): boolean {
  return ctx.principal === "gui-session";
}

// Known edge, deliberately fail-closed: a non-loopback operator dashboard that signs
// in with the raw admin token instead of a minted GUI session gets its click refused,
// and the response names the one-line `gh` command to run by hand. That is the
// correct trade — an endpoint reachable with a readable token cannot establish that
// a human chose to spend their own GitHub identity.
//
// The honest limit of this guard: a local process running AS THE USER can mint its
// own GUI session (the dashboard bootstrap is served to any loopback GET) and can
// equally just run `gh api -X PUT /user/starred/...` itself, which needs no proxy at
// all. No check inside this process can distinguish that caller from the browser,
// because both hold every local credential. So this endpoint is not a technical
// barrier against a determined local agent — it removes the CASUAL path (an agent
// that would have POSTed here because the endpoint existed) and makes the refusal
// legible. The actual boundary is normative and lives in AGENTS.md: an agent must
// not spend the user's identity, whichever mechanism is at hand.

export async function handleSidebarRoutes(ctx: ManagementContext): Promise<Response | null> {
  const { req, url } = ctx;

  if (url.pathname === "/api/github/star" && req.method === "GET") {
    const { getStarStatus } = await import("../../github/star-state");
    return jsonResponse(await getStarStatus());
  }

  if (url.pathname === "/api/github/star" && req.method === "POST") {
    const { STAR_REPO, STAR_REPO_URL, starRepository } = await import("../../github/star-state");
    // Starring uses the user's GitHub identity, so consent must come from the
    // account owner. Only a minted dashboard session evidences that; a caller
    // holding the admin token must relay the question instead of answering it
    // with an HTTP call.
    if (!hasBrowserSessionEvidence(ctx)) {
      const markers = agentDrivenMarkers().slice(0, 3);
      return jsonResponse({
        ok: false,
        state: "not-starred",
        repo: STAR_REPO,
        url: STAR_REPO_URL,
        code: "agent_consent_required",
        message:
          `Refused: this request carries no dashboard session`
          + `${markers.length ? ` (agent session detected: ${markers.join(", ")})` : ""}. `
          + `Starring writes to the user's own GitHub account, so ask the user `
          + `directly as a required Yes/No choice — not a soft aside, and no answer is not a No, so re-ask `
          + `it unchanged while it is open — and only if they say yes run: `
          + `gh api -X PUT /user/starred/${STAR_REPO}`,
      }, 403);
    }
    const result = await starRepository();
    return jsonResponse({
      ...result.status,
      ok: result.ok,
      ...(result.code ? { code: result.code } : {}),
    });
  }

  if (url.pathname === "/api/update/desktop-snapshot" && req.method === "POST") {
    // Only the native ProxyClient publishes this state; browsers always send Origin.
    if (req.headers.has("origin")) {
      return Response.json({ error: "desktop snapshot does not accept browser-origin requests" }, { status: 403 });
    }
    if (ctx.principal !== "admin-token" && ctx.principal !== "local-desktop-snapshot-capability") {
      return jsonResponse({ error: "desktop snapshot requires admin token or snapshot capability" }, 403, req, ctx.config);
    }
    if (req.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json") {
      return jsonResponse({ error: "invalid desktop snapshot" }, 400, req, ctx.config);
    }
    const declared = Number(req.headers.get("content-length") ?? "0");
    if (Number.isFinite(declared) && declared > 1024) {
      return jsonResponse({ error: "desktop snapshot too large" }, 413, req, ctx.config);
    }
    const reader = req.body?.getReader();
    if (!reader) return jsonResponse({ error: "invalid desktop snapshot" }, 400, req, ctx.config);
    const bytes = new Uint8Array(1024);
    let used = 0;
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        if (used + part.value.length > bytes.length) {
          await reader.cancel();
          return jsonResponse({ error: "desktop snapshot too large" }, 413, req, ctx.config);
        }
        bytes.set(part.value, used);
        used += part.value.length;
      }
      const body = bytes.subarray(0, used);
      if (ctx.principal === "local-desktop-snapshot-capability" && !verifyLocalDesktopSnapshotBody(req, body)) {
        return jsonResponse({ error: "invalid desktop snapshot capability body" }, 403, req, ctx.config);
      }
      const decoded = new TextDecoder("utf-8", { fatal: true }).decode(body);
      const { desktopBadgeStore } = await import("../../update/desktop-badge");
      if (!desktopBadgeStore.put(JSON.parse(decoded))) {
        return jsonResponse({ error: "invalid desktop snapshot" }, 400, req, ctx.config);
      }
    } catch {
      return jsonResponse({ error: "invalid desktop snapshot" }, 400, req, ctx.config);
    }
    return jsonResponse({ ok: true }, 200, req, ctx.config);
  }

  if (url.pathname === "/api/update/badge" && req.method === "GET"
    && url.searchParams.get("surface") === "desktop") {
    const { desktopBadgeStore } = await import("../../update/desktop-badge");
    return jsonResponse(desktopBadgeStore.read(url.searchParams.get("session")), 200, req, ctx.config);
  }

  if (url.pathname === "/api/update/badge" && req.method === "GET"
    && url.searchParams.has("surface") && url.searchParams.get("surface") !== "desktop") {
    return jsonResponse({ error: "invalid badge surface" }, 400, req, ctx.config);
  }

  if (url.pathname === "/api/update/badge" && req.method === "GET") {
    const { readUpdateBadge } = await import("../../update/badge");
    return jsonResponse(readUpdateBadge());
  }

  return null;
}
