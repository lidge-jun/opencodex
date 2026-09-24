# L4 roadmap — Codex integration, CLI and service

Branch codex/260924-l4-codex-cli-service from origin/dev be0b5294e5. One PR to dev. Merge is the coordinator's.

| Unit | Doc | Items | Method |
|---|---|---|---|
| wp1 | 010 | #5713, #5703, #5548 slice | squash-diff apply per PR, one commit each with Co-authored-by |
| wp2 | 020 | #5221 | rebuild on dev by DeepSeek writer; sibling test files |
| wp3 | 030 | #5009 | squash-diff apply, review sender/admission checks |
| wp4 | 040 | #5694 | DeepSeek writers: default-on 98% hard lock |
| wp5 | 050 | publish | rebase, validate, push, PR, checks |

Ratchet: tests/fixtures/file-size-baseline.json caps only move down; every commit re-runs tests/test-layout.test.ts and the file-size test.

