/**
 * GET and POST /api/link/{id}/routes: list, add, remove and reorder a Home-initiated link's routes
 * (structure/remote-link.md, "Routes"). The pin never changes here: alias, hostKeyFingerprint and the
 * link known_hosts file are only read. A new route is stored only after it proved the pinned key
 * over itself, against a private snapshot of the one pinned line. Responses carry fixed codes and a
 * class word, never ssh output.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withConfigMutationLockSync } from "../../config/mutation-lock";
import { checkRouteTrust } from "../../link/route-trust";
import { routeOutcomeOfStderr } from "../../link/route-select";
import { buildRouteProbeArgv, isSshAlias } from "../../link/ssh-argv";
import { effectiveLinkRoutes, MAX_LINK_ROUTES, type LinkRecord } from "../../link/store";
import type { ManagementContext } from "./context";
import { readManagementJsonBodyOr } from "./body";
import { serialized } from "./link-enrollment";
import { exactBody, fail, knownHostsFile, readStoreFor, runnerFor, writeStoreFor, type LinkRouteState } from "./link-route-state";

const LINK_ID = /^lnk_[0-9a-f]{16}$/;
export const ROUTE_PROBE_TIMEOUT_MS = 15_000;

type Edit =
  | { op: "add"; route: string; position?: number }
  | { op: "remove"; route: string }
  | { op: "order"; routes: string[] };

/** The fields a route edit proves against: a change to any of them means another link now. */
const IDENTITY = ["id", "alias", "direction", "hostKeyFingerprint", "tunnelPort", "apiKeyId", "createdAt"] as const;

function sameIdentity(left: LinkRecord, right: LinkRecord): boolean {
  return IDENTITY.every(key => left[key] === right[key]);
}

