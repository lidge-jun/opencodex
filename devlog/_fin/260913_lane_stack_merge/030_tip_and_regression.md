# wp4 — S7 global tip and final regression

## #4334 Codex Spark retirement

One pull request, branch `codex/spark-retirement`, 34 core files. It removes
Spark's quota surface and collides with almost every other lane: it shares
`src/codex/auth-api.ts`, `src/codex/routing.ts`, `src/types/config.ts`,
`src/config.ts`, `src/adapters/openai-responses.ts`,
`gui/src/components/CodexAccountPool.tsx`, and
`tests/codex-integration/codex-catalog.test.ts` with lanes S1, S2, and S5.

Preparing it in parallel would mean re-resolving those conflicts after every
lane landing. It therefore waits until `dev` contains all 35 other pull
requests and rebases once.

#4359 must already be merged: it aligns Spark Lite metadata with the serialized
body, and removing Spark before that alignment lands would strand the fix.

## Procedure

```
git fetch origin
git reset --hard origin/codex/spark-retirement
git merge origin/dev
# resolve conflicts against fully landed dev
git commit                                # no [skip ci]; this one runs full CI
bun run typecheck && bun run structure:check && bun run privacy:scan
bun test tests/codex-integration/codex-catalog.test.ts <other touched files>
git push --no-verify origin HEAD:refs/heads/codex/spark-retirement
```

#4334 is a tip by definition, so it gets a full hosted run and is gated on it
like any other tip.

## Final regression gate

After #4334 merges, the dev-branch run on that squash commit is the goal's
closing evidence. Green means every lane landed without regression. Red is
handled with one follow-up fix pull request against `dev`, prepared and merged
the same way, and the goal closes on that follow-up's dev run instead.

## Exit criteria

#4334 shows `MERGED`, and `gh run list --branch dev` reports success for the
final merge commit.

