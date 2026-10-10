# wp1 — Kiro request-wide image cap and malformed image markers

Closes #6118. Carries #6130 then #6131 by AaronZ345.

## Changes (cherry-pick, in order)

1. `git cherry-pick c53f9a64cf 5f61e7af8c 7a9c15aef7` (#6130): MODIFY
   `src/adapters/kiro-images.ts`: after decode and byte normalization, count surviving
   images oldest-to-newest across the request and replace the oldest history images past
   100 with bounded omission markers; the current turn's images survive. MODIFY
   `tests/providers/kiro/kiro-images.test.ts` (101-image regression), docs-site
   `reference/adapters.md` (en, zh-cn), `structure/providers/kiro.md`.
2. `git cherry-pick 57d3ed0eee 6dae9dd158 df746b4dbb` (#6131): MODIFY
   `src/adapters/kiro-images.ts` (malformed-inline marker next to the remote marker),
   `src/adapters/kiro/payload.ts` (carry markers through user turns and grouped tool
   results), `tests/providers/kiro/kiro-remote-image.test.ts`, the same docs. Expected
   conflict: `reference/adapters.md` and its zh-cn twin; keep both new sentences.
3. Keep the six commits with their original author; the PR body adds
   `Co-authored-by: zhangyu.34 <zhangyu.34@bytedance.com>`.

## Acceptance

- 101 small inline images across history: the request carries 100, the dropped one is the
  oldest history image, and the latest-turn image is present.
- A malformed `data:` URL in a user turn and in a tool result yields the malformed marker,
  distinct from the remote marker, and does not count toward the cap.
- The hosted `test 2/4` failure on the source PRs was the release-version test (tree at
  2.69.0 after tag v2.69.0); on a dev base at 2.70.0 it passes.

## Verify

`bun test tests/providers/kiro/kiro-images.test.ts tests/providers/kiro/kiro-remote-image.test.ts`,
`bun run typecheck`, `bun run test:changed`, `bun run structure:check`,
`bun run privacy:scan`, docs-site build.
