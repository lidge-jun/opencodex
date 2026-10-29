/**
 * The last tunnel connection a Home-initiated link's Home proved to this Child (relay-auth.ts).
 * Every authenticated relay answer replaces it: a bound generation records it, and an answer
 * without one (an older Home, a missing or mismatched proof) makes it unknown. Process memory
 * only, so a restart forgets it.
 */
const verified = new Map<string, string>();

export function recordVerifiedHomeConnection(linkId: string, generation: string): void {
  verified.set(linkId, generation);
}

export function forgetVerifiedHomeConnection(linkId: string): void {
  verified.delete(linkId);
}

export function verifiedHomeConnection(linkId: string): string | undefined {
  return verified.get(linkId);
}