function sameList(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function routesBody(record: LinkRecord): { linkId: string; pin: string; routes: string[]; exclusive?: true } {
  return { linkId: record.id, pin: record.alias, routes: effectiveLinkRoutes(record), ...(record.exclusive ? { exclusive: true as const } : {}) };
}

/** An exclusive link has one route, its alias, fixed at enrollment (structure/remote-link.md, "Explicit route"). */
function exclusiveRefusal(): Response {
  return fail("link_exclusive", "This link is exclusive: its one route is fixed, so routes cannot be added, removed or reordered.", 409);
}

function document(record: LinkRecord): Response {
  return Response.json(routesBody(record), { headers: { "cache-control": "no-store" } });
}

function parseEdit(value: unknown): Edit | null {
  const add = exactBody(value, ["op", "route"]) ?? exactBody(value, ["op", "route", "position"]);
  if (add && (add.op === "add" || add.op === "remove") && typeof add.route === "string" && isSshAlias(add.route)) {
    if (add.op === "remove") return "position" in add ? null : { op: "remove", route: add.route };
    if (add.position !== undefined && (typeof add.position !== "number" || !Number.isInteger(add.position) || add.position < 0)) return null;
    return { op: "add", route: add.route, ...(add.position === undefined ? {} : { position: add.position as number }) };
  }
  const order = exactBody(value, ["op", "routes"]);
  if (order && order.op === "order" && Array.isArray(order.routes) && order.routes.length >= 1 && order.routes.length <= MAX_LINK_ROUTES
    && order.routes.every(route => typeof route === "string" && isSshAlias(route))) {
    return { op: "order", routes: [...order.routes as string[]] };
  }
  return null;
}

export async function handleLinkRouteEdit(ctx: ManagementContext, state: LinkRouteState, id: string): Promise<Response> {
  if (!LINK_ID.test(id)) return fail("invalid_link_id", "The link id is invalid.", 400);
  const record = readStoreFor(ctx).links.find(link => link.id === id);
  if (!record) return fail("link_not_found", "The link was not found.", 404);
  if (record.direction !== "hub-initiated") return fail("link_not_home_initiated", "Only a Home-initiated link has routes.", 409);
  if (ctx.req.method === "GET") return document(record);
  if (record.exclusive) return exclusiveRefusal();
  const edit = parseEdit(await readManagementJsonBodyOr(ctx.req, null));
  if (!edit) return fail("invalid_body", "The body must be {op:\"add\",route,position?}, {op:\"remove\",route} or {op:\"order\",routes}.", 400);
  const current = effectiveLinkRoutes(record);
  let next: string[];
  if (edit.op === "add") {
    if (current.includes(edit.route)) return fail("route_exists", "The link already has this route.", 409);
    if (current.length >= MAX_LINK_ROUTES) return fail("route_limit", "A link has at most " + MAX_LINK_ROUTES + " routes.", 409);
    const position = edit.position ?? current.indexOf(record.alias);
    if (position > current.length) return fail("invalid_body", "The position is out of range.", 400);
    next = [...current.slice(0, position), edit.route, ...current.slice(position)];
  } else if (edit.op === "remove") {
    if (edit.route === record.alias) return fail("route_is_pin", "The link's own alias is its pinned name and stays in the list.", 409);
    if (!current.includes(edit.route)) return fail("route_not_found", "The link has no such route.", 404);
    next = current.filter(route => route !== edit.route);
  } else {
    if (edit.routes.length !== current.length || new Set(edit.routes).size !== edit.routes.length
      || !edit.routes.every(route => current.includes(route))) {
      return fail("route_order_mismatch", "The new order must list exactly the link's current routes.", 409);
    }
    next = edit.routes;
  }
  // Same exclusion as removal and Child jobs: the per-alias set, then the link's job reservation,
  // held across the snapshot, the probe, the commit and the reload; the mutation lock only at commit.
  return serialized(state, record.alias, async () => {
    const { childOpsEngineFor } = await import("./link-child-ops-routes");
    const release = childOpsEngineFor(state).reserve(id);
    if (!release) return fail("link_operation_in_progress", "Another operation holds this link; try again when it ends.", 409);
    try {
      return await applyEdit(ctx, state, record, current, next, edit.op === "add" ? edit.route : null);
    } finally {
      release();
    }
  });
}

async function applyEdit(ctx: ManagementContext, state: LinkRouteState, record: LinkRecord, current: string[], next: string[], added: string | null): Promise<Response> {
  const hostsPath = knownHostsFile(ctx);
  let pinned: string | null = null;
  if (added !== null) {
    const trust = checkRouteTrust(readTrustFile(hostsPath), record.alias, record.hostKeyFingerprint);
    if (!trust.ok) {
      return trust.code === "pin_mismatch"
        ? fail("pin_mismatch", "The link's known_hosts entry is not exactly its pinned key.", 409)
        : fail("trust_file_unexpected", "The link known_hosts file has a line this check cannot rule out.", 409);
    }
    pinned = trust.line;
    const refused = await proveRoute(ctx, record, added, pinned);
    if (refused) return refused;
  }
  const outcome = withConfigMutationLockSync((): "link_changed" | "pin_changed" | "link_exclusive" | LinkRecord => {
    const fresh = readStoreFor(ctx);
    const target = fresh.links.find(link => link.id === record.id);
    if (target?.exclusive) return "link_exclusive";
    if (!target || !sameIdentity(target, record) || !sameList(effectiveLinkRoutes(target), current)) return "link_changed";
    if (pinned !== null) {
      const trust = checkRouteTrust(readTrustFile(hostsPath), record.alias, record.hostKeyFingerprint);
      if (!trust.ok || trust.line !== pinned) return "pin_changed";
    }
    if (next.length === 1 && next[0] === target.alias) delete target.routes;
    else target.routes = [...next];
    writeStoreFor(ctx, fresh);
    return target;
  });
  if (outcome === "link_exclusive") return exclusiveRefusal();
  if (outcome === "link_changed") return fail("link_changed", "The link changed while its routes were being edited; read it again.", 409);
  if (outcome === "pin_changed") return fail("pin_changed", "The link's pinned key changed while the route was being proved.", 409);
  try { await state.supervisor.reload(); } catch {
    // The store holds the edit, the running tunnels may not: say so instead of reporting success.
    console.warn("[link] route edit stored; tunnel reload failed linkId=" + record.id);
    const message = "The routes were stored, but the running proxy did not apply them. Restart the proxy to apply them.";
    return Response.json({ error: { code: "routes_stored_reload_failed", message, ...routesBody(outcome) } }, { status: 500, headers: { "cache-control": "no-store" } });
  }
  return document(outcome);
}

function readTrustFile(path: string): string {
  try { return readFileSync(path, "utf8"); } catch { return ""; }
}

/** Probe the route against a private copy of the one pinned line; null when it proved the key. */
async function proveRoute(ctx: ManagementContext, record: LinkRecord, route: string, pinned: string): Promise<Response | null> {
  const dir = mkdtempSync(join(tmpdir(), "ocx-link-route-"));
  try {
    const snapshot = join(dir, "known_hosts");
    writeFileSync(snapshot, pinned + "\n", { mode: 0o600 });
    let cause: string;
    try {
      const result = await runnerFor(ctx).run(buildRouteProbeArgv({ alias: record.alias, destination: route, knownHostsFile: snapshot, route: record.explicitRoute ?? null }), { timeoutMs: ROUTE_PROBE_TIMEOUT_MS });
      if (result.code === 0 && result.stdout.trim() === "ocx-link-probe") return null;
      cause = result.code === 0 ? "transient" : routeOutcomeOfStderr(result.stderr);
    } catch {
      cause = "transient";
    }
    return Response.json({ error: { code: "route_unproven", message: "The route did not prove the link's pinned host key.", cause } }, { status: 409, headers: { "cache-control": "no-store" } });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

