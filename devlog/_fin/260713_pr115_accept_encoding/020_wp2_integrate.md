# WP2: integrate and harden upstream encoding control

## Merge

- MERGE `origin/pr/115` into `dev` with `--no-ff`, preserving contributor commit `75109049`.
- If the merge base moves or conflicts appear, stop and re-audit the interdiff; do not manually discard either side.

## Source diff

- MODIFY `src/server/responses.ts` in `fetchWithHeaderTimeout` and its three call sites.
- Replace PR object-spread header construction:

```ts
headers: { "Accept-Encoding": "identity", ...init.headers },
```

- With a normalized helper-local `Headers` instance:

```ts
const headers = new Headers(init.headers);
if (preferIdentityEncoding && !headers.has("accept-encoding")) {
  headers.set("accept-encoding", "identity");
}
```

- Add a final `preferIdentityEncoding = false` parameter and pass `parsed.stream` at the passthrough, ordinary adapter, and 429 retry call sites.
- Pass `headers` to `fetch`. This accepts records, tuple arrays, and `Headers`; `Headers.has` makes override detection case-insensitive.
- A non-streaming call with no explicit encoding must preserve Bun's normal automatic negotiation.
- Keep the contributor rationale comment concise and adjacent to the default injection.

## Test diff

- ADD `tests/fetch-header-timeout.test.ts` as the behavior owner.
- Start a loopback `Bun.serve` upstream and call the exported `fetchWithHeaderTimeout` against it.
- Assert omitted encoding arrives as `identity` on the actual request.
- Assert explicit values survive for record, tuple-array, and `Headers` inputs, including mixed casing.
- Add a controlled local gzip SSE test: the upstream emits one frame, waits, then emits the second. Without identity, Bun's decompressor returns both after the gzip stream closes; with streaming identity enabled, the first frame arrives before the release gate and the second afterward.
- Stop every test server in `afterEach`; use no external provider calls.

## Activation evidence

- The loopback server records the wire-level `accept-encoding` value. The streaming omitted-header case must observe exactly `identity`; this proves the conditional path fired.
- The controlled compressed SSE case must reproduce batched delivery without identity and incremental delivery with identity. This is the functional acceptance gate for the reported failure mechanism.

## Verification

```sh
bun test --isolate tests/fetch-header-timeout.test.ts tests/passthrough-abort.test.ts tests/web-search.test.ts
bun run typecheck
git diff --check
```

## Captured evidence

- Merge commit `150873e6` preserves contributor commit `75109049` as its second parent and ancestor.
- Focused suite: `48 pass / 0 fail`; typecheck and diff check exit 0.
- Cadence test: 10 local reruns passed; independent reviewer reran it 20 times (`60 pass / 0 fail`).
- Controlled gzip delivered both SSE frames in the first decoded chunk; streaming identity delivered `first` and `second` in separate reads.
- Fresh reviewer `019f59a1-12b6-7ef1-bb1f-cb8c5f38b3c1`: `blocking_issues: []`, `VERDICT: PASS`.
