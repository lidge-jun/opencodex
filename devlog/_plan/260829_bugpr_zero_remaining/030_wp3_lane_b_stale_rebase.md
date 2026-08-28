# wp3 — Lane B: approved but stale or inherited-red

Dependency position: after wp8, sequenced after wp2 so the first merged rebase confirms
the repaired base before three more follow.

## Members

| PR | head SHA | behind dev | blocking condition |
|----|----------|-----------|--------------------|
| #2822 fold only message-shaped system items | 450b1bc60ccf58f80abcea5905085683ae9575bf | 1 | approved; test 2/4 red on the inherited version line only |
| #2821 scope model removal selectors to provider | d21ad61d51f2a4ae30447f951ced3c20ba9a7edb | 11 | approved; ci/macos/test 2/4 red on release version line only |
| #2785 raise Muse Spark context window to 1M | 107f2cbb281ae4db506471e911127cc2fc8fbb8b | 97 | approved; test 4/4 red, macOS never completed |

All three carry an exact-head APPROVED from Ingwannu conditioned on green exact-head CI.
None touches a security surface: src/adapters/openai-responses.ts, src/cli/models.ts,
src/providers/registry.ts respectively, each with its own test file.

## Per-PR verification obligation

#2821 and #2822 fail ONLY the release version line assertion, which wp8 repairs. That
claim is checked, not assumed: after rebasing, the failing assertion must pass and the
previously failing shard must go green on the exact head. If a shard still fails for a
different reason, the PR moves to wp5 rather than being merged on the assumption that the
base explained everything.

#2785 test 4/4 needs its own read: the reviewer called a duplicate final test
non-blocking, which is a claim to verify against the actual failing assertion before merge.

## Accept criteria

1. Each PR merged with recorded pre-merge head SHA and merged SHA.
2. For each, the specific pre-rebase failing assertion is quoted, and its post-rebase pass
   is quoted from the exact-head run.
3. patch-id --stable + range-diff evidence recorded.
