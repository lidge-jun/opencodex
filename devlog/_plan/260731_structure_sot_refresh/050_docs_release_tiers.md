# 050 — WP5: `06_docs-and-release.md` + `07_design-methodology.md` + `08_openai-provider-tiers.md`

선행: WP0만. A 감사 블로커 14에 따라 WP4 선행 주장을 철회했다 — 이 phase는 API 명칭을
실질적으로 소비하지 않는다.

## 편집 대상

- MODIFY `structure/06_docs-and-release.md`
- MODIFY `structure/07_design-methodology.md`
- MODIFY `structure/08_openai-provider-tiers.md`

## D1. `06` 로케일 (S5)

BEFORE (`:5-6`)
```
The public documentation site lives in `docs-site/` and is built with Astro + Starlight. English is
served at the site root, Korean under `/ko`, and Simplified Chinese under `/zh-cn`.
```
AFTER
```
The public documentation site lives in `docs-site/` and is built with Astro + Starlight. English is
served at the site root, with Korean under `/ko`, Simplified Chinese under `/zh-cn`, Russian under
`/ru`, and Japanese under `/ja`. `docs-site/astro.config.mjs` is the locale SOT.
```
근거: `docs-site/astro.config.mjs:63-68`.

## D2. `06` 워크플로 지도 (S6, S7, I9, §F)

`ci.yml` 행 트리거 정정 — PR은 `main, dev`, push는 `main, preview, dev`
(`.github/workflows/ci.yml:4-5,21-22`). 게이트 목록에 GUI 테스트 추가(`:88`).
`service-lifecycle.yml`은 3플랫폼(`:37,159,239`).

```
| `.github/workflows/ci.yml` | `pull_request` to `main`/`dev`, `push` to `main`/`preview`/`dev`, or manual dispatch when runtime/package paths change | Cross-platform runtime/package quality gate on Linux, Windows, and macOS. The `test` job (Bun) runs typecheck, `bun test --isolate tests`, the GUI suite (`cd gui && bun test tests`), the privacy scan, release-helper syntax check, GUI lint/build, and `ocx help`; `npm-global-smoke` (Node only, **no setup-bun**) builds package assets, packs the tarball, installs it globally, and runs `ocx help` to prove the bundled-Bun launcher works without a separate Bun install. |
| `.github/workflows/service-lifecycle.yml` | `pull_request` to `main`/`dev` and `push`, both filtered on the service path set (`src/service.ts`, `src/cli.ts`, `src/cli/index.ts`, `src/lib/bun-runtime.ts`, `package.json`, `bun.lock`, the workflow), or manual dispatch | Service-lifecycle smoke on three platforms: Linux systemd, macOS launchd, and Windows Scheduled Tasks. Each installs, verifies, stops via `ocx stop`, and uninstalls. The path list is kept in sync with the release.yml service-gate regex. |
```

표에 미기재 워크플로 7개 추가. 트리거는 각 파일에서 그대로 옮긴다(A 감사 블로커 7):
```
| `.github/workflows/enforce-pr-target.yml` | `pull_request_target` (opened, reopened, edited, ready_for_review, synchronize) | The `enforce-target` gate: rejects pull requests whose head ancestry sits on the `main` tip while far behind `dev`, and rejects empty or malformed descriptions. Stacked child PRs targeting another open PR's head skip the wrong-base gate. |
| `.github/workflows/enforce-issue-quality.yml` | `issues` (opened, edited, reopened), `issue_comment` (created, edited), manual dispatch with an issue number | Issue-template compliance gate. |
| `.github/workflows/issue-quality-tests.yml` | `pull_request` and `push` filtered on the issue/PR automation scripts and their workflows | Tests the issue/PR automation scripts themselves, so the gates cannot rot silently. |
| `.github/workflows/issue-triage.yml` | `issues` (opened) | Duplicate detection and triage labeling for new issues. |
| `.github/workflows/pr-labeler.yml` | `pull_request_target` (opened, edited, synchronize, labeled, unlabeled) | Type/path labeling and title sync; `labeled`/`unlabeled` let a human override enqueue a fresher run in the per-PR concurrency group. |
| `.github/workflows/react-doctor.yml` | `pull_request` (opened, synchronize, reopened, ready_for_review) and `push` to `main`; no path filter | React-focused static review. Findings fail the job; write-scoped outputs stay disabled, a contract pinned by `tests/ci-workflows.test.ts`. |
| `.github/workflows/stale-needs-info.yml` | `schedule` only (daily 06:15 UTC); deliberately no manual dispatch | Closes issues left in needs-info past the grace period. Manual dispatch is omitted so a branch-selected run cannot execute that branch's body with issue write scope. |
```

