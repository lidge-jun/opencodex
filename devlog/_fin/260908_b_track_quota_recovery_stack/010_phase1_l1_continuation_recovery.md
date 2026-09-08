# 010_phase1_l1_continuation_recovery.md — L1 (#3889) 브랜치 구성

## 목적
만료·부재한 forward continuation 상태를 Codex WebSocket 클라이언트가 스스로 복구할 수 있게,
프록시가 돌려주는 400 오류의 코드를 클라이언트가 인식하는 `previous_response_not_found`로 바꾼다.

## 브랜치
`codex/b-stack-l1-continuation-recovery`, base = `origin/dev`.

## 커밋 계약
원저자 보존이 필수다. 체리픽으로 원 커밋의 author를 그대로 유지한다.

```
git cherry-pick -x e8d82a181ea0daa06c5111c09e0148475e45458f
```

체리픽은 원 커밋의 author(ykvv <229483879+y2ambition-ai@users.noreply.github.com>)를 보존한다.
squash 병합 시 author가 소실될 수 있으므로 커밋 메시지에 트레일러도 추가한다:

```
Co-authored-by: ykvv <229483879+y2ambition-ai@users.noreply.github.com>
```

## 정확한 변경 (before → after)
`src/server/responses/core.ts` 약 3598행:

```diff
   if (
     hasUnexpandedPreviousResponse
     && isCanonicalOpenAiForwardProvider(route.provider)
   ) {
     return formatErrorResponse(
       400,
-      "invalid_request_error",
-      "OpenAI forward continuation state is unavailable or expired; start a new session instead of reusing this previous_response_id.",
+      "previous_response_not_found",
+      "OpenAI forward continuation state is unavailable or expired; resend the full conversation without previous_response_id.",
     );
   }
```

가드 위치(인증·어댑터·upstream I/O 이전)는 바뀌지 않는다. HTTP 상태 400도 유지한다.

테스트: `tests/codex-integration/issue-702-expired-replay-state.test.ts`
- 기존 HTTP 케이스: `code`를 `previous_response_not_found`로 갱신, `type`은 `invalid_request_error` 유지.
- 신규: expired/missing 두 모드로 WebSocket 연결 → 거부 확인 → upstream 요청 0건 확인 →
  재연결 후 전체 이력 재전송 → upstream 1건 + `previous_response_id` 없음 + 도구 호출/결과 쌍 보존.

문서: `docs-site/src/content/docs/guides/codex-integration.md` 및 한국어 페이지에 복구 경계 문단 추가.

## 검증
로컬 스위트 NOT RUN(사용자 금지). 이 레이어는 PR을 열지 않으므로 자체 CI도 없다.
증명은 L2 tip의 누적 CI가 담당한다.

## 감사 반영
서브에이전트 audit-3889의 결과에 따라 문서의 TTL 수치와 error type/code 매핑을 확정한다.
