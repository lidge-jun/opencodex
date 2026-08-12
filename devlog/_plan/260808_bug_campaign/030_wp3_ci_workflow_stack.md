# 030 — WP3: CI 워크플로 (#1259, #1185)

선행: WP1. 절차: `003_republish_protocol.md`.

## 스택이 해체된 경위

초안은 `#1255 → #1259 → #1185` 3단 스택이었다. **#1255가 2026-08-08T05:54:05Z에
`d55b903d8` 로 머지되어 현재 `origin/dev` 그 자체가 되었다.** 스택 루트가
dev에 흡수됐으므로 남은 둘은 각각 `origin/dev` 에서 분기하는 독립 PR이다.

두 PR은 서로 훅을 공유하지 않는다(#1259는 `enforce-pr-target.yml` 의 CI-claim
검사와 하네스, #1185는 `tests/ci-workflows.test.ts` 의 어서션). 따라서 스택으로
묶을 이유가 없다.

다만 #1259는 여전히 하네스의 페이지네이션 로직을 건드리는데, #1255가 이미 그
영역을 바꿔놓았다. 리베이스 시 **양쪽 메커니즘을 모두 보존**해야 한다 — 이제는
자동 리베이스가 아니라 착지한 dev 코드와의 수동 합성이다.

## 착수 전 차단 조건: #1265 상태 확인 (필수)

#1259를 건드리기 전에 반드시 확인한다.

```bash
gh pr view 1265 --repo lidge-jun/opencodex --json state,baseRefName,mergedAt,mergeCommit,labels
git fetch origin main dev
git log --oneline origin/main -5
```

확인 항목:

1. #1265의 상태와 타겟 (`main` 대상 핫픽스)
2. 그 내용이 `main` 에 착지했는지, 그리고 `dev` 와의 ancestry 관계
3. 보안 검토가 완료됐는지 (워크플로 표면이므로 필수)

#1265는 #1255와 같은 워크플로 파일을 건드린다. 이미 `main` 에 올라간 내용을
`dev` 쪽에서 다시 만들면 승격 시 충돌한다. 이 확인 없이 #1259를 진행하지 않는다.

## 보안 경계 (최우선)

`.github/workflows/` 와 `enforce-pr-target` 은 AGENTS.md가 명시한 보안 검토 필수
표면이다. 이 phase 전체가 security-sensitive다.

검토 항목: 워크플로 권한 상승, 변경 가능한 서드파티 액션 ref, 시크릿 노출,
토큰 로깅. 셋 중 하나라도 걸리면 릴리스 블로커로 취급한다.

## 030-1 · #1255 — 조치 없음 (머지 완료)

`b73f6a42` 가 `d55b903d8` 로 dev에 착지했다. 재발행하지 않는다.

착지한 내용: 코멘트 기반 워크플로 깨우기를 신뢰된 `status` 기반으로 교체
(`.github/workflows/enforce-issue-quality.yml`, `enforce-pr-target.yml`,
`tests/helpers/enforce-pr-target-harness.ts` 등).

**후속 확인 항목:** 이 변경에 두 방향 활성화 증거가 있는지 착지본에서 확인한다.
음성(임의 `issue_comment` 가 디스패치하지 않음)과 양성(신뢰된 `status` 는
디스패치함) 양쪽이 있어야 "막았다" 와 "다 막아버렸다" 를 구분할 수 있다. 없으면
#1185 PR에 회귀 테스트로 함께 추가한다.

## 030-2 · #1259 페이지네이션 증거 (재작업)

원작자 `luvs01 <luvs01@hanmail.net>`
원본 브랜치 `luvs01:agent/fix-ci-readiness-evidence`
원본 커밋 `a0810bc3`
새 브랜치 `codex/260808-ci-readiness-pagination` (base: `origin/dev`)

### hygiene 실패의 진짜 원인

실패 로그:

```
##[error] PR hygiene failed: unsponsored_surface
```

테스트나 페이지네이션 문제가 아니다. `.github/workflows/enforce-pr-target.yml` 이라는
**보호된 표면**을 건드려서, maintainer 보안 검토와 `maintainer-sponsored` 라벨이
필요하다는 게이트의 정상 동작이다.

처리: 코드를 고치는 게 아니라 보안 검토를 수행하고 라벨을 부여한다. 라벨 부여는
maintainer 권한 행위이므로 이 캠페인 범위 안에 있다.

### 코드 변경

MODIFY `.github/workflows/enforce-pr-target.yml`

현재 `:647-666` 이 한 페이지만 읽는다:

```js
checks.listForRef(... per_page: 100)   // 한 번만
  .find(...)
```

체크가 100개를 넘으면 `ci` 체크가 두 번째 페이지에 있을 수 있고, 그러면 green인데도
찾지 못해 준비완료 주장이 기각된다.

변경: 전체 페이지를 순회한다.

MODIFY `tests/helpers/enforce-pr-target-harness.ts` — **착지한 #1255 코드와 수동
합성 필요.** #1255가 이미 dev에서 페이지네이션 픽스처/카운트 동작을 바꿔놓았다.
자동 리베이스에 맡기지 않고 양쪽 메커니즘을 모두 보존하도록 직접 합친다.

MODIFY `tests/ci-workflows.test.ts` — 2페이지 커버리지.

활성화 증거: 체크가 100개를 넘는 픽스처로 두 번째 페이지 순회 분기가 실제로
발화하는지 확인. 100개 이하만 테스트하면 이 분기는 죽은 채로 남는다.

## 030-3 · #1185 Windows shard 어서션 (독립)

원작자 `luvs01 <luvs01@hanmail.net>`
원본 브랜치 `luvs01:agent/test-windows-ci-shard-command`
원본 커밋 `bff31d1e`
새 브랜치 `codex/260808-windows-shard-assertion` (base: `origin/dev`)

MODIFY `tests/ci-workflows.test.ts`

현재 `:166-169` 가 부분문자열 매칭을 쓴다. 워크플로 안의 `echo` 나 주석이 어서션을
만족시켜, 실제로는 shard 명령이 없어도 테스트가 통과한다.

변경: 정확한 실행 라인 어서션으로 교체.

부모가 낡았으므로(`6d04574d`) 리베이스 필요. #1259와 훅을 공유하지 않아 깨끗하게
적용되며, 스택이 아니라 독립 PR이다.

활성화 증거: 워크플로에서 실제 shard 명령을 주석 처리한 상태로 테스트를 돌려
red가 되는지 확인한다. 이게 이 변경의 존재 이유이므로 반드시 보여야 한다.

## WP3 수용 기준

- **선행:** #1265 상태·타겟·ancestry·보안검토 확인 완료
- #1255는 조치 없음 (머지 확인만)
- #1259와 #1185 두 PR이 각각 `origin/dev` 기반 독립 PR로 열림
- #1259에 보안 검토 완료 및 `maintainer-sponsored` 부여 (없으면 hygiene이
  `unsponsored_surface` 로 계속 실패한다)
- #1259의 하네스 훅이 착지한 #1255 코드와 수동 합성되어 양쪽 메커니즘 보존
- `bun install` 후 `bun test tests/ci-workflows.test.ts` green
- 워크플로 권한/시크릿/액션 ref 검토 기록
- 030-2, 030-3의 활성화 증거 확보
