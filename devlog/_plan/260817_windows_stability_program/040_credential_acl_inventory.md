# 040 — Inventory every credential writer's Windows ACL coverage (F5)

**Depends on:** nothing. Independent of every other phase, including 060 — an
inventory cannot gate CI and should not be sequenced as though it could.

## Change

This phase produces an inventory. Where it lands depends on what it finds.

Enumerate every path that writes a credential, token, OAuth refresh token, or
session secret. Starting points: `src/config.ts` (chmod sites at 221, 316, 450,
1713, 2683, and **3942** — the invalid-config backup (inside
`backupInvalidConfig`, declared at 3937), which copies the whole config
including any secrets it held; dir sites 1704, 2632), `src/oauth/store.ts`,
`src/service.ts:189` and `:386`, `src/lab/artifacts/secure-fs.ts`,
`src/adapters/google-antigravity-replay.ts:251`.

These are seeds, not the list. Start by re-deriving every `chmodSync` call in
`src/` rather than trusting this enumeration — an incomplete seed list is
exactly the false negative this phase exists to avoid, and the 3942 site was
missed on the first pass.

For each, record: the file written, whether `hardenSecretPath` (or the async
twin) runs on **that specific write**, and whether the `chmod` is the only
protection. `chmodSync` is a no-op on Windows, so a writer with only the
`chmod` has no protection there at all.

On the ACL-is-authoritative principle: `src/service.ts:1983` states it, but for
an elevation staging directory specifically — it is evidence for the principle,
not for any credential writer's coverage. Each row needs its own citation.

## Where the output goes

**If every writer is covered:** the table goes in this unit as `041`. It is a
clean bill of health, discloses nothing, and is worth having on record.

**If any writer is not covered:** nothing goes in this unit. Not a redacted
table, not a pointer to a scratch path, not a row saying a gap exists. Per
AGENTS.md, pre-disclosure material stays entirely in scratch (`.tmp/` or a
`mktemp -d` path) until the fix ships. A tracked file saying "there is an
unfixed credential exposure, details elsewhere" is itself disclosure — it tells
a reader exactly where to look and that looking is worthwhile.

In that case this phase reports its status verbally to the maintainer and stays
otherwise silent in the tree. The record comes back afterwards, in `_fin`, once
the fix and its regression test are public.

## Verify

Verified by reading. Each row cites the writing line and the hardening line, or
its absence. No command proves an inventory correct.

## Risk

None to the runtime. The risk is a false negative — marking a writer covered
because `hardenSecretPath` appears somewhere in the file rather than on that
code path.
