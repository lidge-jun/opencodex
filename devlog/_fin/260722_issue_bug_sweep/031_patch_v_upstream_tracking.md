# 031 — 처분 문서 V: #92 no-functional-patch / upstream-tracking 결론 (+선택적 fail-fast UX)

- 소스 RCA: `007_rca_v_v2_encrypted_newtask.md` (리뷰어 검증 완료)
- 성격: **의도된 no-patch 결론 문서** — 000 로드맵의 "031은 007 판정에 따라 diff 또는 명시적
  no-patch 결론 문서로 성립한다"(cr3) 조항의 후자.

## 판정 요약

- 책임: **upstream** (openai/codex). Responses 백엔드가 V2 태스크를 암호화하고 Codex가
  평문을 보존하지 않아(`InterAgentCommunication.content = String::new()`), 프록시가 요청을
  보는 시점에 유일한 평문 사본이 이미 소멸.
- 기능적 로컬 완화 diff: **없음.** 복호기 추가·Fernet→텍스트 재작성·ciphertext 전역 제거는
  native Responses replay를 파괴하면서도 태스크를 복구하지 못하므로 금지.
- 기존 로컬 방어는 충분·정확: 평문/혼합 슬롯 복구(`responses.ts:300,313,350,373`),
  순수 Fernet byte-identical 보존(`:363`), 테스트(`multi-agent-compat.test.ts:364,391,405`).
- V1 안내는 이미 문서화(README.md:232).

## 추적 계약

- 추적 대상: **openai/codex#33551** (2026-07-22 기준 open·미배정 — provider-aware 평문 전송 요청).
  #32453은 무관(429 compaction) — 이슈 #92 코멘트의 링크는 정정 필요 시 코멘트로만(외부 상태 변경은 사용자 승인 후).
- 재시험 트리거: upstream이 (a) 평문 보존, (b) provider-aware 전달, (c) 복호화 위임 중 하나를
  릴리즈하면 `tests/multi-agent-compat.test.ts` 기준으로 순수 Fernet 경로 재평가.
- 로컬 재현 상태: end-to-end 재현 캡처는 unverified(007 명시) — 코드 증명(유닛 테스트)과
  upstream 이슈 상태가 게이트 증거.

## 선택적 후속 (별도 승인 필요, 본 문서의 결론에 포함되지 않음)

**fail-fast UX 패치** — "태스크 전달 수정"이 아닌 진단 개선으로만:

- 조건: routed 모델 요청 + agent_message가 순수 backend ciphertext + 읽을 수 있는 Payload 부재.
- 동작: 자식이 태스크 없이 hallucinate하는 대신, V1 사용을 권고하는 명시적 호환성 에러 반환.
- 구현 위치(방향만): `src/server/responses.ts` sanitizer 인접(`:795` 이전 검사) 또는 parser 경계.
- 텔레메트리(더 약한 대안): `v2_cross_provider_encrypted_task_unreadable` 구조화 이벤트(ciphertext 미포함).
- 채택 여부는 사용자/메인테이너 결정 사항 — 채택 시 별도 decade 문서(032)로 승격.

## 수용 기준

- [x] 책임 판정과 근거가 문서화됨 (007 + 본 문서)
- [x] 추적 대상 이슈가 정확함 (#33551, #32453 아님)
- [ ] (후속) upstream 릴리즈 노트 모니터링 — 트리거 발생 시 재시험 사이클 개설
