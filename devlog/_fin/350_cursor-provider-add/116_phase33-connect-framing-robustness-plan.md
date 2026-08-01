# 350.116 — Connect Framing Robustness: Flags / Compression / Buffer Cap / Status (work-phase 33)

Date: 2026-06-27
Branch: dev
Work phase: close finding **#9 (Medium)** + the framing half of **#7** — the Connect frame decoder
accepts unknown/reserved flag bits, does nothing with the compressed flag, never fails on leftover
`pending` at stream end, has no max pending-buffer cap, and the transport never validates HTTP `:status`.

> Status: **PLAN**. C2/C3-class (transport robustness vs corrupted/hostile streams).

---

## 1. Easy explanation

The split-frame fix (`96`) and end-stream fix (`99`) made the happy path correct. But the decoder is
still too trusting: it ignores flag bits it doesn't understand, treats a "this frame is compressed"
flag as if it weren't, will buffer unlimited bytes, and the transport starts parsing before it has
even confirmed the server returned HTTP 200. This phase adds the missing guards so a malformed or
hostile stream fails loudly and safely instead of silently misbehaving or growing memory without bound.

## 2. Pre-write evidence

### Current opencodex — permissive decoder
```68:90:src/adapters/cursor/framing.ts
const flags = view.getUint8(0);
const length = view.getUint32(1, false);
…
return { frame: { flags, payload, compressed: isConnectFrameCompressed(flags),
                  endStream: isConnectFrameEndStream(flags) }, readBytes };
```
- `compressed` is **computed but never acted on** — a compressed frame's bytes are handed to
  `fromBinary(AgentServerMessageSchema, …)` as if uncompressed (`live-transport.ts:161`).
- No validation that `flags` has only known bits (`0x01` compressed, `0x02` end-stream). Reserved high
  bits are silently ignored. (Review #9.)
- `decodeAvailableConnectFrames` (`framing.ts:111-124`) returns a `remainder`; there is **no cap** on
  how large `pending` may grow in `live-transport.ts:147-150`.
- `live-transport.ts:174` finishes on `stream.end` and **never checks** whether `pending.length > 0`
  (an incomplete trailing frame is silently dropped).
- `live-transport.ts` opens the stream and parses `data` immediately; there is **no**
  `stream.on("response", …)` `:status` validation and no `session.on("error", …)` before parsing.

### jawcode reference — partial parity + a proven local pattern
(from research of `jawcode/packages/ai/src/...`)
- jawcode's **Run** path also does NOT cap the buffer, NOT validate reserved flags, NOT decompress
  (`jawcode cursor.ts:372-430`) — so these are hardenings beyond jawcode (review-driven, fine).
- BUT jawcode's **discovery** path already rejects compression and validates `:status`, giving an
  in-family pattern to mirror:
  - reject compressed: `if ((flags & 0b0000_0001) !== 0) return null;` (`discovery/cursor.ts:215-221`).
  - validate status: `req.on("response", h => { const s = Number(h[":status"]??0); if (s<200||s>=300) … })`
    (`discovery/cursor.ts:136-142`).
- Connect spec: one flags byte, 4-byte BE length, payload; end-stream bit `0x02`; the six high bits are
  reserved; compression flag only valid when compression negotiated. (Connect Protocol Reference.)

## 3. Decision

Add decode-time flag validation (reject reserved bits), explicit handling of the compressed flag
(reject unless/until decompression is implemented), a max pending-buffer cap, a fail-on-leftover-pending
at stream end, and HTTP `:status` + session-error validation in the transport — mirroring jawcode's
discovery guards.

## 4. Diff-level plan (depends on `113` finish path for the incomplete-at-end check)

### MODIFY `src/adapters/cursor/framing.ts`
```ts
export const CONNECT_KNOWN_FLAGS = CONNECT_FLAG_COMPRESSED | CONNECT_FLAG_END_STREAM; // 0x03
export const CONNECT_RESERVED_FLAGS_MASK = 0xfc;

function validateDecodedFlags(flags: number): void {
  if ((flags & CONNECT_RESERVED_FLAGS_MASK) !== 0) {
    throw new ConnectFrameError("invalid_flags", `Unsupported Connect frame flags: ${flags}`);
  }
}
```
- Call `validateDecodedFlags(flags)` inside `tryDecodeConnectFrame` after reading `flags`.
- Add `ConnectFrameErrorCode` member `"compressed_unsupported"` (and `"pending_overflow"`,
  `"incomplete_at_end"`). `decodeAvailableConnectFrames` (or the transport) fails when a returned frame
  has `compressed === true` and no decompressor is wired.
- (Decision note: opencodex chooses **fail-closed** on reserved/compressed rather than
  forward-compatible ignore; document this and test it.)

### MODIFY `src/adapters/cursor/live-transport.ts`
- `const MAX_PENDING_BYTES = 32 * 1024 * 1024;` after `pending = concatBytes(...)`:
  `if (pending.length > MAX_PENDING_BYTES) { fail(new ConnectFrameError("pending_overflow", …)); return; }`.
- On `compressed` frame (from `decodeAvailableConnectFrames`): `fail(...compressed_unsupported...)`.
- `stream.on("response", headers => { const status = Number(headers[":status"] ?? 0);
    if (status && status !== 200) fail(new Error(\`Cursor HTTP \${status}\`)); })`.
- `session.on("error", err => fail(asError(err)))`.
- On `stream.end` (ties to `113`): if `pending.length > 0` and no `turnEnded`/end-stream seen →
  `fail("incomplete_at_end")` instead of silent finish.
- On terminal Connect error, close stream/session (cleanup).

## 5. Verification plan (non-destructive)
- extend `tests/cursor-framing.test.ts` (or a new block) — pure decoder, no network:
  - reserved flag bits (e.g. `0x04`, `0x80`) → throws `invalid_flags`.
  - compressed flag (`0x01`) → throws `compressed_unsupported` (chosen fail-closed behavior).
  - split header across chunks / split payload across chunks → buffered correctly (regression of `96`).
  - multiple complete frames in one chunk → all decoded.
  - end-stream `{}` / `{metadata}` success; `{error}` fails (regression of `99`).
- extend `tests/cursor-live-transport.test.ts` with a mock stream:
  - `pending` exceeding cap → fail (`pending_overflow`).
  - `:status` 401/500 on `response` → fail with `Cursor HTTP …`.
  - `stream.end` with non-empty `pending` and no `turnEnded` → fail (`incomplete_at_end`).
- `bun test tests/cursor-*.test.ts` → green; `bun x tsc --noEmit` → exit 0.
- NO live call.

## 6. Out of scope
- Implementing actual frame decompression (gzip/deflate) — deferred; fail-closed is the safe interim.
  If Cursor ever negotiates compression, a follow-up wires the decompressor + flips the test.

## 7. Cross-references
- GPT Pro review 260627 — finding **#9 (Medium)** + framing half of **#7**.
- jawcode `discovery/cursor.ts:136-142, 215-221` (status + compression-reject pattern).
- `96` (split-frame buffering) · `99` (end-stream classification) · `113` (lifecycle) · `118` (index).
