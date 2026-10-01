# 040 wp4: landing

1. `bun run typecheck`, full `bun run test` (documented resource exception only), `bun run privacy:scan`, `bun run structure:check`, both test-layout guards, file-size ratchet, core-lab boundary, GUI gates.
1a. Dispatch an independent security review of the final diff (credential forwarding, outbound policy, env keys); record its verdict in the PR Verification section.
2. Push `codex/jev-decision-routing`; upload screenshot to `pr-assets` branch, link by commit SHA.
3. `gh pr create --base dev` with every template section; `Co-authored-by` trailers for SeongwoongCho, yxr1995-maker, codingbooo in the description; `Closes #6268` style link (manual close note since base is dev).
4. Wait for required CI on the exact head SHA; fix and repush on failure.
5. After green: comment+close #6185, #6275, #6302 with link and thanks; comment on #6348 (already closed) asking for a rebase of level/quota mode onto the new PR; comment on #6268 linking the PR.
6. Report PR URL, head SHA, CI run URL, closed PRs, residual risks.
