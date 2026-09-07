# 000_plan.md — B트랙 대화 복구·quota 스택 배송

## 목표
#3889(만료된 forward continuation의 WebSocket 복구)과 #3934(자격증명 세대 기반 늦은 WS quota 차단)를
원저자 기여를 보존한 수동 종속 브랜치 체인으로 재구성하고, 최종 tip 한 곳에서만 CI를 태워
green이면 tip을 dev에 통합한다.

## 제약 (사용자 지시)
- 로컬 스위트 절대 실행 금지: bun run test / test:changed / typecheck / build / install 모두 NOT RUN.
- 푸시는 `--no-verify`.
- CI는 최종 tip에만 트리거한다. 하위 레이어에는 PR을 열지 않는다.
- 원작 PR이 있으면 원저자를 Co-authored-by로 보존한다.
- tip이 dev에 머지되는 순간 연결 이슈도 닫는다.

## CI 트리거 계약 (근거)
`.github/workflows/ci.yml`의 `on.pull_request`에는 base 브랜치 필터가 없다(주석에 stacked child PR을
일부러 포함시켰다고 명시). 따라서 **PR을 여는 것 자체가 CI run을 만든다.**
`push:`는 `branches: [main, preview, dev]`로 제한되므로 포크/작업 브랜치 푸시는 CI를 만들지 않는다.
결론: 하위 레이어 L1은 **브랜치 푸시만** 하고 PR을 열지 않는다. tip L2에만 PR을 연다.

## 의존성 정렬 (PHASE-SPLIT-01)
효율이 아니라 의존 구조로 나눈다. 두 변경 모두 `src/server/responses/core.ts`를 만지므로
같은 파일 위에서 순서를 가진 체인으로 쌓는다.

- L1 = #3889 continuation 복구 (core.ts:3598 부근 오류 코드 계약)
- L2 = #3934 WS quota 세대 펜싱 (core.ts:1004 부근 observer) — L1 위에 쌓는다

텍스트 충돌은 없다(두 훅 사이 거리 약 2600줄). 체인 순서는 리뷰 단위 분리를 위한 것이다.

## 파일 변경 맵
### L1 (#3889, 원저자 ykvv / y2ambition-ai)
- MODIFY `src/server/responses/core.ts` — 400 응답 코드를 `invalid_request_error` → `previous_response_not_found`,
  메시지를 "전체 대화를 다시 보내라"로 변경. HTTP 상태와 인증 전 거부 위치는 유지.
- MODIFY `tests/codex-integration/issue-702-expired-replay-state.test.ts` — 기존 HTTP 기대값의 code 갱신 +
  expired/missing 두 모드의 WebSocket 재연결·전체 도구 이력 재전송 회귀 추가.
- MODIFY `docs-site/src/content/docs/guides/codex-integration.md`, `.../ko/guides/codex-integration.md`

### L2 (#3934, 원저자 luvs01)
- MODIFY `src/server/responses/core.ts` — `codexWsQuotaObserver`에서 pool 자격증명 generation을 포착하고
  `isCodexAccountGenerationLive`가 false면 늦게 도착한 quota 프레임을 무시.
- MODIFY `tests/responses/responses-account-label.test.ts` — 교체된 자격증명의 늦은 quota가 지워진 상태를
  되살리지 못하는 회귀 추가.

## 범위 밖 (OUT)
- `REPLAY_TTL_MS` 등 캐시 보존 기간 변경
- 인증/자격증명 회전 정책 변경
- main-pool writer 소유권 규칙 변경
- B트랙 외 항목(#3906/#3886/#3922/#3917/#3900/#3896/#3924/#3930/#3890)

## 검증자 (PLAN-VERIFIER-REAL-01)
로컬 스위트가 금지되었으므로 **로컬 검증자는 NOT RUN으로 기록한다**. 유일한 실행 검증자는
tip PR head SHA에 대한 hosted Cross-platform CI다. 관측 대상: 4 Linux shard, Windows,
macOS lane, gates(typecheck/lint/privacy scan), packaging.
- `gh api repos/lidge-jun/opencodex/actions/runs?head_sha=<tip>` → conclusion=success
- 이 CI는 `src/**`와 `tests/**`를 changes 필터에 포함하므로 실제로 이번 변경 대상을 관측한다.

## 수용 기준
1. L1/L2 커밋 각각에 원저자 Co-authored-by 트레일러가 살아 있다.
2. L1에는 PR이 없고 CI run도 없다. CI run은 tip 하나뿐이다.
3. tip head SHA의 CI conclusion이 success다.
4. 로컬 스위트 미실행, 푸시는 --no-verify.
5. tip이 dev 조상이 되고, #3889/#3934가 정리되며 연결 이슈가 닫힌다.

## 우회 경로 (PLAN-BYPASS-NAMED-01)
- tier: E2 (hosted CI 게이트)
- 실행 주체: GitHub Actions + maintainer 통합
- 알려진 우회: admin 권한 보유자는 CI 미완료 상태에서도 머지 가능. 이 계획은 그러지 않는다.
- 잔여 위험: 하위 레이어 L1은 자체 CI 없이 tip 누적 CI로만 증명된다. 사용자 지시에 따른 의도된 선택.
- 문구 하향: 없음.
