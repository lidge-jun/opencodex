# 050 — WP10: Windows transactional-update rollback + tsig credential-scope half

Disposition (matrix 040 row): bounded-implement or decade-doc. Both surfaces are
design-heavy (the user explicitly deferred #1926's credential half as "needs a
restart-stable account discriminator — separate work"; #1942/#1849's remaining
half is a transactional install/rollback protocol). Decision: DECADE-DOC both,
to diff-level (DIFFLEVEL-ROADMAP-01), into their owning units. No production
code in this cycle.

## Deliverable 1 — 090_transactional_update_rollback.md
into devlog/_plan/260817_windows_stability_program/ (owning unit).

Current state (verified this campaign): d09c75299 landed the restart-storm
guard (service.ts:1549-1556 exit /b 3); update/job.ts:1783-1801 does only a
PRE-flight registry integrity probe; there is no post-install verification that
package.json / bin/ocx.mjs / bundled Bun unpacked, no rollback of an empty npm
install, no recovery when launchers are gone (#1849), and the update deletes the
old install before the new one is proven (#1942 non-transactional).

Doc must specify, diff-level: stage-to-side directory layout, the post-install
verification manifest (files + how verified), the backup/restore protocol on
the shared renameAtomicFile/windows-atomic-replace foundation (#1946), the
wrapper interaction (#1945 killer + d09c75299 guard), failure-mode table
(power loss mid-swap, locked files, partial unpack), and the test plan
(fixture installs, fault injection).

## Deliverable 2 — 051_tsig_credential_scope.md
into devlog/_plan/260818_bug_pr_resolution/ (campaign unit; not a Windows doc).
Sub-doc of this 050 plan (051 convention matches the windows unit's 031/051).
Residence note for the outcome ledger: the matrix 040 row said "into the
windows program unit" for both; the tsig doc deliberately deviates (no Windows
content) — reasoned deviation, recorded.

Current state (verified): ebab9d253 landed the DESTINATION half
(thought-signature-replay.ts:88-98 keyFor v3 includes
providerDestinationDurableIdentity). Remaining gaps from #1926: (1) credential
identity absent from keyFor — account A's Gemini thought signatures replay
under account B on the same destination; (2) emit-before-commit race at ALL
SIX bridge sites (r8 audit): bridge.ts:637/:658 (streaming close), :676/:697
(failCurrentToolCall incomplete-status), :1632/:1651 (buffered
buildResponseJSON via flushToolCall). Note: persist() swallows errors
(thought-signature-replay.ts:156-169), so the design must first define what
commit failure means; closeCurrentToolCall is sync with 8+ call sites, so
emit-after-commit requires async-ifying the streaming hot path — this is why
it is decade-doc, not a bounded implement.

Doc must specify, diff-level: the restart-stable credential discriminator
design space (account email/id digest vs keychain-backed stable UUID vs
config-persisted per-account salt; constraints: non-secret, restart-stable,
rotation-safe), keyFor v4 shape + store version migration, the
emit-after-commit ordering fix for bridge.ts, invalidation on account
relink, and the test plan (cross-account isolation, restart persistence,
migration from v3 rows).

## Verifiers

- Both docs exist at the named paths, diff-level (file change maps + accept
  criteria inside), pass the LEXICO numbering rules of their units.
- PR to dev (docs-only), CI green, merged.
- Issue cross-links: comment on #1942 and #1926 pointing at the docs.

IN: two decade docs + PR + issue comments. OUT: any production code change.
