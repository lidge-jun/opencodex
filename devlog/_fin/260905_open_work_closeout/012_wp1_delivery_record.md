# 012 — wp1 delivery record

Closed 2026-09-05. Outcome **DONE** (six of seven Stack A items landed; the seventh, #3480,
is carried as the first step of wp2 because its only outstanding check is a queued macOS rerun).

| Original | Carry PR | Carry head | Landing SHA | Ancestry (fresh origin/dev 1362b1a38) |
|----------|----------|------------|-------------|----------------------------------------|
| roadmap | #3538 | bf091040b | d6b457462 | exit 0 |
| #3323 | #3539 | cc599fb79 | 32e059724 | exit 0 |
| #3515 | #3541 | 696847cd4 | 7f5b6e0a6 | exit 0 |
| #3525 | #3542 | 16c5df4a1 | 7eddfb3eb | exit 0 |
| #3490 | #3545 | 8b5370900 | 375f1fa27 | exit 0 |
| #3529 | #3546 | 7c922afaf | 583d6a91b | exit 0 |
| #3484 | #3540 | d30b3c4e4 | 1362b1a38 | exit 0 |
| #3480 | #3544 | 368c5137a | — | pending macOS 2/2 rerun |

Verifier on the landed tip: 95 pass / 0 fail across eight focused files (receipt in
`.codexclaw/evidence/<session>/test-receipt.json`). Every `--admin` merge carries a bypass
comment on its PR. Originals are closed with landing SHAs in wp6 (060).

