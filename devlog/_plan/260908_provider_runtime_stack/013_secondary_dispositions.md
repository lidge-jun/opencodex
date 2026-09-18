# 013 — Secondary PR dispositions (bounded triage, read-only)

Method: `gh pr view`, `git merge-tree --write-tree` against `origin/dev` and against the L3
head `85ad0a29a`, blob reads. No bun command run. Triage agent: claude-opus-5.

| PR | Author | Size | Conflicts vs dev / vs stack | C4 surface | Maintainer state | Layout | Verdict |
|---|---|---|---|---|---|---|---|
| #3990 Hermes source-preserving YAML | rrmlima | 5 files +106/−44 | none / none | no | approved ("머지하세요") | already mapped | INCLUDE → L5 |
| #3988 Gemini model-tail continue nudge | rrmlima | 2 files +51/−14 | none / none | no | approved after CI | already mapped | INCLUDE → L6 |
| #3833 Command Code native integration | rrmlima | 9 files +256/−4 | none / none | no | stale review mostly fixed | layout trap: `command-code-client.test.ts` seeds to `providers` (`layout.json:14`), explicit `clients` entry would trip the seed-mismatch check (`test-layout-tooling.test.ts:282`); needs rename or `pinnedOverrides` — design call | DEFER |
| #3952 openai-chat freeform + Moonshot Responses | yxr1995-maker | 9 files +467/−11 | none / none | no | "지금 형태로는 merge하지 마세요"; bundles three changes; `apply-patch-envelope.ts:51-59` fence stripping can truncate legit bodies; flips `moonshot` adapter default | DEFER (split required) |
| #3639 EntraID for Azure Foundry | chrisoro | 39 files +590/−62 | none / none | yes (new `@azure/identity` dep, new credential path) | hygiene-blocked, security review required | — | REJECT for this stack |
| #3283 Antigravity pool + Gemini 3.8 | vanch007 | 14 files +960/−53 | 2 / 2 (`responses/parser.ts`, `server/responses/core.ts`) | yes | "merge 비추천"; competes with #2562 | — | REJECT |
| #3282 Copilot context tier | Simon-Opopeee | 39 files +521/−14 | 8 / 8 | yes | provider guard missing, screenshot missing, hygiene-blocked | root test file | REJECT |
| #2230 Gemini OAuth accounts | ppvia | 33 files +1637/−61 | 16 / 16 | yes (embedded OAuth client secret) | maintainer-sponsored security review mandatory | unregistered tests | REJECT |

#3990 and #3988 are pairwise clean with each other and with every other candidate
(`merge-tree` exit 0 for all combinations). Both are runtime-scope, no auth/credential/workflow
surface, and the maintainer already approved their content. They become L5 and L6 above the
marks layer, each cherry-picked with `-x` to keep rrmlima as author.

DEFER/REJECT items are not closed by this unit; their disposition is recorded here for the
next triage pass.
