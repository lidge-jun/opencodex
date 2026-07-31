# WP2 — Land #96 with security fixes

Base: fork branch `codex/harden-request-provider-security` (tip `cde614a1`). Fix commits go on
this branch, pushed to the fork (maintainerCanModify), then `gh pr ready 96` + merge. If #103's
merge made #96 CONFLICTING (management-api.ts), first `git merge origin/main` on the branch.

## Fix 1 — bounded decompression (MODIFY `src/server/request-decompress.ts`)

Current (branch): `Bun.zstdDecompressSync` / `Bun.gunzipSync` / `Bun.inflateSync` fully
allocate, then `assertBodySizeWithinLimit` checks. Verified Bun 1.3.14 `node:zlib` sync fns
enforce `maxOutputLength` during inflation (ERR_BUFFER_TOO_LARGE).

Diff sketch:

```ts
import { gunzipSync, inflateSync, zstdDecompressSync } from "node:zlib";

export function decodeRequestBody(raw, contentEncoding, maxBytes = MAX_DECOMPRESSED_BODY_BYTES) {
  // identity path: assertBodySizeWithinLimit(raw, maxBytes)
  const opts = { maxOutputLength: maxBytes };            // per-call, from the PARAM
  try {
    if (encoding === "zstd") decoded = zstdDecompressSync(compressed, opts);
    else if (encoding === "gzip" || encoding === "x-gzip") decoded = gunzipSync(compressed, opts);
    else if (encoding === "deflate") decoded = inflateSync(compressed, opts);
    else throw new UnsupportedContentEncodingError(encoding);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ERR_BUFFER_TOO_LARGE") {
      throw new DecompressedBodyTooLargeError(maxBytes); // PARAM, not constant
    }
    throw err;
  }
  return assertBodySizeWithinLimit(decoded, maxBytes);   // PARAM threaded through
}
```

(`assertBodySizeWithinLimit` and `DecompressedBodyTooLargeError` gain the byte-limit parameter;
re-audit blocker: options/error/assertion must all derive from the param, never the constant.)

Activation test (MODIFY `tests/request-decompress.test.ts`) — audit blocker 4 fold-back:
refactor `decodeRequestBody(raw, contentEncoding, maxBytes = MAX_DECOMPRESSED_BODY_BYTES)` so
tests INJECT a small cap (e.g. 1024) and feed a ~64KB-inflating payload per codec
(zstd/gzip/deflate) — cheap, deterministic, no giant buffers, and it activates the exact
ERR_BUFFER_TOO_LARGE → DecompressedBodyTooLargeError path during inflation.

## Fix 2 — SSRF hostname resolution + reserved ranges (MODIFY `src/lib/destination-policy.ts`)

a) Extend `classifyIpv4` reserved/non-public ranges (after existing checks):

```ts
if (a === 192 && b === 0 && (o3 === 0 || o3 === 2)) return { kind: "private", detail: "reserved address" };
if (a === 198 && (b === 18 || b === 19)) return { kind: "private", detail: "benchmark address" };
if (a === 198 && b === 51 && o3 === 100) return { kind: "private", detail: "documentation address" };
if (a === 203 && b === 0 && o3 === 113) return { kind: "private", detail: "documentation address" };
if (a >= 224) return { kind: "private", detail: "multicast/reserved address" };
```

(destructure `const [a, b, o3] = octets`.)

b) NEW async export `providerDestinationResolvedError(name, provider): Promise<string|null>` —
for `kind === "hostname"` destinations, `dns.promises.lookup(hostname, { all: true, verbatim: true })`,
classify every returned address with classifyIpv4/6; any non-public result → same error string
contract as the sync path. DNS failure (ENOTFOUND etc.) → null (config-time advisory, do not
hard-fail offline startup). Wiring (audit blocker 1 fold-back): the sync helper in
`src/server/auth-cors.ts:155-171` stays sync; the AWAIT goes in the async management write
handler at `src/server/management-api.ts:289-290` right after the existing sync check.
`management-api.ts` overlaps #103 — therefore FIRST merge origin/main (which then contains
#103's aa888074) into the #96 branch, THEN edit. `src/config.ts:147-173` is sync by design —
no DNS there. Router hot path (`src/router.ts:84,114`) stays sync-literal-only — rationale in
000 §Rebutted.

Activation test (MODIFY `tests/*destination*` or the suite covering destination-policy): mock
`node:dns` lookup (bun test `mock.module`) to return `127.0.0.1` / `10.0.0.5` for a hostname →
expect error; `93.184.216.34` → expect null. Literal-range tests for each new reserved block.

## Steps

1. Branch from fork tip; `git merge origin/main` (brings #103, resolves management-api overlap
   deterministically — expected clean for #96 per merge-tree); apply fixes;
   `bun test tests/request-decompress.test.ts <dest-policy tests>` + full `bun test`.
2. Push to fork branch; wait `gh pr checks 96 --watch`; `gh pr ready 96`; `gh pr merge 96 --merge`.

## Accept criteria

- c2: oversized compressed body rejected during inflation (test output) — no full allocation.
- c3: hostname→private DNS result rejected at management write path; new reserved ranges classified (test output).
- Full suite 0 fail on the branch before merge; PR checks green; #96 MERGED.
