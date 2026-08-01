# 010_record — dangling tool_calls hardening 구현/검증 기록

## 구현 (B)

- 커밋: `14f8d215` (dev 브랜치) — `src/adapters/openai-chat.ts`, `tests/openai-chat-dangling-toolcalls.test.ts`.
- 설계: defer + reattach + last-resort synthesize (Sol A-gate GO-WITH-FIXES 6블로커 반영,
  상세는 `000_plan.md` A-gate amendment).
  - `pendingToolCalls: {id,name}[]` occurrence 큐(Map 금지 — 중복 id 보존).
  - `deferredBarrierMessages`: 열린 툴 라운드 동안 user/developer 메시지 보관.
  - 진짜 결과는 원래 호출 occurrence에 재부착 → 라운드 닫히면 deferred 해제.
  - 진짜 결과 없을 때만 합성 결과: `[ocx] no tool result was recorded for "<name>";
    execution status unknown — do not treat this as success, failure, or user-provided input.`
  - 빈 call id는 `call_ocx_minted_<n>` 발급(충돌 검사).
  - orphan result(매칭 호출 없음)는 기존 가짜 assistant 보정 유지, 단 열린 라운드 먼저
    합성 종료 → 중복 id 라운드 생성 안 함.

## 검증 (C) — fresh evidence

- `bun test tests/openai-chat-dangling-toolcalls.test.ts` → 9 pass / 0 fail
  (T1 사고 재현, T2 말미 dangling, T3 정상 페어 무결, T4 orphan, T5 부분 병렬, T6 미매칭,
  T7 연속 assistant, T8 빈 id, T10 문구 + T9 wire 불변식 헬퍼 전 케이스 적용).
  활성화 근거: T1/T5/T6는 defer→reattach 분기를, T2/T7은 합성 종료 분기를 실발화하고
  합성 메시지 존재/부재를 assertion으로 관찰.
- 포커스 회귀 8개 파일 123 pass / 0 fail (openai-chat 하드닝/parallel-stream/eof/
  model-suffix/adapter-usage/reasoning-effort/parallel-tool-calls-optin 포함).
- 전체 스위트 `bun run test` → 3030 pass / 0 fail (266 files, 13205 expects, 65s).
- `bun run typecheck` (tsc --noEmit) → 클린.
- SoT sync: `structure/04_transports-and-sidecars.md` Reasoning/tool-result 호환성 절에
  dangling 보정 추가.

## 터미널 결과: DONE

## 잔여 (다음 유닛 후보)

- live conformance probe: 패치된 프록시로 Kimi/OpenAI/xAI/DeepSeek 실엔드포인트에
  dangling-history 재현 요청 → 400 부재 확인 (이번엔 설치본 2.7.24가 미패치라 미수행).
- developer→system role 매핑 의미론(지시 우선순위) 검토 — 별도 계약 변경.
- 사고 스레드(019f7463, ima2-gen) 재개 시 같은 400이 사라지는지 실측.

## LOOP-PESSIMIST-01

- 개선되지 않은 것: 업스트림이 에러에 `request_user_input:353` 형태의 id를 보고한 경로는
  미규명(앱/게이트웨이 합성 id 추정). wire 불변식은 보장되지만, 게이트웨이가 id를 재작성하는
  경우 다른 검증 실패가 남을 수 있음.
- 죽은 가설: "eager flush로 충분하다" — Sol 리뷰에서 진짜 결과 날조 문제로 폐기, defer +
  reattach로 교체.
- 방향이 틀렸다는 증거가 되려면: 패치 후에도 동일 400 재발(그때는 id 재작성 경로 추적으로
  전환).
