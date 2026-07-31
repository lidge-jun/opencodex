# Phase 110 (P0-5) - Eventstream decoder hardening

## Problem

`src/lib/eventstream-decoder.ts` validates CRCs and chunking, but lacks hard
bounds:

- no maximum frame size
- no `headersLen <= total - 16` guard
- `parseHeaders()` reads with DataView/subarray without checking every required
  byte exists first
- bogus large `total` can make the stream buffer grow indefinitely while waiting
  for a never-completing frame

## File changes

### MODIFY src/lib/eventstream-decoder.ts

- Add `MAX_MESSAGE_LEN = 16 * 1024 * 1024`.
- In `decodeMessage`:
  - reject `total > MAX_MESSAGE_LEN`
  - reject `headersLen > total - MIN_MESSAGE_LEN`
- In `parseHeaders`:
  - add a small `need(n, label)` helper before every DataView read / fixed-size
    subarray read
  - throw clear `eventstream: truncated header ...` errors instead of letting
    DataView RangeError or silent short subarrays through
- In `decodeEventStream`:
  - reject advertised `total > MAX_MESSAGE_LEN` as soon as the first 4 bytes are available
  - reject an incomplete single buffered frame if buffer growth exceeds
    `MAX_MESSAGE_LEN`

### MODIFY tests/eventstream-decoder.test.ts

Add tests:

- advertised total length over cap throws
- header length exceeding payload boundary throws
- truncated string header throws a controlled eventstream error
- one valid frame split at every byte boundary still decodes (small fuzz)

## Verification

- bun x tsc --noEmit
- bun test tests/eventstream-decoder.test.ts tests/kiro-adapter.test.ts

## Commit

fix(eventstream): bound frame and header parsing
