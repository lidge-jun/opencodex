/**
 * Manual protobuf + Connect-RPC streaming envelope helpers.
 *
 * Connect-RPC streaming wire format (HTTPS POST body):
 *   ┌─────────────┬────────────────┬──────────────┐
 *   │ flags 1byte │ length 4B BE   │   payload    │
 *   └─────────────┴────────────────┴──────────────┘
 *   flags bit 0x01 = payload is gzip-compressed
 *   flags bit 0x02 = end-of-stream (trailer frame — JSON {error} or empty {})
 *
 * All `Get*` methods on `exa.api_server_pb.ApiServerService` that the
 * language_server calls upstream use this format, content-type
 * `application/connect+proto`, with `Connect-Protocol-Version: 1`.
 *
 * Kept tiny and dependency-free — same philosophy as src/plugin/protobuf.ts.
 */

import * as zlib from 'zlib';

// ----------------------------------------------------------------------------
// Proto wire encode
// ----------------------------------------------------------------------------

export function encodeVarint(value: number | bigint): Buffer {
  const v0 = BigInt(value);
  // Reject negatives at the boundary. Proto3 spec encodes signed types as
  // 10-byte sign-extended varints; we don't support that here and the
  // current call sites never need it (tags, lengths, request ids — all
  // strictly positive). The old loop body would have terminated with
  // `Number(-1n)` = -1, producing a malformed single 0xFF byte that the
  // server would misparse silently. Throw instead so future regressions
  // surface immediately.
  if (v0 < 0n) {
    throw new RangeError(`encodeVarint: negative input not supported (got ${value})`);
  }
  const bytes: number[] = [];
  let v = v0;
  while (v > 127n) {
    bytes.push(Number(v & 0x7fn) | 0x80);
    v >>= 7n;
  }
  bytes.push(Number(v));
  return Buffer.from(bytes);
}

export function encodeTag(fieldNum: number, wire: number): Buffer {
  return encodeVarint((fieldNum << 3) | wire);
}

export function encodeString(fieldNum: number, s: string): Buffer {
  const buf = Buffer.from(s, 'utf8');
  return Buffer.concat([encodeTag(fieldNum, 2), encodeVarint(buf.length), buf]);
}

export function encodeMessage(fieldNum: number, body: Buffer): Buffer {
  return Buffer.concat([encodeTag(fieldNum, 2), encodeVarint(body.length), body]);
}

export function encodeVarintField(fieldNum: number, v: number | bigint): Buffer {
  return Buffer.concat([encodeTag(fieldNum, 0), encodeVarint(v)]);
}

export function encodeFixed64Field(fieldNum: number, v: number): Buffer {
  const b = Buffer.alloc(8);
  b.writeDoubleLE(v, 0);
  return Buffer.concat([encodeTag(fieldNum, 1), b]);
}

export function encodeTimestampBody(): Buffer {
  const now = Date.now();
  const seconds = Math.floor(now / 1000);
  const nanos = (now % 1000) * 1_000_000;
  return Buffer.concat([
    encodeVarintField(1, seconds),
    nanos > 0 ? encodeVarintField(2, nanos) : Buffer.alloc(0),
  ]);
}

// ----------------------------------------------------------------------------
// Proto wire decode
// ----------------------------------------------------------------------------

export function decodeVarint(buf: Buffer, offset: number): [bigint, number] {
  let res = 0n;
  let shift = 0n;
  let i = offset;
  while (i < buf.length) {
    const b = buf[i++];
    res |= BigInt(b & 0x7f) << shift;
    if (!(b & 0x80)) return [res, i];
    shift += 7n;
  }
  throw new Error('truncated varint');
}

export interface ProtoField {
  num: number;
  wire: number;
  /** varint → bigint, fixed → 8/4 byte Buffer, length-delim → payload Buffer. */
  value: bigint | Buffer;
}

export function* iterFields(buf: Buffer): Generator<ProtoField> {
  let i = 0;
  while (i < buf.length) {
    const [tagBig, ai] = decodeVarint(buf, i);
    i = ai;
    const tag = Number(tagBig);
    const num = tag >> 3;
    const wire = tag & 0x7;
    if (wire === 0) {
      const [v, bi] = decodeVarint(buf, i);
      i = bi;
      yield { num, wire, value: v };
    } else if (wire === 1) {
      // Bounds-check: a truncated frame mustn't yield a short fixed64 slice
      // that downstream readers treat as a full 8-byte value. Stop iterating
      // cleanly instead.
      if (i + 8 > buf.length) return;
      yield { num, wire, value: buf.slice(i, i + 8) };
      i += 8;
    } else if (wire === 2) {
      const [n, ci] = decodeVarint(buf, i);
      i = ci;
      const len = Number(n);
      // Bounds-check: when the declared length runs past the buffer, the
      // frame is corrupt or truncated. Returning short-buffered slices to
      // downstream parsers used to misparse silently (M12).
      if (len < 0 || i + len > buf.length) return;
      yield { num, wire, value: buf.slice(i, i + len) };
      i += len;
    } else if (wire === 5) {
      if (i + 4 > buf.length) return;
      yield { num, wire, value: buf.slice(i, i + 4) };
      i += 4;
    } else if (wire === 3 || wire === 4) {
      // Wire types 3 (start group) and 4 (end group) are deprecated in
      // proto3 but show up in some Codeium server-generated messages. They
      // carry no length info; the safe behavior is to stop iterating
      // gracefully rather than tear down the whole frame parse.
      return;
    } else {
      // Unknown wire type — bail rather than misalign.
      return;
    }
  }
}

// ----------------------------------------------------------------------------
// Connect-streaming envelope
// ----------------------------------------------------------------------------

/**
 * Wrap `body` (a serialized proto message) in a Connect-streaming envelope.
 * If `compress` is true, gzip the payload and set the 0x01 flag.
 */
export function frameConnectStream(body: Buffer, compress = true): Buffer {
  let payload = body;
  let flags = 0;
  if (compress) {
    payload = zlib.gzipSync(body);
    flags |= 0x01;
  }
  const header = Buffer.alloc(5);
  header[0] = flags;
  header.writeUInt32BE(payload.length, 1);
  return Buffer.concat([header, payload]);
}

export interface ConnectFrame {
  flags: number;
  /** Decompressed payload (gzip handled here if flags & 0x01). */
  payload: Buffer;
  /** Frame is the trailer (end-of-stream). */
  eos: boolean;
}

/**
 * Parse all Connect-streaming frames out of a response body.
 *
 * Returns array of decoded frames. Each frame's payload is already gzip-decoded
 * if the compression flag was set.
 */
export function parseConnectFrames(buf: Buffer): ConnectFrame[] {
  const out: ConnectFrame[] = [];
  let i = 0;
  while (i + 5 <= buf.length) {
    const flags = buf[i];
    const len = buf.readUInt32BE(i + 1);
    if (i + 5 + len > buf.length) break;
    let payload = buf.slice(i + 5, i + 5 + len);
    if (flags & 0x01) {
      // Compressed frame. If gunzip fails the frame is genuinely corrupt
      // — surfacing as a thrown error beats parsing raw gzip bytes as proto
      // (which previously produced misleading "yielded bad wire type" downstream).
      payload = zlib.gunzipSync(payload);
    }
    out.push({ flags, payload, eos: (flags & 0x02) !== 0 });
    i += 5 + len;
  }
  return out;
}