표 뒤에 한 문단 추가. 브랜치 정책과 얽힌 실제 함정이다:
```
`pull_request_target`, `issues`, and `schedule` workflows always load from the repository default
branch, not from `dev`. Landing a change to one of them on `dev` does not change live behavior until
it is promoted, so those files follow the promotion model rather than ordinary integration.
```

마지막 문단의 "Service-related changes … on Linux"를 "on all three platforms"로 정정.

## D3. `06` 브랜치·devlog 정책 절 신설 (§F)

`structure/`는 저장소 구조의 SOT인데 브랜치 정책과 devlog 배치 정책이 없다.
`AGENTS.md`가 정책 원본이므로 여기서는 요약하고 원본을 지목한다(중복 SOT를 만들지 않는다).

`## Maintenance governance` 앞에 삽입. `AGENTS.md:47`의 "Nothing in the build, typecheck, or test
path reads from `devlog/`"는 거짓이므로 그 문구를 복사하지 않는다: `tests/repo-hygiene.test.ts:96-100,161-178`,
`scripts/privacy-scan.ts`, `scripts/openai-provider-option-runtime-smoke.ts:43`,
`scripts/openai-provider-option-final-gates.ts:114`가 devlog를 읽는다. 서술 계약 2항에 따라
"정확히 두 개가 읽는다"고 쓰지 않고 표준 게이트를 이름으로 지목한다.
`AGENTS.md` 자체의 정정은 이 유닛 범위 밖이며 후속으로 기록한다.
```
## Branch and devlog policy

[`AGENTS.md`](../AGENTS.md) and [`MAINTAINERS.md`](../MAINTAINERS.md) are authoritative; this
section exists so the repository-shape SOT does not omit the shape of its own history.

- `dev` is the single integration branch and the target for ordinary pull requests. `main` moves only
  by maintainer-controlled promotion; `preview` carries the `x.y.z-preview.*` train. One documented
  exception: a stacked child PR may target another **open** PR's head branch as a review workflow,
  and is retargeted to `dev` once the parent lands or closes.
- Bun-native TypeScript on `dev` is the only runtime line. The Go native-runtime experiment is
  retired; `go/` survives only where the TypeScript runtime still references it, and new work does
  not go there.
- `devlog/` is a tracked directory in this repository — no submodule, no private mirror. Open units
  live in `devlog/_plan/`, closed units in `devlog/_fin/`, external parity references in
  `devlog/_chase/` (reference clones themselves are gitignored).
- The runtime does not consume `devlog/`, so a contributor who ignores it still builds and runs.
  Repository checks do read it deliberately: `privacy:scan` scans it, and
  `tests/repo-hygiene.test.ts` enforces the mechanical guards — no tracked `160000` gitlink anywhere,
  devlog Markdown tracked as ordinary blobs, no `.gitmodules`, and no open plan carrying an
  unresolved security verdict on a security-boundary topic. Some unit-scoped release gate scripts
  resolve their evidence directory from `devlog/_plan` or `_fin` as well.
- Security work in progress does not go in any tracked directory. Scratch space only; only the
  published outcome (fix, regression test, release note, public advisory) reaches the repository.
```

## D4. `07` 죽은 참조 (S8)

`pabcd_initiative/skills/dev-pabcd/references/catalog-discovery.yaml`는 이 저장소에 없다.
외부 스킬 저장소 경로를 SOT 문서에 박아 두면 확인 불가능한 주장이 된다.

A 감사 블로커 13: 외부 방법론을 "정전 출처"로 지목하는 것도 검증 불가한 주장이다. 출처 주장 자체를
없애고, 이 저장소에서 확인 가능한 규율만 남긴다.

`:13-15` 교체:
```
This is a design-first rule for contributors, not a runtime feature: opencodex is infrastructure
plumbing, not a product-creation tool, so surface coherence is enforced by review rather than by an
interview engine. The rule stands on its own; it does not depend on an external document.
```

`## Reference` 목록의 첫 항목(정전 출처 줄)은 삭제한다. 남는 항목은 저장소 안에서 확인 가능한
설계 방법론 요약과 6개 디자인 다이얼이며, 그 둘은 이 문서가 스스로 정의한다.

## D5. `07` 표면 목록 (§MISSING)

`:19-26` 목록이 실제 13개 페이지 중 일부만 담는다. 전부 열거하면 `05`와 중복되고 낡는다.
범위를 명시하는 방향으로 고친다:
```
The surfaces below are examples chosen to show the design direction, not an inventory; the current
surface list lives in `gui/src/app-routing.ts` and [`05_gui-and-management-api.md`](05_gui-and-management-api.md).
```

## D6. `08` 백업 충돌 규칙 (S4)

`src/config.ts:274-282`의 `classifyOpenAiTierBackup`은 `openaiProviderTierVersion === 2`면 `stale`,
파싱 실패도 `stale`, 유효한 v1이면 `rollback`. `:307-322`는 다른 `stale` 백업을 경고 후 교체하고
`rollback`일 때만 `OpenAiTierBackupCollisionError`를 던진다.

