/**
 * Reads the ALPN offer from a TLS ClientHello without terminating TLS.
 *
 * The picker listener uses it to send a client that offers `h2` to its HTTP/2 server and every
 * other client to its HTTP/1.1 server. The ClientHello is reassembled from as many plaintext
 * handshake records as it spans (RFC 8446 5.1 allows any split), within fixed byte and record
 * limits. This is a routing hint, not validation: parsing stops at the ALPN decision, and the TLS
 * server that receives the replayed bytes validates the handshake. Anything the parser cannot read
 * up to that decision returns false, which keeps that client on HTTP/1.1, the behaviour before
 * HTTP/2 existed here.
 */

/** Wire bytes the front reads before deciding; a real ClientHello is far smaller. */
export const CLIENT_HELLO_MAX_BYTES = 64 * 1024;
/** Handshake records one ClientHello may span. */
export const CLIENT_HELLO_MAX_RECORDS = 16;

const RECORD_HEADER_BYTES = 5;
const RECORD_HANDSHAKE = 0x16;
const MAX_RECORD_PAYLOAD = 16_384;
const HANDSHAKE_CLIENT_HELLO = 0x01;
const EXTENSION_ALPN = 0x0010;

/**
 * Whether the ClientHello at the start of `data` offers `h2` in ALPN. Returns null while more
 * bytes are needed to decide, and false for anything else (not TLS, malformed, over a limit).
 */
export function clientHelloOffersH2(data: Uint8Array): boolean | null {
  const handshake: Uint8Array[] = [];
  let handshakeBytes = 0;
  let at = 0;
  for (let records = 0; ; records++) {
    if (handshakeBytes >= 4) {
      const first = concat(handshake, 4);
      if (first[0] !== HANDSHAKE_CLIENT_HELLO) return false;
      const needed = 4 + ((first[1]! << 16) | (first[2]! << 8) | first[3]!);
      if (needed > CLIENT_HELLO_MAX_BYTES) return false;
      if (handshakeBytes >= needed) return helloOffersH2(concat(handshake, needed).subarray(4));
    }
    if (records >= CLIENT_HELLO_MAX_RECORDS || at >= CLIENT_HELLO_MAX_BYTES) return false;
    if (data.length < at + RECORD_HEADER_BYTES) return null;
    if (data[at] !== RECORD_HANDSHAKE || data[at + 1] !== 0x03) return false;
    const length = (data[at + 3]! << 8) | data[at + 4]!;
    if (length === 0 || length > MAX_RECORD_PAYLOAD) return false;
    const end = at + RECORD_HEADER_BYTES + length;
    if (end > CLIENT_HELLO_MAX_BYTES) return false;
    if (data.length < end) return null;
    handshake.push(data.subarray(at + RECORD_HEADER_BYTES, end));
    handshakeBytes += length;
    at = end;
  }
}

function concat(parts: readonly Uint8Array[], bytes: number): Uint8Array {
  const out = new Uint8Array(bytes);
  let offset = 0;
  for (const part of parts) {
    if (offset >= bytes) break;
    const take = part.subarray(0, bytes - offset);
    out.set(take, offset);
    offset += take.length;
  }
  return out;
}

function helloOffersH2(hello: Uint8Array): boolean {
  let at = 2 + 32; // legacy_version, random
  const skip = (lengthBytes: 1 | 2): boolean => {
    if (at + lengthBytes > hello.length) return false;
    const length = lengthBytes === 1 ? hello[at]! : (hello[at]! << 8) | hello[at + 1]!;
    at += lengthBytes + length;
    return at <= hello.length;
  };
  if (!skip(1) || !skip(2) || !skip(1)) return false; // session id, cipher suites, compression
  if (at + 2 > hello.length) return false; // no extensions block: no ALPN
  const extensionsEnd = at + 2 + ((hello[at]! << 8) | hello[at + 1]!);
  if (extensionsEnd > hello.length) return false;
  at += 2;
  // Unknown and GREASE extensions are skipped by their declared length, in any order.
  while (at + 4 <= extensionsEnd) {
    const type = (hello[at]! << 8) | hello[at + 1]!;
    const length = (hello[at + 2]! << 8) | hello[at + 3]!;
    const body = at + 4;
    if (body + length > extensionsEnd) return false;
    if (type === EXTENSION_ALPN) return alpnListOffersH2(hello.subarray(body, body + length));
    at = body + length;
  }
  return false;
}

function alpnListOffersH2(extension: Uint8Array): boolean {
  if (extension.length < 2) return false;
  const end = 2 + ((extension[0]! << 8) | extension[1]!);
  if (end > extension.length) return false;
  for (let at = 2; at < end;) {
    const length = extension[at]!;
    const name = at + 1;
    if (length === 0 || name + length > end) return false;
    if (length === 2 && extension[name] === 0x68 && extension[name + 1] === 0x32) return true; // "h2"
    at = name + length;
  }
  return false;
}
