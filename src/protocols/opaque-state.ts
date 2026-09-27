/**
 * Opaque reasoning state and credential domains for native Messages sends (PF-10).
 *
 * A thinking block's `signature` and a `redacted_thinking` block's `data` are opaque to this
 * proxy: they were minted by some Anthropic deployment for some credential, and only that side
 * can verify or decrypt them. The native Messages lane therefore forwards them only to Anthropic
 * itself (`api.anthropic.com` over HTTPS). For any other destination they are removed from the
 * body that is sent — the signature field is dropped and the thinking text kept, a
 * `redacted_thinking` block is dropped whole — and the caller's source body is left untouched,
 * so the next build for the next destination starts from the full state again.
 *
 * A credential domain is the pair a destination is trusted as: the provider's base host and the
 * class of credential it is reached with. Two sends share a domain only when both match; a key
 * rotation within one provider keeps it, a move to another host or another credential class does
 * not. Every build decides from its own domain, never from an earlier build's output.
 *
 * LEAF MODULE: type-only imports, no side effects, never logs or returns what it removed.
 */
import type { AnthropicProviderClass } from "../adapters/anthropic/beta-allowlist";
import type { OcxProviderConfig } from "../types";

type Rec = Record<string, unknown>;
function isRec(value: unknown): value is Rec {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Anthropic's own API host. Nothing else is first-party, including look-alike subdomains. */
export const FIRST_PARTY_ANTHROPIC_HOST = "api.anthropic.com";

export type CredentialAuthClass = "key" | "oauth" | "forward" | "local" | "unknown";

export interface CredentialDomain {
  /** Lower-cased `host` (with a non-default port) of the provider's base URL. */
  readonly host: string;
  readonly authClass: CredentialAuthClass;
  /** HTTPS to `api.anthropic.com` on the default port, with no userinfo. */
  readonly firstPartyAnthropic: boolean;
}

function authClassOf(authMode: OcxProviderConfig["authMode"]): CredentialAuthClass {
  switch (authMode) {
    case undefined:
    case "key":
      return "key";
    case "oauth":
    case "forward":
    case "local":
      return authMode;
    default:
      return "unknown";
  }
}

/** The credential domain a provider is reached in, or `undefined` for a malformed base URL. */
export function credentialDomainFor(
  provider: Pick<OcxProviderConfig, "baseUrl" | "authMode">,
): CredentialDomain | undefined {
  let url: URL;
  try {
    url = new URL(provider.baseUrl);
  } catch {
    return undefined;
  }
  const firstPartyAnthropic = url.protocol === "https:"
    && url.hostname.toLowerCase() === FIRST_PARTY_ANTHROPIC_HOST
    && url.port === ""
    && url.username === ""
    && url.password === "";
  return { host: url.host.toLowerCase(), authClass: authClassOf(provider.authMode), firstPartyAnthropic };
}

/** Whether two sends share one credential domain. An unknown domain shares none. */
export function sameCredentialDomain(a: CredentialDomain | undefined, b: CredentialDomain | undefined): boolean {
  return a !== undefined && b !== undefined && a.host === b.host && a.authClass === b.authClass;
}

/** The beta-allowlist class of a provider: first-party only for Anthropic's own API. */
export function anthropicProviderClass(provider: Pick<OcxProviderConfig, "baseUrl" | "authMode">): AnthropicProviderClass {
  return credentialDomainFor(provider)?.firstPartyAnthropic ? "first-party" : "compatible";
}

function isOpaqueBlock(block: unknown): boolean {
  if (!isRec(block)) return false;
  if (block.type === "redacted_thinking") return true;
  return block.type === "thinking" && Object.hasOwn(block, "signature");
}

/** Whether a Messages body carries any thinking signature or `redacted_thinking` block. */
export function messagesBodyHasOpaqueState(body: Readonly<Rec>): boolean {
  if (!Array.isArray(body.messages)) return false;
  for (const message of body.messages) {
    if (isRec(message) && Array.isArray(message.content) && message.content.some(isOpaqueBlock)) return true;
  }
  return false;
}

export interface OpaqueStateResult {
  /** The body to send. The input itself when nothing had to change. */
  body: Rec;
  /** Whether opaque state was removed for this destination. */
  stripped: boolean;
}

/**
 * The body a destination may receive. First-party Anthropic keeps every signature and redacted
 * block; any other or unknown destination gets a copy without them. Copy-on-write: only the
 * messages that change are copied, and the input is never mutated. A message left with no
 * content is dropped rather than sent empty.
 */
export function opaqueStateForDestination(body: Rec, domain: CredentialDomain | undefined): OpaqueStateResult {
  if (domain?.firstPartyAnthropic || !messagesBodyHasOpaqueState(body)) return { body, stripped: false };
  const messages: unknown[] = [];
  for (const message of body.messages as unknown[]) {
    if (!isRec(message) || !Array.isArray(message.content) || !message.content.some(isOpaqueBlock)) {
      messages.push(message);
      continue;
    }
    const content: unknown[] = [];
    for (const block of message.content) {
      if (!isOpaqueBlock(block)) {
        content.push(block);
        continue;
      }
      const opaque = block as Rec;
      if (opaque.type === "redacted_thinking") continue;
      const { signature: _signature, ...visible } = opaque;
      content.push(visible);
    }
    if (content.length > 0) messages.push({ ...message, content });
  }
  return { body: { ...body, messages }, stripped: true };
}
