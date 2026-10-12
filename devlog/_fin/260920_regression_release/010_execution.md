# 2.60.0 regression and release execution

Status: IN PROGRESS. This file records what was actually executed, with exact commits, runs and
dispositions. It is not a completion claim beyond the evidence listed here.

## Candidate freeze

| Branch | Before | After |
| --- | --- | --- |
| dev | `12cb129d424d1a67319c1e7a761ba5474fdc48a4` | `1b57a572182d9f6f76cb6169eec7b65495be5910` (2.61.0) |
| main | `134c92a01b120162f00c7275189cc47858720379` (2.59.0) | `7c625fc9755c9824653ab944190e243091a2c85c` (2.60.0) |
| preview | `48e1ddba0bb8da9ad39e32f8e20c1e4d7f1794da` (2.58.0) | `84c4f014c8da51ff50c3e8b64f2d82b9ee3792da` (2.60.0) |

The released tree is `015c67c46aaf16d4319543c8941c6dbec9887ae6`, the `dev` head after the last
blocking repair and before the version pre-move.

## Dev-tip regression failure and repair

Run `35485314835` at `12cb129d42` failed on Linux `test 2/4` and macOS `macos 2/2` with the same
single case, `sanitizeEncryptedContentInPlace > plaintext parked in encrypted slots becomes
input_text; real blobs survive`, reporting `Expected: 2, Received: 3` at
`tests/codex-integration/multi-agent-compat.test.ts:1392`. Every other producer and both keyring
and docker legs passed, so the aggregate `ci` check failed on that one assertion.

This is the merge-union class `AGENTS.md` describes. #5239 replaced `looksLikeBackendCiphertext`
with `isStructurallyValidFernetToken`, which requires canonical base64url, length at least 100, a
`0x80` version byte and a 16-byte-aligned ciphertext. The case predates that change and minted its
surviving blob as `"gAAAAAB".padEnd(120, "Qw1_-=")`, which embeds `=` mid-token and is therefore no
longer a valid token, so the sanitizer correctly lowered it as a third rewrite. #5239's own tests
were updated; this one in another domain directory was not.

#5246 mints the blob with the `fernetFixture()` helper already defined in the same `describe` —
a 73-byte payload with `raw[0] = 0x80` encoding to a 100-character canonical token, giving
`decoded.length - 57 === 16`. The classifier is untouched, the rewrite count returns to 2 and the
surviving slot stays byte-identical. Merged to `dev` as `015c67c46aaf16d4319543c8941c6dbec9887ae6`.

## Integration sequence

1. #5242 archived the campaign unit to `_fin`; merged as `d3d637912ab5080e0d54ef60db273951746d0aa9`.
2. #5246 repaired the fixture; merged as `015c67c46aaf16d4319543c8941c6dbec9887ae6`.
3. `release/2.60.0` was cut at that head, before any version move.
4. `dev-version-bump.yml` was dispatched with `intended-version=2.60.0`. The first dispatch from
   `dev` was refused by the workflow's default-ref guard; the dispatch from `main`
   (`35486732967`) opened #5247, merged as `1b57a572182d9f6f76cb6169eec7b65495be5910`, so `dev`
   outranks the release at 2.61.0.
5. #5249 promoted `release/2.60.0` to `main` as merge commit `7c625fc9755c9824653ab944190e243091a2c85c`.
6. #5250 brought `preview` onto the same tree as `84c4f014c8da51ff50c3e8b64f2d82b9ee3792da`;
   `git diff` against `main` was empty before the merge and after it.

The maintainer directed admin integration without waiting for per-pull-request CI on the repair and
promotion pull requests. That timing direction is recorded here rather than presented as a
completed per-PR pass.

## Publication gates and full regression evidence

`release.yml` refuses to publish without a successful push-event `ci.yml` run for the exact release
commit; a pull-request run does not qualify. The first dispatch (`35486936693`) failed on that gate
while the `main` push run was still queued. `service-lifecycle.yml` was already satisfied for the
same commit by run `35486928648`.

The full regression from the request-time `main` baseline through the released candidate is push
run `35486928618` at `7c625fc9755c9824653ab944190e243091a2c85c`, conclusion SUCCESS. Every
event-requested producer passed: `changes`, all four Linux `test` shards, both macOS shards,
`storage policy`, `api usage`, `gates`, `structure gate`, `docker smoke`, `docs site build`, all
three `keyring` legs and all three `npm-global` legs. The nine-shard Windows matrix and
`macos control` are workflow-dispatch lanes that this event does not request, so their skipped
placeholders are applicability, not execution.

## Publication

Release run `35488151017` at the same commit completed SUCCESS with every step green, including
`Require successful Cross-platform CI for this commit`, `Require dev to be ready for this release`,
`Refuse a release the current tag set already outranks` and `Publish (or dry-run)` with
`dry-run=false`.

npm accepted `+ @bitkyc08/opencodex@2.60.0` on dist-tag `latest` with public access and a signed
provenance statement recorded in the sigstore transparency log at index `2894025266`. Tarball
`bitkyc08-opencodex-2.60.0.tgz`, shasum `651613e7536c33be936ac387a0a9f38ff290c4cc`, 1436 files.

Tag `v2.60.0` points at `7c625fc9755c9824653ab944190e243091a2c85c` and the GitHub release was
published at 2026-09-20T04:05:15Z, not a draft and not a prerelease.

Registry propagation was still pending at the time of writing: npm reported "Your package is being
processed and may take a few minutes to become available", the workflow's bounded six-attempt smoke
ended `verification=pending`, and direct reads of
`https://registry.npmjs.org/@bitkyc08%2fopencodex` still showed `latest` at 2.59.0 about fifteen
minutes after publication. The publish itself is acknowledged and must not be republished; the
remaining check is a later registry read confirming `2.60.0` under `latest`.

Local suites, typecheck, builds, installs and runtime execution were not run in this lane.
