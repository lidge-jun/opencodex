/**
 * The SOCKS5 handshake both raw outbound transports share: method negotiation
 * (RFC 1928), the optional RFC 1929 username/password subnegotiation, and the
 * CONNECT exchange.
 *
 * `src/lib/socks5-fetch.ts` (the HTTP tunnel) and
 * `src/chatgpt/desktop-unblock/ws-upstream.ts` (the ChatGPT desktop relay's raw
 * dial) each own their socket, their timeouts, and what happens after CONNECT;
 * this module only frames bytes through the reader each hands it, so a
 * credentialed `socks5://` proxy URL authenticates identically whether the caller
 * is a fetch or a raw WebSocket upgrade. When the URL carries credentials the
 * greeting offers NO-AUTH alongside USER-PASS, which keeps an unauthenticated
 * proxy working for a caller that configured more than it needed.
 */

export class Socks5HandshakeError extends Error {
  override readonly name = "Socks5HandshakeError";
}

const SOCKS5_VERSION = 0x05;
const SOCKS5_NO_AUTH = 0x00;
const SOCKS5_USER_PASS = 0x02;
const SOCKS5_CONNECT = 0x01;
const SOCKS5_DOMAIN = 0x03;
const SOCKS5_SUCCESS = 0x00;

/** RFC 1929 credentials decoded from the proxy URL, each bounded to one length byte. */
export interface Socks5Credentials {
  username?: Uint8Array;
  password?: Uint8Array;
}

export function socks5Credentials(proxy: URL): Socks5Credentials {
  if (!proxy.username && !proxy.password) return {};
  let username: string;
  let password: string;
  try {
    username = decodeURIComponent(proxy.username);
    password = decodeURIComponent(proxy.password);
  } catch {
    throw new Socks5HandshakeError("SOCKS5 proxy credentials contain invalid percent encoding");
  }
  const usernameBytes = new TextEncoder().encode(username);
  const passwordBytes = new TextEncoder().encode(password);
  if (usernameBytes.byteLength > 255 || passwordBytes.byteLength > 255) {
    throw new Socks5HandshakeError("SOCKS5 proxy credentials must each fit in 255 UTF-8 bytes");
  }
  // RFC 1929 needs both fields, each 1-255 bytes; `user@` or `:pass@` would send a zero length.
  if (usernameBytes.byteLength === 0 || passwordBytes.byteLength === 0) {
    throw new Socks5HandshakeError("SOCKS5 proxy credentials need both a username and a password");
  }
  return { username: usernameBytes, password: passwordBytes };
}

/**
 * The slice of a transport's socket reader the handshake needs: exact-length reads
 * that reject on close, on error, or on the transport's own timeout, plus writes.
 * Bytes read past a step stay queued in the transport's reader; the handshake never
 * touches the socket itself.
 */
export interface Socks5HandshakeReader {
  write(bytes: Uint8Array): void;
  readExact(bytes: number, signal?: AbortSignal): Promise<Uint8Array>;
}

export interface Socks5Target {
  host: string;
  port: number;
}

/** Negotiate methods, authenticate when the proxy picks USER-PASS, and CONNECT to `target`. */
export async function socks5Handshake(
  reader: Socks5HandshakeReader,
  target: Socks5Target,
  credentials: Socks5Credentials,
  signal?: AbortSignal,
): Promise<void> {
  const hostBytes = Buffer.from(target.host, "utf8");
  if (hostBytes.byteLength > 255) throw new Socks5HandshakeError("SOCKS5 target hostname is too long");
  const methods = credentials.username ? [SOCKS5_NO_AUTH, SOCKS5_USER_PASS] : [SOCKS5_NO_AUTH];
  reader.write(Buffer.from([SOCKS5_VERSION, methods.length, ...methods]));
  const greeting = await reader.readExact(2, signal);
  if (greeting[0] !== SOCKS5_VERSION) throw new Socks5HandshakeError("SOCKS5 proxy returned an invalid greeting");
  if (greeting[1] === SOCKS5_USER_PASS && credentials.username && credentials.password) {
    reader.write(Buffer.from([
      0x01,
      credentials.username.byteLength,
      ...credentials.username,
      credentials.password.byteLength,
      ...credentials.password,
    ]));
    const auth = await reader.readExact(2, signal);
    if (auth[0] !== 0x01 || auth[1] !== 0x00) throw new Socks5HandshakeError("SOCKS5 proxy authentication failed");
  } else if (greeting[1] !== SOCKS5_NO_AUTH) {
    throw new Socks5HandshakeError("SOCKS5 proxy does not accept an offered authentication method");
  }

  reader.write(Buffer.from([
    SOCKS5_VERSION,
    SOCKS5_CONNECT,
    0x00,
    SOCKS5_DOMAIN,
    hostBytes.byteLength,
    ...hostBytes,
    target.port >> 8,
    target.port & 0xff,
  ]));
  const reply = await reader.readExact(4, signal);
  if (reply[0] !== SOCKS5_VERSION) throw new Socks5HandshakeError("SOCKS5 proxy returned an invalid connect response");
  if (reply[1] !== SOCKS5_SUCCESS) throw new Socks5HandshakeError(`SOCKS5 proxy refused the connection (code ${reply[1]})`);
  if (reply[2] !== 0x00 || ![0x01, SOCKS5_DOMAIN, 0x04].includes(reply[3]!)) {
    throw new Socks5HandshakeError("SOCKS5 proxy returned an invalid address type or reserved byte");
  }
  const addressLength = reply[3] === 0x01 ? 4 : reply[3] === SOCKS5_DOMAIN ? (await reader.readExact(1, signal))[0]! : 16;
  await reader.readExact(addressLength + 2, signal);
}