BEFORE (`:58-60`)
```
The historical v1 backup is never overwritten. Restoring the v2 backup intentionally restores the
shipped v1 shape; the next startup re-migrates to the same marker-2 bytes. A differing pre-existing
v2 backup blocks migration before save.
```
AFTER
```
The historical v1 backup is never overwritten. Restoring the v2 backup intentionally restores the
shipped v1 shape; the next startup re-migrates to the same marker-2 bytes.

A pre-existing snapshot that differs from the current config is classified before anything is
written (`src/config.ts` `classifyOpenAiTierBackup`): a snapshot that parses as a valid
pre-migration (v1) config is a user-intentional rollback point and blocks migration; a snapshot
that is unparseable or already tier-v2 is stale and is replaced with a warning. The distinction
matters because silently discarding a rollback point is destructive, while preserving a stale one
would block every later migration.
```

## D7. `08` 계정 네임스페이스·저장소 절 (§MISSING)

`## Sidecars, management, and UI` 앞에 추가. 용어는 WP2의 D6과 동일하게 쓴다(A 감사 블로커 5):
```
## Account identity and store concurrency

Pool mode needs stable public names and a store that survives concurrent refresh:

- Public selectors are generated per account; the main login's selector is `main`, collision-suffixed
  if that name is taken, and it maps to the config-only sentinel `@main`, which sits outside the
  pool-account id grammar (`src/codex/account-namespaces.ts`, `src/codex/account-namespace-match.ts`).
  Selectors must not collide with provider or combo ids. A user alias is display metadata; routing
  consults credential identity, never the alias.
- The credential store is generation-guarded and refresh-locked (`src/codex/account-store.ts`): a
  refresh persists only if the generation it started from still holds, and a lost race raises a
  generation-conflict error instead of overwriting the newer credential.
```

## 검증

```bash
ls .github/workflows
rg -n "branches:" -A3 .github/workflows/ci.yml | head -20
rg -n "^  [a-z-]+:" .github/workflows/service-lifecycle.yml
rg -n "locales" -A8 docs-site/astro.config.mjs | head -20
rg -n "classifyOpenAiTierBackup|OpenAiTierBackupCollisionError" src/config.ts
ls devlog/_plan devlog/_fin devlog/_chase >/dev/null && echo devlog-dirs-ok
rg -l "devlog/_plan|devlog/_fin" scripts/ tests/repo-hygiene.test.ts
bun x tsc --noEmit && bun test tests/repo-hygiene.test.ts && bun run privacy:scan && git diff --check
```

## 수용 기준

- 워크플로 표가 실제 11개 워크플로를 담고 트리거가 파일과 일치한다.
- 로케일 5종.
- 브랜치·devlog·보안 정책 절이 존재하고 `AGENTS.md`를 원본으로 지목한다.
- `07`에 존재하지 않는 파일 경로 주장이 없다.
- `08` 백업 충돌 규칙이 v1 rollback 기준으로 서술된다.
- 게이트 통과, 커밋 1개.

## 서술 계약 자기점검

살아남은 절대어·범위 주장 전부와 그 근거(A 감사 R4 블로커 4). 정책 절의 절대어는 대부분
`AGENTS.md`를 요약한 것이므로 근거는 정책 원본이다:

| 문안 | 근거 |
|------|------|
| `always load from the repository default branch` | `.github/workflows/enforce-issue-quality.yml:3-6`, `pr-labeler.yml:3-7`, `stale-needs-info.yml:3-6`의 주석 + GitHub Actions 이벤트 문서 |
| `The historical v1 backup is never overwritten` | 기존 문서 문장. `src/config.ts:307-322` — v1 rollback은 교체하지 않고 충돌 에러를 던진다 |
| `dev` is the single integration branch / ordinary PRs target it | `AGENTS.md:115-122` |
| `main` moves only by maintainer-controlled promotion | `AGENTS.md:115-122` |
| `Bun-native TypeScript on dev is the only runtime line`, Go 은퇴 | `AGENTS.md:73-87` |
| `no submodule, no private mirror` (devlog) | `AGENTS.md:33-42` + `tests/repo-hygiene.test.ts`의 gitlink/`.gitmodules` 가드 |
| `The runtime does not consume devlog/` | 런타임 소스가 `devlog/`를 읽지 않는다. 읽는 주체는 이름으로 열거했고 개수 주장은 하지 않는다 |
| `stale-needs-info`의 `deliberately no manual dispatch` | `.github/workflows/stale-needs-info.yml:11-14` 주석이 이유까지 기록한다 |

- 트리거: 11개 워크플로의 `on:` 블록을 파일에서 그대로 옮겼다.
- 경로: 완전 경로만 사용.
