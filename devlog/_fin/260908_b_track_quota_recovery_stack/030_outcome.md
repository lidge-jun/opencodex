# 030_outcome.md — 배송 결과

## 결과
PR [#3937](https://github.com/lidge-jun/opencodex/pull/3937)이 `dev`에 머지되었다.
머지 커밋 `ca381ea764cfbc63bec978f53eb58e96c00c0c64`, 2026-09-07T18:31:27Z.

## 스택 구조 (실제)
```
dev 942c02873
 └─ 7273a0d1f  docs(devlog): plan the B-track ...        [계획]
     └─ 531753340  fix(responses): recover expired ...   [L1, author ykvv]
         └─ a06bfa2f2  fix(codex): fence late WS quota   [L2 = tip, author luvs01]
```
L1에는 PR을 열지 않았다. tip에만 PR을 열어 CI를 1회 트리거했다.

## CI 증거
- tip `a06bfa2f2`: Cross-platform CI run 1건, conclusion=success, run_attempt=1
  ([run 34149252860](https://github.com/lidge-jun/opencodex/actions/runs/34149252860)).
  잡 21/21 완료, failure 0. Linux shard 4, macOS lane 2, gates, packaging, keyring, Docker smoke 포함.
- 하위 레이어 `531753340`: workflow run **0건**. 브랜치 푸시가 CI를 만들지 않는다는 계약이 실측으로 확인됐다.
- `enforce-target`은 동시성 그룹 충돌로 1차 시도가 취소되어, 대기 중이던 중복 run을 취소하고 재실행해 success를 받았다.

## 검증 한계 (사실대로 기록)
- **로컬 제품 스위트는 한 번도 실행하지 않았다** (`bun run test`/`test:changed`/`typecheck`/`build`/`install`: NOT RUN).
  사용자 지시에 따른 것이며, hosted CI가 유일한 실행 검증자였다. 푸시는 전부 `--no-verify`.
- tip SHA에 취소된 체크 2건이 남아 있다: `enforce-target`(101832157192, 옛 시도)과 `label`(101827844691).
  같은 워크플로의 후속 시도가 success로 끝났고 failure는 0건이다. 체크 목록이 전부 깨끗하다고 말하면 사실이 아니다.
- CI가 검증한 트리(tip)와 최종 dev 트리는 동일하지 않다. 머지 직전 별도 PR #3936(문서)이 먼저 착륙해
  lifecycle 문서 5개가 차이로 남는다. `git diff --exit-code a06bfa2f2 ca381ea76 -- src tests`는 exit 0으로,
  **소스와 테스트는 CI가 본 그대로** 착륙했다.

## 감사 (astra-high 서브에이전트 4기)
1. `audit-3889`: PASS. `formatErrorResponse`의 2번째 인자는 `classifyError` 입력이며
   `previous_response_not_found` 분기가 `type=invalid_request_error`/`code=previous_response_not_found`를 만든다
   (`src/bridge.ts:2130`, `src/lib/errors.ts:179`). 문서의 1시간은 `RESPONSE_TTL_MS=3_600_000`과 일치.
2. `audit-3934`: PASS. `main-pool`에 `generation`이 없는 것은 의도된 분리이며 `mainQuotaWriter`가 별도 펜싱한다.
   `writerGeneration`(설정 재조정)과 `generation`(영속 자격증명)은 다른 개념이라 새 검사가 중복이 아니다.
   generation `0`은 엄격 동등으로 정상 처리된다.
3. `verify-stack`: PASS. 체리픽 hunk 무결성, 두 변경의 공존, import/export, 테스트 심볼, layout, privacy 6항목.
4. `verify-landing`: 7개 주장 중 6개 CONFIRMED, 1개 REFUTED(위 취소 체크 건). 이 문서가 그 반증을 반영한다.

## 원저자 크레딧
머지 커밋에 두 트레일러가 모두 살아 있다.
```
Co-authored-by: ykvv <229483879+y2ambition-ai@users.noreply.github.com>
Co-authored-by: luvs01 <luvs01@hanmail.net>
```
원본 PR #3889·#3934는 배송 완료 안내와 함께 closed(미머지)로 처리했다.

## 연결 이슈
GraphQL `closingIssuesReferences`로 확인한 결과 #3889·#3934·#3937 모두 종료 대상 이슈가 **0건**이다.
따라서 이번 머지로 닫을 이슈는 없었다. (#3885는 A트랙 #3886 소관이라 대상이 아니다.)

## 이번에 나아지지 않은 것
- 하위 레이어 L1은 자체 CI 증거 없이 tip 누적 CI로만 증명됐다. 사용자 지시에 따른 의도된 선택이며,
  레이어별 독립 회귀 증거가 필요한 변경에는 이 방식을 그대로 쓰면 안 된다.
- `enforce-target` 동시성 충돌은 재실행으로 우회했을 뿐 원인을 고치지 않았다.
  같은 SHA에 워크플로가 두 번 트리거되는 조건이 남아 있다.
