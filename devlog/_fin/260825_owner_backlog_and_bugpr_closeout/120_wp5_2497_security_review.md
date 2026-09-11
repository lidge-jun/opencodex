# 120 — wp5 remainder: #2497 security review (native-main token refresh)

PR #2497 is the last open `bug`-labelled PR. It is the credential boundary `AGENTS.md`
places under explicit security review, so it got one: an independent adversarial reviewer,
then my own verification of each finding against the tree.

Rebased cleanly onto dev (1/1). ~2,600 lines across 20 files.

## Verdict: not merged. Three security blockers plus a red suite.

### B1 — publication is not atomic (`main-account.ts:319`)

`replaceMainAuthJsonWithoutClobbering` renames the canonical `auth.json` to a backup, then
later `linkSync`s the temp into place. A crash between the two leaves no `auth.json`, and
there is no startup recovery for the `.ocx-main-auth.*.bak` file.

Partially defensible: the code DOES restore the backup on both failure paths it can observe
(`restoreAuthJsonBackupWithoutReplacing` at the snapshot-mismatch and link-failure branches),
and it re-verifies the published snapshot afterwards. What it cannot cover is a process death
between rename and link, and an external writer holding the old inode. The reviewer is right
that the window exists; the code is more careful than "non-atomic" alone suggests.

### B2 — same-account fallback adopts a different grant (`main-account.ts:403`) — ACCEPTED

`freshStoredCredentialForMain` first looks for the SAME refresh grant, which is correct. It
then falls back to `findUniqueFreshCredentialForChatgptAccount` — any fresh pool credential
sharing the ChatGPT account id — and writes that pool refresh token into native-main
`auth.json`. The added test blesses replacing `native-main-refresh` with `pool-main-refresh`.

This is the same hazard `anthropic-routing.ts` fails closed on: a background slot must not
have its credential adopted into an active one merely because the identity matches. Account-id
equivalence is not grant ownership.

### B3 — the "exactly one" replay is one LOGICAL replay, not one physical send

Verified: the guard is set before refresh/rebuild/relay on all three paths
(`core.ts:3460`, `core.ts:4998`, `compact.ts:620`), and the compact path explicitly uses
single-send mode (`compact.ts:647`). But the passthrough post-401 send goes through
`fetchWithTransientRetry` (`core.ts:3532`), whose ladder is 3 transient attempts x 3 reset
attempts. So one 401 recovery can be up to nine physical sends. Nothing reaches the client
twice, but upstream work can be committed more than once.

### B4 — the PR's own new suites are red on this head — REPRODUCED

`bun test tests/responses-native-main-refresh.test.ts tests/responses-compact-native-main-refresh.test.ts`
→ **1 pass / 9 fail**. The fixtures request account-gated `gpt-5.6-sol` without an
authenticated `/models` roster, so dev's entitlement gate (which landed in #2550, after this
PR was written) fails closed before the replay path is reached.

That is a stale-base artefact rather than a defect in the replay logic — but it means the
regressions this PR relies on prove nothing at the head being merged.

## Disposition: NEEDS_HUMAN, not merged

B2 is a credential-ownership decision, not a bug I should silently pick a side on: tightening
it to grant-only changes what happens to an operator who re-logged in through the pool and
expects main to follow. B1 needs a publication redesign. B3 needs the auth replay to bypass
the nested retry ladder.

Fixing all three inside someone else's 2,600-line credential PR and admin-merging it is
exactly the shortcut `AGENTS.md` §"Security working notes" and `MAINTAINERS.md` exist to
prevent. The findings are posted to the PR for the author and the maintainer; the branch stays
unmerged.

Non-blocking, recorded for the author: persistence preserves the old `id_token` while reads
prioritize its account id over a refreshed `access_token`/`account_id`, which can reintroduce
a stale account header (`main-account.ts:173`).

