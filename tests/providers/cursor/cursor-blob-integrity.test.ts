import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { cursorBlobServeIntegrityOk, storeCursorBlob } from "../../../src/adapters/cursor/native-exec";

describe("cursor blob serve-time integrity (devlog 260826 080)", () => {
  test("content-addressed blob passes when bytes match the id", () => {
    const data = new TextEncoder().encode('{"role":"user","content":"clean"}');
    const id = storeCursorBlob(data);
    expect(id.byteLength).toBe(32);
    expect(cursorBlobServeIntegrityOk(id, data)).toBe(true);
  });

  test("mutated bytes are detected (splice fault injection)", () => {
    const data = new TextEncoder().encode('{"role":"assistant","content":"[tool_result] output"}');
    const id = new Uint8Array(createHash("sha256").update(data).digest());
    const corrupted = new TextEncoder().encode('{"role":"assistant","content":"[ martool_result] output"}');
    expect(cursorBlobServeIntegrityOk(id, corrupted)).toBe(false);
  });

  test("non-content-addressed ids (not 32 bytes) always pass", () => {
    const served = new TextEncoder().encode("anything");
    expect(cursorBlobServeIntegrityOk(new Uint8Array(8), served)).toBe(true);
    expect(cursorBlobServeIntegrityOk(new Uint8Array(64), served)).toBe(true);
  });
});
