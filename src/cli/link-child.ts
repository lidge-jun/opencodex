/**
 * Management commands on a Remote Link Child (#6957).
 *
 * A link Child's listener serves no management API, and the Home owns every setting that decides
 * routing. Each management command therefore does one of two things: an allowlisted read goes
 * to the Home through the connection-bound link relay, and anything else is refused with the one
 * message `linkChildManagementRefusal` builds, which names the Home and the link.
 */
import { readBoundedResponseBytes } from "../lib/bounded-body";
import { readServiceApiTokenState } from "../lib/service-secrets";
import { linkChildManagementRefusal, linkManagementReadAllowed } from "../link/management-routes";
import { readClientConnectionState } from "../client/state";
import { fetchLinkHomeManagement, linkHomePhrase, type LinkHomeDeps } from "../client/link-home";
import type { OcxClientConnectionConfig } from "../types";

const RESPONSE_MAX_BYTES = 32 * 1024 * 1024;

export interface LinkChildContext {
  connection: OcxClientConnectionConfig;
  linkId: string;
  homePhrase: string;
}

/** The link Child this CLI runs on, or null on a standalone, a hub or a hub client. */
export function readLinkChildContext(read: typeof readClientConnectionState = readClientConnectionState): LinkChildContext | null {
  let state: ReturnType<typeof readClientConnectionState>;
  try { state = read(); } catch { return null; }
  if (state.kind !== "connected" || state.value.transport !== "link" || !state.value.link) return null;
  return { connection: state.value, linkId: state.value.link.linkId, homePhrase: linkHomePhrase(state.value) };
}

export function linkChildRefusal(context: LinkChildContext, operation?: string): string {
  return linkChildManagementRefusal(context.homePhrase, context.linkId, operation);
}

/**
 * The stderr label for a local read on a link Child (`ocx provider list`, `ocx config get`):
 * the values are real, but they are this machine's and the Home's apply.
 */
export function linkChildLocalNotice(what: string): string | null {
  const link = readLinkChildContext();
  if (!link) return null;
  return `Note: this machine is a Remote Link Child managed by ${link.homePhrase} (link ${link.linkId}). `
    + `${what} below are this machine's local configuration. Its provider, model and routing settings are inactive while it is linked; the Home's apply. Run 'ocx status' for the Home's state.`;
}

export async function printLinkChildLocalNotice(what: string): Promise<void> {
  const notice = linkChildLocalNotice(what);
  if (notice) console.error(notice);
}

/** `ocx config set|unset|import` on a link Child: the write is local and its routing parts inactive. */
export async function printLinkChildLocalWriteNotice(): Promise<void> {
  const link = readLinkChildContext();
  if (!link) return;
  console.error(`Note: this machine is a Remote Link Child managed by ${link.homePhrase} (link ${link.linkId}). `
    + "This writes this machine's local configuration; its provider, model and routing settings stay inactive while it is linked, and the Home's apply.");
}

/** The refusal for a local provider change on a link Child, or null elsewhere. */
export function linkChildProviderChangeRefusal(operation: string): string | null {
  const link = readLinkChildContext();
  return link ? linkChildRefusal(link, operation) : null;
}

/** Can this management request be answered by reading the Home? */
export function linkChildReadable(method: string, path: string): boolean {
  const url = new URL(path.startsWith("/") ? path : `/${path}`, "http://cli.invalid");
  return linkManagementReadAllowed(method, url.pathname, url.searchParams);
}

/** One allowlisted read from the Home. Throws with an operator sentence when it cannot be sent. */
export async function readLinkHomeJson(
  context: LinkChildContext,
  path: string,
  deps: LinkHomeDeps = {},
): Promise<{ status: number; body: unknown }> {
  const token = readServiceApiTokenState();
  if (token.kind !== "present" || token.fingerprint !== context.connection.tokenFingerprint) {
    throw new Error(`The enrolled link key for ${context.homePhrase} is missing or changed; re-link this machine from the Home.`);
  }
  let response: Response;
  try {
    response = await fetchLinkHomeManagement(context.connection, token.token, path.startsWith("/") ? path : `/${path}`, {}, deps);
  } catch (error) {
    const detail = error instanceof Error && error.name === "LinkRelayAuthenticationError" ? error.message : "the link tunnel did not answer";
    throw new Error(`Could not read ${context.homePhrase} over Remote Link (${context.linkId}): ${detail}.`);
  }
  const result = await readBoundedResponseBytes(response, { maxBytes: RESPONSE_MAX_BYTES, signal: AbortSignal.timeout(30_000) });
  if (result.oversized) throw new Error(`${context.homePhrase} returned a response larger than the CLI accepts.`);
  const text = new TextDecoder().decode(result.bytes);
  let body: unknown = null;
  if (text) {
    try { body = JSON.parse(text); } catch { body = text; }
  }
  // A Home that predates the relay answers its listener's generic unknown-endpoint 404.
  const error = body && typeof body === "object" ? (body as Record<string, unknown>).error : undefined;
  const unknownEndpoint = error === "not_found"
    || (!!error && typeof error === "object" && (error as Record<string, unknown>).code === "not_found");
  if (response.status === 404 && unknownEndpoint) {
    return { status: 503, body: { error: `${context.homePhrase} does not serve Remote Link management reads; upgrade the Home.` } };
  }
  return { status: response.status, body };
}
