import { randomBytes } from "node:crypto";
import { REMOTE_CONTROL_MAX_RELAY_PAYLOAD_BYTES } from "./protocol";

const RPC_FRAME_MAGIC = Uint8Array.of(0x4f, 0x43, 0x58, 0x52); // OCXR
const RPC_FRAME_VERSION = 1;
const RPC_FRAME_HEADER_BYTES = 30;
const RPC_FRAME_MESSAGE_ID_BYTES = 16;
const RPC_FRAME_MESSAGE_ID_OFFSET = 6;
const RPC_FRAME_TOTAL_BYTES_OFFSET = 22;
const RPC_FRAME_CHUNK_OFFSET = 26;
const RPC_ENCRYPTION_OVERHEAD_BYTES = 24;
const RPC_MAX_PLAINTEXT_FRAME_BYTES = REMOTE_CONTROL_MAX_RELAY_PAYLOAD_BYTES - RPC_ENCRYPTION_OVERHEAD_BYTES;
const RPC_MAX_CHUNK_BYTES = RPC_MAX_PLAINTEXT_FRAME_BYTES - RPC_FRAME_HEADER_BYTES;
const RPC_MAX_INCOMPLETE_MESSAGES = 8;
const RPC_INCOMPLETE_MESSAGE_TTL_MS = 30_000;

// A 256 KiB UTF-8 write can expand by up to 6x when JSON escapes control bytes.
// Keep the wire contract bounded while still carrying every executor-approved text file.
export const REMOTE_WORKSPACE_RPC_MAX_MESSAGE_BYTES = 2 * 1024 * 1024;

interface IncompleteMessage {
  buffer: Uint8Array;
  nextOffset: number;
  timer: ReturnType<typeof setTimeout>;
}

function hasMagic(value: Uint8Array): boolean {
  return RPC_FRAME_MAGIC.every((byte, index) => value[index] === byte);
}

function messageKey(frame: Uint8Array): string {
  return Buffer.from(
    frame.subarray(RPC_FRAME_MESSAGE_ID_OFFSET, RPC_FRAME_MESSAGE_ID_OFFSET + RPC_FRAME_MESSAGE_ID_BYTES),
  ).toString("hex");
}

function writeHeader(frame: Uint8Array, messageId: Uint8Array, totalBytes: number, offset: number): void {
  frame.set(RPC_FRAME_MAGIC, 0);
  frame[4] = RPC_FRAME_VERSION;
  frame[5] = 0;
  frame.set(messageId, RPC_FRAME_MESSAGE_ID_OFFSET);
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  view.setUint32(RPC_FRAME_TOTAL_BYTES_OFFSET, totalBytes);
  view.setUint32(RPC_FRAME_CHUNK_OFFSET, offset);
}

/**
 * Splits one logical RPC message without retaining a second full-size copy.
 * Each yielded plaintext fits one authenticated relay frame.
 */
export function* frameRemoteWorkspaceRpcMessage(message: Uint8Array): Generator<Uint8Array> {
  if (!(message instanceof Uint8Array)
    || message.byteLength < 1
    || message.byteLength > REMOTE_WORKSPACE_RPC_MAX_MESSAGE_BYTES) {
    throw new Error("invalid remote workspace RPC message length");
  }
  const messageId = randomBytes(RPC_FRAME_MESSAGE_ID_BYTES);
  for (let offset = 0; offset < message.byteLength; offset += RPC_MAX_CHUNK_BYTES) {
    const end = Math.min(offset + RPC_MAX_CHUNK_BYTES, message.byteLength);
    const frame = new Uint8Array(RPC_FRAME_HEADER_BYTES + end - offset);
    writeHeader(frame, messageId, message.byteLength, offset);
    frame.set(message.subarray(offset, end), RPC_FRAME_HEADER_BYTES);
    yield frame;
  }
}

/** Bounded, ordered reassembly for authenticated RPC fragments. */
export class RemoteWorkspaceRpcReassembler {
  private readonly incomplete = new Map<string, IncompleteMessage>();

  accept(frame: Uint8Array): Uint8Array | null {
    if (!(frame instanceof Uint8Array)
      || frame.byteLength <= RPC_FRAME_HEADER_BYTES
      || frame.byteLength > RPC_MAX_PLAINTEXT_FRAME_BYTES
      || !hasMagic(frame)
      || frame[4] !== RPC_FRAME_VERSION
      || frame[5] !== 0) {
      throw new Error("invalid remote workspace RPC frame");
    }
    const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
    const totalBytes = view.getUint32(RPC_FRAME_TOTAL_BYTES_OFFSET);
    const offset = view.getUint32(RPC_FRAME_CHUNK_OFFSET);
    const payload = frame.subarray(RPC_FRAME_HEADER_BYTES);
    if (totalBytes < 1
      || totalBytes > REMOTE_WORKSPACE_RPC_MAX_MESSAGE_BYTES
      || offset >= totalBytes
      || payload.byteLength > totalBytes - offset
      || (offset + payload.byteLength < totalBytes && payload.byteLength !== RPC_MAX_CHUNK_BYTES)) {
      throw new Error("invalid remote workspace RPC fragment bounds");
    }
    if (offset === 0 && payload.byteLength === totalBytes) return payload;

    const key = messageKey(frame);
    let state = this.incomplete.get(key);
    if (!state) {
      if (offset !== 0) throw new Error("remote workspace RPC fragment started out of order");
      if (this.incomplete.size >= RPC_MAX_INCOMPLETE_MESSAGES) {
        throw new Error("remote workspace RPC fragment limit reached");
      }
      const timer = setTimeout(() => this.drop(key), RPC_INCOMPLETE_MESSAGE_TTL_MS);
      timer.unref?.();
      state = { buffer: new Uint8Array(totalBytes), nextOffset: 0, timer };
      this.incomplete.set(key, state);
    } else if (state.buffer.byteLength !== totalBytes || state.nextOffset !== offset) {
      this.drop(key);
      throw new Error("remote workspace RPC fragments are inconsistent or out of order");
    }

    state.buffer.set(payload, offset);
    state.nextOffset += payload.byteLength;
    if (state.nextOffset !== totalBytes) return null;
    this.incomplete.delete(key);
    clearTimeout(state.timer);
    return state.buffer;
  }

  clear(): void {
    for (const state of this.incomplete.values()) clearTimeout(state.timer);
    this.incomplete.clear();
  }

  private drop(key: string): void {
    const state = this.incomplete.get(key);
    if (!state) return;
    clearTimeout(state.timer);
    this.incomplete.delete(key);
  }
}
