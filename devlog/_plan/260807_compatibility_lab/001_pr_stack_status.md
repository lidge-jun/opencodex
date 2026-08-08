# Compatibility Lab PR stack status

Updated throughout the programme. Every phase records its branch, exact base
and implementation head, PR, verification, independent review, blockers, and
whether the next phase is authorized.

## Programme facts

- Repository: `lidge-jun/opencodex`
- Integration target: `dev`
- CL-00 starting `upstream/dev`:
  `3ad5bb6bd3f76f6879d84b78ea39edd3e01ec296`
- Package/runtime at start: OpenCodex `2.10.2`, Bun `1.3.14`
- CL-00 branch: `feat/cl-00-compatibility-contracts`
- CL-00 scope: documentation/contracts/incident corpus only
- PR target: `lidge-jun/opencodex:dev`

## Stack

| Phase | Branch | Base SHA | Implementation head | PR | State |
|---|---|---|---|---|---|
| CL-00 | `feat/cl-00-compatibility-contracts` | `3ad5bb6bd3f76f6879d84b78ea39edd3e01ec296` | `e2ea3312f83e00c0ce4c2120aaa2f86d7df2b6e4` | [draft #1286](https://github.com/lidge-jun/opencodex/pull/1286) | ACCEPTED |
| CL-01 | not created | CL-00 must be accepted first | not started | none | NOT AUTHORIZED |

## CL-00 acceptance log

- Live-tree audit: complete against the exact base above. Audited provider
  registry/derivation, Routing Profile types/normalization/evaluator/API/UI/
  dry-run, route traces and Why-this-route, usage/request-history/analytics,
  doctor/provider connectivity validation, protocol regression tests, and
  relevant open/closed devlog incidents.
- Live-tree correction: generated Cursor task/grind protobuf messages exist,
  but no native Agent Fabric task persistence or management contract and no
  Compatibility Lab implementation exists. CL-00 freezes consumer semantics
  without claiming production endpoints. Future compatibility policy must
  extend the shipped Routing Profiles system.
- Documents:
  - `000_master_plan.md`
  - `010_architecture_and_evidence_contract.md`
  - `020_scenario_contract_and_catalogue.md`
  - `021_protocol_v1_manifest_authority.md`
  - `022_protocol_v1_cases.json`
  - `030_incident_corpus.md`
  - `040_security_and_privacy.md`
  - `050_cl00_acceptance_review.md` (recorded after independent review)
- Baseline verification on clean CL-00 worktree:
  - `bun x tsc --noEmit`: passed, 0 errors.
  - `bun run privacy:scan`: passed.
  - `bun run test`: **not green** on this Windows/Bun 1.3.14 host. The full
    run exited 3 after a cache-invalidation failure, an empty Windows
    effective-account lookup, and a Bun
    `panic(main thread): index out of bounds: index 0, len 0`.
  - Serial isolation:
    `tests/codex-models-cache-invalidate.test.ts` passed 6/6;
    `tests/codex-native-residue.test.ts` passed 63 with 2 platform skips.
  - Focused protocol/compatibility suite excluding privileged-symlink state
    cases: 395 passed, 0 failed across 24 files.
  - Focused continuation state semantics: 2 passed, 95 filtered, 0 failed.
  - A broader focused run including all `responses-state.test.ts` cases had
    488 pass and 4 fail; all four failures were Windows `EPERM` creating
    symlinks on this host.
  - `tests/repo-hygiene.test.ts`: 11 passed, 0 failed.
- Documentation verification: complete. JSON authority parses; all 35 cases,
  46 fixture records, eight suites and fixture digests validate; all local
  CL-00 links resolve; `git diff --check` passed.
- Independent acceptance review: accepted after correction; all ten required
  challenges pass and no Critical/High/Medium findings remain.
- Blockers: none for CL-00. Full-suite green remains unavailable on this host
  for the Windows/Bun reasons above.
- CL-00 ending implementation SHA:
  `e2ea3312f83e00c0ce4c2120aaa2f86d7df2b6e4`.
- Draft PR: [#1286](https://github.com/lidge-jun/opencodex/pull/1286).
- CL-01 authorized: **NO**. Acceptance of CL-00 does not start CL-01.
