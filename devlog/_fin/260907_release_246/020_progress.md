# Release progress

Frozen candidate 0d8b0cd1 passed all 26 jobs in CI 34079952328. Local typecheck, privacy and 21,112 tests passed (16 skipped, zero failures). Twenty merged delivery PRs had zero unresolved threads.

Dev pre-move #3850 merged as 6cf38b59 (2.47.0); PR CI/lifecycle succeeded and post-merge CI 34081097509 succeeded. Main #3851 merged as bba63222; exact tree equals candidate, lifecycle 34081245230 and docs deployment 34081245209 succeeded, push CI 34081245213 pending.

Preview #3852 head 6ccfe7ed differs only in package version. Attempt 1 CI 34080243039 macos 2/2 stopped after client-connect transaction fixture and hit the 20-minute job bound; runner log retained in .tmp/release-246/preview-macos-attempt1.log. File and src/cli/connect.ts unchanged versus v2.45.0; all seven transaction cases passed in the same-candidate local suite. Only unsuccessful jobs rerun once unchanged, attempt 2. Root cause not established and no limits/assertions changed.

A new P2 promotion review noted legacy mixed sig/red streaming versus JSON ordering inconsistency. Independent re-review confirmed it is introduced in newly supported legacy preservation, not a regression of functioning v2.45 replay; current bridge produces separate items. Existing axis-three scope explicitly deferred this shape. Accepted limitation tracked under open #3719; disposition https://github.com/lidge-jun/opencodex/pull/3852#discussion_r3946450143. Thread resolution represents explicit deferral, not a fix. No universal reasoning-replay claim.
