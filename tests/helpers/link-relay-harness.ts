import type { Server } from "bun";
import { createLinkRelaySessions, type LinkRelaySessionOptions } from "../../src/server/index/link-relay-sessions";
import { LINK_RELAY_AUTH_PATH, LINK_RELAY_AUTH_VERSION, LINK_RELAY_SESSION_HEADER, linkRelayProof } from "../../src/link/relay-auth";

export const RELAY_FINGERPRINT = "f".repeat(64);
export const RELAY_KEY_ID = "key-relay";

/** A fake Bun server: the relay only asks it for the peer address. */
export const fakeRelayServer = { requestIP: () => ({ address: "127.0.0.1", port: 40000, family: "IPv4" }) } as unknown as Server<unknown>;

/** A real relay book with one fixed key; `session(linkId)` performs the challenge and returns the nonce header value. */
export function relayHarness(options: Omit<LinkRelaySessionOptions, "fingerprints"> = {}) {
  const sessions = createLinkRelaySessions({ ...options, fingerprints: () => [RELAY_FINGERPRINT] });
  let counter = 0;
  const session = async (linkId: string): Promise<string> => {
    const nonce = (++counter).toString(16).padStart(64, "0");
    const url = new URL(`http://127.0.0.1${LINK_RELAY_AUTH_PATH}`);
    url.searchParams.set("version", LINK_RELAY_AUTH_VERSION);
    url.searchParams.set("key", RELAY_KEY_ID);
    url.searchParams.set("link", linkId);
    url.searchParams.set("nonce", nonce);
    url.searchParams.set("proof", linkRelayProof(RELAY_FINGERPRINT, "caller", RELAY_KEY_ID, linkId, nonce)!);
    const answer = await sessions.dispatch(new Request(url), fakeRelayServer, async () => new Response(null, { status: 500 }));
    if (answer.status !== 204) throw new Error(`relay challenge refused: ${answer.status}`);
    return nonce;
  };
  const request = (path: string, init: RequestInit & { nonce?: string } = {}): Request => {
    const headers = new Headers(init.headers);
    if (init.nonce) headers.set(LINK_RELAY_SESSION_HEADER, init.nonce);
    return new Request(`http://127.0.0.1${path}`, { ...init, headers });
  };
  const dispatch = (req: Request, handler: (req: Request) => Promise<Response>) =>
    sessions.dispatch(req, fakeRelayServer, async inner => handler(inner));
  return { sessions, session, request, dispatch };
}

/** A response whose body is served in the given chunks, one per pull, with an optional gate before each. */
export function chunkedResponse(chunks: readonly string[], init: ResponseInit = {}, gate?: (index: number) => Promise<void>): Response {
  let index = 0;
  const encoder = new TextEncoder();
  return new Response(new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (gate) await gate(index);
      if (index >= chunks.length) { controller.close(); return; }
      controller.enqueue(encoder.encode(chunks[index++]!));
    },
  }, { highWaterMark: 0 }), init);
}
