# 030 — Bug-PR merge loop: per-PR disposition

조사일: 2026-08-15 / dev head: deea372c4
조사: sol medium 서브에이전트 3인 (Bernoulli #1703, Lagrange #1625, Kuhn stack)

## 판정 요약

| PR | 라벨 | 판정 | 근거 |
|----|------|------|------|
| #1693 | documentation | LAND | 9개 로드맵 파일 전부 dev에 없음, 동일 파일 충돌 0 |
| #1696 | bug | LAND | dev에 context-window **회계**는 있으나 **사전 거부** 없음 (core.ts:1840→1856 사이 admission 부재) |
| #1698 | bug | LAND | state.ts:895가 저장 히스토리를 무조건 prepend, overlap 비교 없음 |
| #1625 | bug | CHERRY_PICK_SUBSET | 롤백 버그는 dev에 잔존하나 PR이 843줄 네이티브 재설계 동반 |
| #1703 | bug | NEEDS_HUMAN | High 3건 — router.ts가 bare claude-*를 임의 Anthropic 프로바이더로 라우팅 |
| #1655 | enhancement(bug-equiv) | 평가 대상 | 빈 응답 무음 종료 수정, +646/-10 |
| #1660 | enhancement(bug-equiv) | 평가 대상 | #1651 수정, opt-in 가드, +171/-4 |

## 착지 순서 (스택 bottom-up)

1. #1693 docs root — 공백 hygiene 정리 후
2. #1696 input admission — core.ts에 16줄 offset으로 적용
3. #1698 continuation dedup — state.ts/spill-store/types

세 커밋 SHA:
- #1693 c96810c12d32bf4b2a73d42c68c8aa313eac45b6
- #1696 0298177c992e5b45ca8f8482ffb014e425d07c6a
- #1698 33e2b70bd3e5c5f5013946e3fa1864067763bbd6

merge-base 36aed0bf / dev 45 커밋 앞섬 / 스택 3 커밋

## #1703 차단 사유 (NEEDS_HUMAN)

1. High — affinity가 활성 세션이 아닌 정적 config(claudeCode.model)에서만 파생. #1697의 핵심 케이스인 picker/--model 선택은 여전히 affinity 상실
2. High — router.ts:699-705가 모든 bare claude-*를 첫 번째 활성 Anthropic 어댑터로 전송. 카탈로그 확인도 사용자 승인도 없음 → 프라이버시/과금/데이터 경계 변경
3. High — classifierFallbacks가 실제 failover 아님. 첫 항목만 반환, 가용성 확인도 후속 후보 시도도 없음
4. Medium — classifier 감지가 과광범위. Opus 4/5 요청 대부분을 Auto Mode classifier로 취급
5. Medium — 신규 설정이 management API/문서에 미노출

resolveInboundModel()은 네이티브 Anthropic 자격증명의 passthrough 여부를 결정하는 보안 경계다. 메인테이너 판단 필요.

## #1625 이식 범위

가져올 것 (f36aedf42에서):
- 빈 파일에도 동작하는 metadata-only shimPathFingerprint()
- 런처 이동 직후 movedOriginalFingerprint 기록
- 해당 fingerprint로 롤백 검증
- "content-probe 불가한 original 복원" 회귀 테스트

가져오지 않을 것:
- bun:ffi cc() 네이티브 헬퍼 + C 구현 (Windows/Linux/macOS)
- Windows 다중 런처 트랜잭션 재작성
- atomic no-replace wrapper 발행 hardening

이유: 843줄 크로스플랫폼 재설계는 별도 제안 + 플랫폼 검증 필요. 초점 수정만 이식.


## A-게이트 교정 (리뷰어 Galileo, NEAR-PASS)

리뷰어가 독립 검증한 결과 아래 5건을 반영한다.

### 1. #1655 / #1660 → LEAVE_OPEN

- #1655: 실제 결함을 다루지만 해법이 default-on 신뢰성 정책이다. `emptyCompletionRetryEnabled()`가 명시적 비활성화 없이는 과금 가능한 2차 상류 요청을 켠다 (empty-completion-guard.ts:22-31). core.ts:3062-3071에서 combo/compaction 제외 전 Responses 어댑터에 적용. +646/-10에 dev와 충돌 중 → 전용 설계/리베이스/전체 스위트 리뷰 필요.
- #1660: opt-in 플래그(types.ts:1453-1464) 신설. 플래그를 켜지 않으면 기본 동작 불변 → 결함 수정이 아니라 기능. #1651도 feature로 유지 중.

### 2. #1625 → MANUAL_PORT_SUBSET (명칭 교정)

f36aedf42는 실제 +821/-63, 5개 파일이며 네이티브 헬퍼와 트랜잭션 재작성을 포함한다. cherry-pick 후 hunk 폐기가 아니라, 아래 항목만으로 초점 패치를 **새로 구성**한다:
- metadata-only shimPathFingerprint() (shim.ts:407-420)
- movedOriginalFingerprint 캡처 (:1897-1906)
- 해당 fingerprint 기반 롤백 검증 (:867-884)
- content-probe 불가 original 복원 회귀 테스트

### 3. #1696 / #1698 순차 착지 강제

두 PR의 **전체 패치는 현재 dev에 적용되지 않는다**. 각각 #1693이 도입하는 devlog 파일에 의존:
- #1696 → devlog/_plan/260814_usage_memory_roadmap/010_m0_1_input_admission.md 부재로 FAIL
- #1698 → 020_m0_2_continuation_dedup.md 부재로 FAIL

코드/테스트 hunk만 보면 전부 통과 (core.ts는 16줄 offset). 따라서 강제 순서:
`#1693 착지 → #1696 apply-check → 착지 → #1698 apply-check → 착지`
각 선행 착지 후 apply-check를 재실행한다.

### 4. #1693 공백 hygiene 게이트 유지

전체 패치는 적용되나 whitespace 오류 10건(trailing whitespace, EOF 여분 개행) 보고됨. 착지 전 정리 필수.

### 5. #1703 — 설계 수정 대상

단순 인간 승인으로 통과시킬 사안이 아니다. 리뷰어가 router.ts:699-705의 임의 프로바이더 선택, 정적 config 기반 affinity, failover 아닌 classifierFallbacks를 모두 재확인했다. 라우팅/프라이버시 설계 결정이 선행돼야 한다.

