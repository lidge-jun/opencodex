/**
 * Minimal, zero-dependency gRPC-Web binary framing encoder and decoder.
 * Supports 5-byte header prefix: 0x00 data frames, 0x80 trailer frames.
 */

export interface GrpcWebTrailer {
  status: number;
  statusMessage?: string;
  metadata: Record<string, string>;
}

export interface DecodedGrpcWebResponse {
  messages: Uint8Array[];
  status: number;
  statusMessage?: string;
  trailers?: GrpcWebTrailer;
}

export class GrpcWebError extends Error {
  readonly status: number;
  readonly statusMessage: string;

  constructor(status: number, statusMessage: string) {
    super(`gRPC-Web call failed with status ${status}: ${statusMessage}`);
    this.name = "GrpcWebError";
    this.status = status;
    this.statusMessage = statusMessage;
  }
}

const FRAME_DATA = 0x00;
const FRAME_TRAILER = 0x80;
const HEADER_SIZE = 5;

/**
 * Encodes a protobuf payload into a single gRPC-Web binary data frame (flag 0x00).
 */
export function encodeGrpcWebEnvelope(message: Uint8Array): Uint8Array {
  const envelope = new Uint8Array(HEADER_SIZE + message.length);
  envelope[0] = FRAME_DATA;
  const view = new DataView(envelope.buffer, envelope.byteOffset, envelope.byteLength);
  view.setUint32(1, message.length, false); // Big-endian u32
  envelope.set(message, HEADER_SIZE);
  return envelope;
}

/**
 * Parses ASCII key-value lines from a gRPC-Web trailer frame payload.
 */
export function parseGrpcWebTrailers(bytes: Uint8Array): GrpcWebTrailer {
  const text = new TextDecoder("utf-8").decode(bytes);
  const lines = text.split(/\r?\n/);
  const metadata: Record<string, string> = {};
  let status = 0;
  let statusMessage: string | undefined;

  for (const line of lines) {
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim().toLowerCase();
    const value = line.slice(colonIdx + 1).trim();
    if (!key) continue;
    metadata[key] = value;
    if (key === "grpc-status") {
      const parsed = parseInt(value, 10);
      if (!Number.isNaN(parsed)) {
        status = parsed;
      }
    } else if (key === "grpc-message") {
      try {
        statusMessage = decodeURIComponent(value);
      } catch {
        statusMessage = value;
      }
    }
  }

  return { status, statusMessage, metadata };
}

/**
 * Decodes a contiguous gRPC-Web binary stream into data messages and trailing metadata.
 */
export function decodeGrpcWebResponse(bytes: Uint8Array): DecodedGrpcWebResponse {
  const messages: Uint8Array[] = [];
  let offset = 0;
  let trailer: GrpcWebTrailer | undefined;

  while (offset + HEADER_SIZE <= bytes.length) {
    const flag = bytes[offset];
    const view = new DataView(bytes.buffer, bytes.byteOffset + offset, HEADER_SIZE);
    const length = view.getUint32(1, false);
    const frameStart = offset + HEADER_SIZE;
    const frameEnd = frameStart + length;

    if (frameEnd > bytes.length) {
      throw new Error(`Incomplete gRPC-Web frame at offset ${offset}: expected ${length} bytes, got ${bytes.length - frameStart}`);
    }

    const payload = bytes.subarray(frameStart, frameEnd);

    if (flag === FRAME_DATA) {
      messages.push(payload);
    } else if (flag === FRAME_TRAILER) {
      trailer = parseGrpcWebTrailers(payload);
    }

    offset = frameEnd;
  }

  const finalStatus = trailer ? trailer.status : 0;
  const finalMessage = trailer?.statusMessage;

  return {
    messages,
    status: finalStatus,
    statusMessage: finalMessage,
    trailers: trailer,
  };
}
