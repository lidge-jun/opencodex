# 007 — RCA V: V2 cross-provider NEW_TASK encrypted_content 소실 (#92) — 책임 경계 판정

- 이슈: #92 (open). 조사: sol 레인 V (2026-07-22, dev 트리 + upstream 소스 오픈 검증)

## 증상

native 부모(gpt-5.6-sol) → routed 자식(xai/grok-4.5) V2 spawn 시 NEW_TASK가
읽을 수 있는 봉투(헤더) + 빈 `Payload:` + 순수 Fernet `encrypted_content`로 도착.
sanitizer `rewritten: 0`, 자식은 태스크 본문을 받지 못함.
**재현 증거 상태**: 이슈 #92의 maintainer 코멘트(현 dev 기준 status update)가 증상 서술의 근거이며,
로컬 end-to-end 재현 캡처(커맨드/픽스처)는 본 조사에서 첨부되지 않았다 — 이 정확한 로컬 재현은
**unverified**로 표기. 단 순수 Fernet 경로의 코드 동작 자체는 유닛 테스트로 증명됨
(`tests/multi-agent-compat.test.ts:405` byte-identical 보존, parser 스킵 `parser.ts:29`).
031 게이트 증거는 이 코드 증명 + upstream #33551 open 상태에 근거한다.

## 페이로드 분류와 현재 처리 (파일:라인)

| 형태 | 처리 | 결과 |
|------|------|------|
| 순수 평문이 encrypted 슬롯에 | ciphertext 휴리스틱 불통과(`src/server/responses.ts:300`) → input_text 복원(`:350`), 전체 평문 agent_message는 user message 정규화(`:373`) | 복구됨 (`tests/multi-agent-compat.test.ts:364,418`) |
| 평문 서문 + Fernet 혼합 | `FERNET_TOKEN_RUN`(`:305`) → 평문은 input_text, Fernet 세그먼트 보존(`:313`) | 평문 서문만 전달 (`:391` 테스트) |
| **순수 Fernet** | `looksLikeBackendCiphertext` 통과 → byte-identical 보존(`:363`) | **복구 불가** (`:405` 테스트) |

routed 자식이 실제 받는 것: `function_call_output`의 encrypted_content는 `[encrypted content omitted]`
마커(`src/responses/parser.ts:192`), V2 NEW_TASK(agent_message)는 `inputContentParts`(`:296`)에
encrypted 분기가 없어 **조용히 스킵**(`:29`) — 평문 파트가 전무하면 `(sub-agent message received)` 대체(`:307`).

## 복호화 경계 분석

키는 OpenCodex에 없다. upstream PR openai/codex#26210(2026-06-05 merge)이 경계를 명시:
Responses 백엔드가 V2 message 툴 인자를 암호화, Codex는 ciphertext만 전달·보존,
`InterAgentCommunication.content`는 의도적으로 빈 문자열(`String::new()` 현존 확인).
복호화 능력은 OpenAI Responses 백엔드/세션 보안 컨텍스트에 있고 로컬 CLI에도 프록시에도 없다.
→ 로깅·정규식 추출·"compat decrypt" 플래그로는 복구 불가능.

## Upstream 상태 (2026-07-22 소스 오픈 확인)

- **openai/codex#33551** — 정확히 일치하는 upstream 이슈 (2026-07-16 open, 미배정, fix 없음): 외부 프로바이더가 V2 agent_message.encrypted_content를 복호화할 수 없음, provider-aware 평문 전송 권고. **추적 대상은 이것.**
- #26210 — 설계 원점 (암호화 V2 태스크 전달).
- #28058 — open, V2 통신이 빈 content로 저장됨 확인.
- #26753 — "not planned" close; OpenAI 측이 V2 개발 중·사용 비권장, 워크어라운드는 V1.
- **정정**: 이슈 #92 코멘트에 링크된 #32453은 무관(모델 전환 후 429 compaction 이슈) — 추적 대상 아님.
- 릴리즈 노트에 provider-aware 수정 없음 (0.144.4는 no user-facing changes).

## 판정: **UPSTREAM**

- 유일한 평문 사본이 프록시 도달 전에 소멸 — 어떤 로컬 구현도 원본 태스크를 전달할 수 없다.
- 기존 로컬 완화(평문/혼합 복구)는 올바르며 유지.
- 로컬 책임은 UX 한정: 조용한 태스크 소실 대신 명시적 호환성 에러 가능 — 이것이 mixed 판정을 만들지는 않음.

## 로컬 완화 순위 (031 입력)

1. **V1 안내 (이미 구현)** — README.md:232 현존. 유일하게 태스크 전달을 보존하는 경로.
2. **fail-fast (실행 가능한 진단 완화)** — routed 모델 + 순수 Fernet agent_message + 빈 Payload 감지 시 V1 권고를 담은 명시적 호환성 에러 반환. 태스크 복구는 아니고 hallucination 방지.
3. 경고/텔레메트리 (`v2_cross_provider_encrypted_task_unreadable` 구조화 로그) — 약하지만 유용.
4. ~~부모측 평문 재전송~~ 불가 (send_message/followup_task도 동일 암호화 메커니즘).
5. ~~compat decrypt 플래그~~ 불가 (프록시가 너무 늦게 본다).
6. ~~자동 V2→V1 다운그레이드~~ 현재 불가 (모드가 클라이언트 상태에 뿌리내림).

## 031 권고

**명시적 no-functional-patch / upstream-tracking 결론 문서.**
책임=upstream, 기능적 로컬 diff=없음, 추적=openai/codex#33551(#32453 아님),
upstream이 평문 유지 또는 provider-aware 전달을 도입하면 재시험.
선택적으로 fail-fast UX 패치를 별도 좁은 범위로 — 단 "태스크 전달 수정"으로 표현 금지.
복호기 추가·Fernet→텍스트 재작성·ciphertext 전역 제거는 금지 (native replay 파괴).
