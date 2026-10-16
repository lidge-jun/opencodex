# wp5 — PR #2986 xAI Imagine image_gen relay (carry of #2083)

State at entry: head `842170b6f`, 25 files +1175/-64, exact-head CI fully green, rebased cleanly onto
`origin/dev` (`6a6efa928`) as `codex/carry-2083-xai-imagine-2` (`b7ad8820c`) with no conflicts.
Reviewer (Ingwannu) confirmed all three code blockers resolved at `842170b6f` and left two
documentation-boundary items before approval. No code redesign requested.

## Scope (docs only)

1. `docs-site/src/content/docs/guides/codex-integration.md` — xAI Imagine relay bullet:
   - state that the Grok grant is used only when the `xai` provider has `authMode: "oauth"`
     (`resolveXaiImageAuthToken` in `src/images/plan.ts`); any other authMode uses the API key.
   - state that an explicit `images.provider` owns `/v1/images` and prevents the xAI fallback.
   - result URL contract beside the 100 MiB cap: public HTTPS only, no redirects, no file/loopback,
     bounded download (`MAX_DOWNLOAD_BYTES` 50 MiB per file), artifacts served through the
     authenticated management endpoint.
2. Same factual sentences in the locale copies of the same bullet (ja/ko/zh-cn/zh-tw/ru/fr/tr) where
   the bullet exists, so a translation does not contradict English.
3. Resolve the now-fixed `maxBytes` review thread.

## Acceptance

- English bullet contains: authMode oauth condition, explicit images.provider precedence, URL contract.
- Locales that carry the bullet do not contradict it.
- `bun x tsc --noEmit` and `bun run privacy:scan` clean; focused `tests/server-images.test.ts`,
  `tests/responses-parser.test.ts` green (unchanged code, sanity).
- Push `--no-verify` to the same PR branch (force since rebased), admin squash merge, landing proof, close #2083
  as landed-via-carry.

