import { describe, expect, test } from "bun:test";
import {
  RemoteWorkspaceRpcReassembler,
  frameRemoteWorkspaceRpcMessage,
} from "../src/remote-control/workspace-rpc-framing";

describe("Remote Workspace RPC framing", () => {
  test("round-trips a logical message across bounded relay frames", () => {
    const message = new TextEncoder().encode("large-rpc\n".repeat(30_000));
    const frames = [...frameRemoteWorkspaceRpcMessage(message)];
    expect(frames.length).toBeGreaterThan(1);
    expect(Math.max(...frames.map(frame => frame.byteLength))).toBeLessThanOrEqual(64 * 1024 - 24);
    const reassembler = new RemoteWorkspaceRpcReassembler();
    let complete: Uint8Array | null = null;
    for (const frame of frames) complete = reassembler.accept(frame);
    expect(complete).toEqual(message);
  });

  test("rejects out-of-order fragments and forgets cleared partial messages", () => {
    const frames = [...frameRemoteWorkspaceRpcMessage(new Uint8Array(200_000))];
    const reassembler = new RemoteWorkspaceRpcReassembler();
    expect(() => reassembler.accept(frames[1]!)).toThrow("out of order");
    expect(reassembler.accept(frames[0]!)).toBeNull();
    reassembler.clear();
    expect(() => reassembler.accept(frames[1]!)).toThrow("out of order");
  });

  test("rejects a declared allocation above the logical message limit", () => {
    const frame = [...frameRemoteWorkspaceRpcMessage(new Uint8Array(100_000))][0]!.slice();
    new DataView(frame.buffer, frame.byteOffset, frame.byteLength).setUint32(22, 0xffff_ffff);
    expect(() => new RemoteWorkspaceRpcReassembler().accept(frame)).toThrow("fragment bounds");
  });
});
