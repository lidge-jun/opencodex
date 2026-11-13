/**
 * An explicit SSH route for a Home-initiated link (structure/remote-link.md, "Explicit route"): the
 * ProxyCommand, user and port ssh uses for the link's alias. ssh-argv passes them on the command line,
 * where ssh takes them before anything in ssh_config, so a later ssh_config edit cannot move the link.
 *
 * These values reach ssh's argv, and ssh runs ProxyCommand as "exec <command>" through the user's
 * shell, so only a closed form is accepted (refused, never repaired):
 * - proxyCommand: 1-1024 ASCII characters; 1-32 words separated by exactly one space. The first word is
 *   an absolute POSIX path ("/" then letters, digits and . _ + - /), so neither PATH nor an "exec -flag"
 *   can change what runs. Every later word uses only letters, digits and . _ / : @ + , = - and does not
 *   start with "=" (zsh expands a leading "="). Nothing else: no quote, backslash, $ or backquote, no
 *   ; & | < > ( ) { } [ ] * ? ! # ~, no % (ssh expands %h, %p, %r and %n from values ssh_config controls),
 *   no tab, newline, NUL or non-ASCII character.
 * - user: a letter or "_" then up to 31 letters, digits, ".", "_" or "-".
 * - port: an integer from 1 to 65535.
 * The path form is POSIX only, so a Windows Home cannot use an explicit route yet.
 */

export interface ExplicitRoute {
  proxyCommand: string;
  user: string;
  port: number;
}

export type ExplicitRouteRefusal = "shape" | "proxy_command_form" | "user_form" | "port_form";

const KEYS = ["port", "proxyCommand", "user"];
const PROGRAM = /^\/[A-Za-z0-9._+\/-]*$/;
const WORD = /^[A-Za-z0-9._\/:@+,-][A-Za-z0-9._\/:@+,=-]*$/;
const USER = /^[A-Za-z_][A-Za-z0-9_.-]{0,31}$/;
export const EXPLICIT_ROUTE_MAX_COMMAND = 1024;
export const EXPLICIT_ROUTE_MAX_WORDS = 32;

function isProxyCommand(value: string): boolean {
  if (value.length < 1 || value.length > EXPLICIT_ROUTE_MAX_COMMAND) return false;
  const words = value.split(" ");
  if (words.length > EXPLICIT_ROUTE_MAX_WORDS || !PROGRAM.test(words[0]!)) return false;
  return words.slice(1).every(word => WORD.test(word));
}

export function checkExplicitRoute(value: unknown): { ok: true; route: ExplicitRoute } | { ok: false; reason: ExplicitRouteRefusal } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ok: false, reason: "shape" };
  const raw = value as Record<string, unknown>;
  if (Object.keys(raw).sort().join(",") !== KEYS.join(",") || typeof raw.proxyCommand !== "string" || typeof raw.user !== "string") {
    return { ok: false, reason: "shape" };
  }
  if (!isProxyCommand(raw.proxyCommand)) return { ok: false, reason: "proxy_command_form" };
  if (!USER.test(raw.user)) return { ok: false, reason: "user_form" };
  if (typeof raw.port !== "number" || !Number.isInteger(raw.port) || raw.port < 1 || raw.port > 65535) return { ok: false, reason: "port_form" };
  return { ok: true, route: { proxyCommand: raw.proxyCommand, user: raw.user, port: raw.port } };
}

/** The route when the value is an accepted form, otherwise null. */
export function parseExplicitRoute(value: unknown): ExplicitRoute | null {
  const checked = checkExplicitRoute(value);
  return checked.ok ? checked.route : null;
}

/** Both absent, or the same three values. */
export function sameExplicitRoute(left: ExplicitRoute | null | undefined, right: ExplicitRoute | null | undefined): boolean {
  if (!left || !right) return !left && !right;
  return left.proxyCommand === right.proxyCommand && left.user === right.user && left.port === right.port;
}

/**
 * The ssh options of a route. ProxyUseFdpass=no keeps an ssh_config "ProxyUseFdpass yes" from changing
 * how the proxy command's output is used. Throws for a value that is not an accepted form.
 */
export function explicitRouteSshOptions(route: ExplicitRoute): string[] {
  const checked = checkExplicitRoute(route);
  if (!checked.ok) throw new ExplicitRouteError(checked.reason);
  return [
    "-o", "ProxyCommand=" + checked.route.proxyCommand,
    "-o", "ProxyUseFdpass=no",
    "-o", "User=" + checked.route.user,
    "-o", "Port=" + String(checked.route.port),
  ];
}

export class ExplicitRouteError extends Error {
  constructor(readonly reason: ExplicitRouteRefusal) {
    super("invalid explicit route: " + reason);
    this.name = "ExplicitRouteError";
  }
}
