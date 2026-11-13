/**
 * ocx link routes: list, add, remove and reorder a Home-initiated link's SSH routes through the
 * Home's management API (GET and POST /api/link/{id}/routes; structure/remote-link.md, "Routes").
 * The Home proves a new route against the link's pinned key before storing it.
 */
import { isSshAlias } from "../link/ssh-argv";
import { CliUsageError, printData, rejectArgs, RuntimeApiError, takeIntegerOption, takeJsonFlag, takeOption } from "./runtime-api";
import type { LinkCliDeps } from "./link";

type LinkRequest = <T>(path: string, init: RequestInit, deps: LinkCliDeps) => Promise<T>;

export const LINK_ROUTES_USAGE = [
  "  ocx link routes --link-id <id> [--json]",
  "  ocx link routes add --link-id <id> --route <alias> [--position <n>] [--json]",
  "  ocx link routes remove --link-id <id> --route <alias> [--json]",
  "  ocx link routes order --link-id <id> --routes <alias,alias,...> [--json]",
];

const LINK_ID = /^lnk_[0-9a-f]{16}$/;
// The class words an unproven route can carry (RouteOutcomeClass); anything else is not echoed.
const ROUTE_CAUSES = new Set(["transient", "readiness", "grant_unobserved", "forward", "auth", "hostkey"]);

export interface LinkRoutesDocument { linkId: string; pin: string; routes: string[]; exclusive?: true }

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function validateRoutesDocument(value: unknown, linkId: string): LinkRoutesDocument {
  const fail = (): never => { throw new Error("invalid link API response: routes"); };
  if (!isRecord(value)) return fail();
  const keys = Object.keys(value).sort().join(",");
  if (keys !== "linkId,pin,routes" && keys !== "exclusive,linkId,pin,routes") fail();
  const { pin, routes } = value;
  // An exclusive link (structure/remote-link.md, "Explicit route") lists exactly its pin.
  if ("exclusive" in value && (value.exclusive !== true || !Array.isArray(routes) || routes.length !== 1)) fail();
  if (value.linkId !== linkId || typeof pin !== "string" || !isSshAlias(pin) || !Array.isArray(routes) || routes.length < 1
    || !routes.every(route => typeof route === "string" && isSshAlias(route)) || new Set(routes).size !== routes.length
    || !routes.includes(pin)) fail();
  return { linkId, pin: pin as string, routes: [...routes as string[]], ...(value.exclusive === true ? { exclusive: true as const } : {}) };
}

function route(value: string | undefined, flag: string, usage: string): string {
  if (!value || !isSshAlias(value)) throw new CliUsageError(flag + " must be an SSH host alias", usage);
  return value;
}

export async function runLinkRoutes(args: string[], deps: LinkCliDeps, request: LinkRequest, usage: string): Promise<void> {
  const verb = args[0] === "add" || args[0] === "remove" || args[0] === "order" ? args.shift() : undefined;
  const json = takeJsonFlag(args);
  const linkId = takeOption(args, "--link-id");
  if (!linkId || !LINK_ID.test(linkId)) throw new CliUsageError("routes requires a valid --link-id", usage);
  let body: Record<string, unknown> | undefined;
  if (verb === "add") {
    const position = takeIntegerOption(args, "--position", { min: 0, max: 7 });
    body = { op: "add", route: route(takeOption(args, "--route"), "--route", usage), ...(position === undefined ? {} : { position }) };
  } else if (verb === "remove") {
    body = { op: "remove", route: route(takeOption(args, "--route"), "--route", usage) };
  } else if (verb === "order") {
    const list = takeOption(args, "--routes");
    const routes = list === undefined ? [] : list.split(",");
    if (routes.length < 1) throw new CliUsageError("order requires --routes alias,alias,...", usage);
    body = { op: "order", routes: routes.map(value => route(value, "--routes", usage)) };
  }
  rejectArgs(args, usage);
  const path = "/api/link/" + encodeURIComponent(linkId) + "/routes";
  let response: unknown;
  try {
    response = body === undefined
      ? await request<unknown>(path, {}, deps)
      : await request<unknown>(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }, deps);
  } catch (error) {
    // Name the fixed code and, for an unproven route, its class word; only known words are shown.
    // The status keeps the exit code (4 on 404, 5 on 409, 1 otherwise).
    if (error instanceof RuntimeApiError && isRecord(error.body) && isRecord(error.body.error) && typeof error.body.error.code === "string") {
      const code = error.body.error.code;
      const cause = error.body.error.cause;
      const known = typeof cause === "string" && ROUTE_CAUSES.has(cause) ? " (" + cause + ")" : "";
      const note = code === "routes_stored_reload_failed" ? "; the routes were stored (ocx link routes --link-id " + linkId + " reads them), restart the proxy to apply them" : "";
      throw new RuntimeApiError("Link routes request refused (" + error.status + "): " + code + known + note, error.status, error.body);
    }
    throw error;
  }
  const document = validateRoutesDocument(response, linkId);
  printData(document, json, document.routes.map((name, index) => index + "  " + name + (name === document.pin ? (document.exclusive ? "  (pin, exclusive)" : "  (pin)") : "")));
}

