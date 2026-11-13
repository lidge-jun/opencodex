import { LINK_RELAY_WS_STATE_HEADER, LINK_RELAY_WS_STATE_PROOF_HEADER, linkRelayProofMatches, linkWebsocketStateProof } from "../link/relay-auth";

/**
 * Whether each Home advertises the Responses WebSocket over its link, as this Child last learned it
 * from ordinary relay traffic (design T4 3.2, "advertisedSeen").
 *
 * Every relay-auth preflight takes a number from one process counter when it starts. A verified answer
 * is applied only when its preflight's number is higher than the number of the last answer applied for
 * that link, so a reply to a request sent before the last applied one is ignored, whoever produced it
 * and however late it arrives: an earlier Home's delayed reply, a reply from before a relink, a restart
 * or a downgrade. A verified answer without the state pair, or whose pair does not verify, applies as
 * off. The state lives in memory only, so a Child restart starts from off; a relink changes the link id,
 * which starts a new entry. At most 256 links are kept. Evicting a link keeps its ordering: its last
 * applied number stays as a watermark (at most 1,024 of them), and an answer for that link applies only
 * above it, so an answer still in flight when its link was evicted can never land as the newest. Only
 * when a watermark itself is dropped does it raise a floor that answers for links without an entry or
 * a watermark must pass: conservative, and reached only after more than 1,280 distinct links.
 *
 * The cached state only decides whether an upgrade may try the Home at all. The upgrade's own preflight
 * answer decides whether it proceeds (linkWebsocketAnswer on that answer).
 */
const MAX_LINKS = 256;
const MAX_WATERMARKS = 1_024;
let sequence = 0;
const links = new Map<string, { applied: number; on: boolean }>();
/** Evicted links: the number of the last answer each had applied. */
const watermarks = new Map<string, number>();
/** The highest watermark ever dropped. */
let floor = 0;

export type LinkWebsocketAnswer = "on" | "off";

/** The number a preflight takes when it starts. */
export function nextLinkPreflightSequence(): number {
  sequence += 1;
  return sequence;
}

type HeaderSource = Record<string, string | string[] | undefined>;

function single(headers: HeaderSource, name: string): string | null {
  const value = headers[name];
  return typeof value === "string" ? value : null;
}

/**
 * The state one verified relay-auth answer names, bound to its nonce and both identities by its own
 * proof. Anything but a verified "on" is off.
 */
export function linkWebsocketAnswer(
  headers: HeaderSource, identity: { fingerprint: string; keyId: string; linkId: string; nonce: string },
): LinkWebsocketAnswer {
  if (single(headers, LINK_RELAY_WS_STATE_HEADER) !== "on") return "off";
  const expected = linkWebsocketStateProof(identity.fingerprint, identity.keyId, identity.linkId, identity.nonce, "on");
  return linkRelayProofMatches(single(headers, LINK_RELAY_WS_STATE_PROOF_HEADER), expected) ? "on" : "off";
}

/** Apply a verified answer under the ordering rule. Returns whether it was applied. */
export function applyLinkWebsocketAnswer(linkId: string, preflight: number, answer: LinkWebsocketAnswer): boolean {
  const entry = links.get(linkId);
  if (preflight <= (entry ? entry.applied : watermarks.get(linkId) ?? floor)) return false;
  links.delete(linkId);
  watermarks.delete(linkId);
  links.set(linkId, { applied: preflight, on: answer === "on" });
  if (links.size > MAX_LINKS) {
    const [oldest, evicted] = links.entries().next().value!;
    links.delete(oldest);
    watermarks.set(oldest, evicted.applied);
    if (watermarks.size > MAX_WATERMARKS) {
      const [dropped, mark] = watermarks.entries().next().value!;
      watermarks.delete(dropped);
      floor = Math.max(floor, mark);
    }
  }
  return true;
}

/** advertisedSeen: "on" in the last answer applied for this link. */
export function linkWebsocketAdvertised(linkId: string | undefined): boolean {
  return linkId !== undefined && links.get(linkId)?.on === true;
}

export function forgetLinkWebsocketAdvertisementsForTests(): void {
  links.clear();
  watermarks.clear();
  floor = 0;
}
