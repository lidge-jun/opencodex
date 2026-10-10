# Roadmap audit and baseline proof

The independent reviewer (`01a0e349-7a9f-73f3-a3d1-b32cfdf9de9a`, `gpt-6-sol`) audited the docs-first plan at `dev` `24b2f39b77`. Its first verdict was `GO-WITH-FIXES`: the named i18n command was not a root script and did not inspect locale dictionaries, and Phase 030 omitted catalog/GUI consumers of #5617. Both High blockers were folded. Three Medium gaps were also fixed: Phase 040 now explicitly defers auth work, Phase 050 names the real file-size test and treats layout.json as an inventory, and branches are sequential from the previous accepted `dev` merge. A final one-line summary and NEW-vs-MODIFY path correction were rechecked. The last verdict was **PASS** with no blocking issue.

The same architect (`01a0e33b-a8a7-7ab3-8682-461189c7d1c8`) reflected on the initial plan and later field/consumer and phase-dependency amendments; its final verdict was **ALIGNED**. Main rejected its early inference that an OAuth account alias closes #3379: the requested Codex selector rename remains absent. Explorer findings used for the plan were read-only and tied to PR heads in `001_inventory.md`.

Baseline command evidence in this worktree:

| Command | Result | What it actually observes |
|---|---|---|
| `bun run privacy:scan` | pass | Credential/privacy patterns in repository content; rerun after staging docs. |
| `bun test tests/ci-workflows/file-size-ratchet.test.ts` | first attempt failed: missing `zod/v4`; after `bun install --frozen-lockfile`, 9 pass / 0 fail | Repository file-size cap including `gui/src/pages/Models.tsx`. No baseline was updated. |
| `cd gui && bun test tests/locale-parity.test.ts` | after GUI frozen install, 5 pass / 0 fail | Reads locale modules directly and checks key-set parity for ten locales; translation meaning still needs human/browser review. |
| `cd gui && bun run lint:i18n` | not yet run on a changed GUI | Oxlint checks visible JSX copy, not locale dictionary key parity. |

All installs used the committed lockfiles in the lane worktree. No production home, service, token, account, browser session or `dev` branch was touched in this docs-only phase. The `0.2.39` Codexclaw cache path disappeared during the audit; the now-installed `0.2.36` CLI read the same bound session/source and continued with explicit `--session`. That tool drift is not verification of product behavior.
