# 110.54 — F4: Passthrough Header Regression + Dropped-Frame Visibility

## Objective

Close 110's two hardening items (was P1b + P2 in `30_patch-direction.md`):

- **F4a — RC5 regression test owed.** `sanitizePassthroughHeaders` (`server.ts:283-301`) drops
  stale encoding/length + hop-by-hop headers (phase 100.5). No test asserts the **positive**
  half: that `content-type: text/event-stream` **survives** sanitization. If a future edit
  over-broadens the DROP set and strips `content-type`, native `gpt-*` passthrough breaks
  silently. Add a regression test (the existing `error-fidelity.test.ts` only covers
  `application/json`).
- **F4b — Bun auto-decompress check.** Document the one-time confirmation that Bun's `fetch`
  auto-decompresses the passthrough body, which is the premise that makes dropping
  `content-encoding` safe (`server.ts:278-281`). If Bun ever relays raw gzip bytes, dropping
  `content-encoding` would corrupt the stream — a different fix.
- **F4c — dropped-frame visibility.** Every adapter `catch { continue }`s on a JSON parse
  failure (`openai-chat.ts:192-193`, `google.ts:143`, `anthropic.ts` parse catch). A
  chunk-split or malformed upstream frame is dropped **silently**, which can truncate content
  and (with RC1) end a stream early. The streaming path is deliberately quiet (no unconditional
  `console.*`), so add **opt-in** logging behind an env flag rather than always-on spam.

## Evidence

```text
/Users/jun/Developer/new/700_projects/opencodex/src/server.ts:278-301   sanitizePassthroughHeaders + DROP set
/Users/jun/Developer/new/700_projects/opencodex/src/adapters/openai-chat.ts:189-194  try { JSON.parse } catch { continue }
/Users/jun/Developer/new/700_projects/opencodex/src/adapters/google.ts:143           try { JSON.parse } catch { continue }
/Users/jun/Developer/new/700_projects/opencodex/tests/error-fidelity.test.ts          existing sanitize test (json only)
```

## Files

### NEW

```text
/Users/jun/Developer/new/700_projects/opencodex/tests/passthrough-headers.test.ts
```

Complete content:

```ts
import { describe, expect, test } from "bun:test";
import { sanitizePassthroughHeaders } from "../src/server";

describe("passthrough header sanitization (RC5)", () => {
  test("content-type: text/event-stream survives sanitization", () => {
    const sanitized = sanitizePassthroughHeaders(new Headers({
      "content-type": "text/event-stream; charset=utf-8",
      "content-encoding": "gzip",
      "content-length": "4096",
      "x-request-id": "req_abc",
    }));
    expect(sanitized.get("content-type")).toBe("text/event-stream; charset=utf-8");
    expect(sanitized.has("content-encoding")).toBe(false);
    expect(sanitized.has("content-length")).toBe(false);
    expect(sanitized.get("x-request-id")).toBe("req_abc");
  });

  test("hop-by-hop and stale framing headers are dropped, telemetry preserved", () => {
    const sanitized = sanitizePassthroughHeaders(new Headers({
      "transfer-encoding": "chunked",
      "connection": "keep-alive",
      "te": "trailers",
      "upgrade": "websocket",
      "openai-processing-ms": "812",
      "x-ratelimit-remaining-tokens": "29000",
    }));
    for (const h of ["transfer-encoding", "connection", "te", "upgrade"]) {
      expect(sanitized.has(h)).toBe(false);
    }
    expect(sanitized.get("openai-processing-ms")).toBe("812");
    expect(sanitized.get("x-ratelimit-remaining-tokens")).toBe("29000");
  });
});
```

### NEW

```text
/Users/jun/Developer/new/700_projects/opencodex/src/debug.ts
```

Complete content:

```ts
// Opt-in frame-drop visibility. The streaming path is intentionally quiet (no unconditional
// console output), so this no-ops unless OCX_DEBUG_FRAMES=1. Lets a malformed/chunk-split
// upstream frame be detected instead of silently truncating content.
const DEBUG_FRAMES = process.env.OCX_DEBUG_FRAMES === "1";

export function debugDroppedFrame(adapter: string, payload: string): void {
  if (!DEBUG_FRAMES) return;
  const preview = payload.length > 200 ? `${payload.slice(0, 200)}…` : payload;
  console.error(`[ocx:frame-drop] ${adapter}: ${preview}`);
}
```

### MODIFY (adapters — wire the opt-in helper into each parse catch)

```text
/Users/jun/Developer/new/700_projects/opencodex/src/adapters/openai-chat.ts
```

```diff
+import { debugDroppedFrame } from "../debug";
@@
             try {
               chunk = JSON.parse(payload) as Record<string, unknown>;
             } catch {
+              debugDroppedFrame("openai-chat", payload);
               continue;
             }
```

```text
/Users/jun/Developer/new/700_projects/opencodex/src/adapters/google.ts
```

```diff
+import { debugDroppedFrame } from "../debug";
@@
-            try { chunk = JSON.parse(payload); } catch { continue; }
+            try { chunk = JSON.parse(payload); } catch { debugDroppedFrame("google", payload); continue; }
```

Apply the same one-line change to the `anthropic.ts` parse catch (locate its
`} catch { continue; }` during implementation; the import + helper call are identical).

## Verification

```bash
bun test tests/passthrough-headers.test.ts
bun test tests
bun x tsc --noEmit
git diff --check
```

**F4b manual check (one-time, record the result in the commit body):**

```bash
# Confirm Bun auto-decompresses a gzip upstream body so dropping content-encoding is safe.
bun -e 'const r = await fetch("https://httpbin.org/gzip"); console.log("content-encoding:", r.headers.get("content-encoding")); const t = await r.text(); console.log("decoded JSON ok:", t.trim().startsWith("{"));'
# Expect: body is already-decoded JSON (auto-decompressed). If it prints raw gzip bytes,
# dropping content-encoding is NOT safe and F4b needs a real decode step instead.
```

Expected:

```text
content-type survives; stale/hop-by-hop dropped; telemetry preserved
OCX_DEBUG_FRAMES default off → no console output in normal runs
Bun auto-decompress confirmed
full suite passes; typecheck clean
```

## Commit

```text
[agent] test: lock passthrough SSE header survival; add opt-in frame-drop logging
```
