# Phase 1 — Request-body decompression on /v1/responses

Codex compresses HTTP Responses bodies with zstd when `enable_request_compression`
(default ON) fires: auth is codex-backend AND provider `is_openai()` (client.rs:1213).
Under Design B the provider id IS `openai`, so the HTTP fallback path (WS failed or
disabled) sends `content-encoding: zstd` and today's `req.json()` throws → 400.

## Files

**NEW `src/request-decompress.ts`**

```ts
/** Decode an optionally compressed JSON request body (codex sends zstd when
 * enable_request_compression fires for the built-in openai provider). */
export class UnsupportedContentEncodingError extends Error {
  constructor(readonly encoding: string) {
    super(`Unsupported content-encoding: ${encoding}`);
  }
}

export function decodeRequestBody(raw: Uint8Array, contentEncoding: string | null): Uint8Array {
  const encoding = (contentEncoding ?? "").trim().toLowerCase();
  if (encoding === "" || encoding === "identity") return raw;
  if (encoding === "zstd") return Bun.zstdDecompressSync(raw);
  if (encoding === "gzip" || encoding === "x-gzip") return Bun.gunzipSync(raw);
  if (encoding === "deflate") return Bun.inflateSync(raw);
  throw new UnsupportedContentEncodingError(encoding); // incl. multi-codings like "zstd, gzip"
}

export async function readJsonRequestBody(req: Request): Promise<unknown> {
  const encoding = req.headers.get("content-encoding");
  if (!encoding) return await req.json(); // fast path, no buffering change
  const decoded = decodeRequestBody(new Uint8Array(await req.arrayBuffer()), encoding);
  return JSON.parse(new TextDecoder().decode(decoded));
}
```

**MODIFY `src/server.ts`** — `handleResponses` body parse (~:257):

```ts
// before
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return formatErrorResponse(400, "invalid_request_error", "Invalid JSON body");
  }
// after
  let body: unknown;
  try {
    body = await readJsonRequestBody(req);
  } catch (err) {
    if (err instanceof UnsupportedContentEncodingError) {
      return formatErrorResponse(415, "invalid_request_error", err.message);
    }
    return formatErrorResponse(400, "invalid_request_error", "Invalid JSON body");
  }
```
plus import line. Scope: /v1/responses POST only — codex compresses nothing else;
management API and WS frames unaffected.

**NEW `tests/request-decompress.test.ts`** — unit: identity/absent passthrough, zstd
round-trip (`Bun.zstdCompressSync`), gzip round-trip, deflate round-trip, unsupported
encoding throws, garbage zstd throws. Integration-ish: build a `Request` with
compressed body + header and assert `readJsonRequestBody` returns the object.

## Accept

- `bun test tests/request-decompress.test.ts` green.
- `bun test` (full) green — no behavior change for uncompressed bodies.
- Manual fact (already reproduced): zstd body previously 400 → now parses.
