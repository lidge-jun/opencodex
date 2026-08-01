# 000 — Grok Build 대조 기반 xAI OAuth/캐시 경로 강화 로드맵

## Objective

공개된 공식 Grok Build 클라이언트(로컬 미러: `/Users/jun/Developer/codex/180_grok-build`)의
auth/wire/cache 계약을 기준으로, OpenCodex의 xAI 서빙 경로에서 확인된 4개 High + 2개
Medium 격차를 닫는다. 근거는 2026-07-16 두 SOL 독립 감사(소스 인용 기반, verdict FAIL)와
실제 프록시 스모크(GROK_SMOKE_OK, cached_tokens=128)이다.

## Constraints / Boundaries

- IN: xAI 경로 한정 — `src/responses/parser.ts`, `src/adapters/openai-chat.ts`,
  `src/oauth/{local-token-detect,xai,store,index}.ts`, `src/server/responses.ts`,
  `src/providers/xai-transport.ts` + 각 테스트.
- OUT: xAI Responses-native 업스트림 마이그레이션, usage `context_details`/cost-tick,
  타 프로바이더, dashboard UI, `git push`(로컬 커밋만; push는 사용자 승인 필요).
- 실행 중인 ocx 프로세스(127.0.0.1:10100)는 서빙 경로 변경 후 재시작해야 반영된다
  (레포 관례: green tests ≠ live proxy 반영).
- 각 work-phase = 1 PABCD 사이클. 두 decade doc을 한 B에서 구현하지 않는다.

## Loop-spec (C3, HOTL)

- Archetype: spec-satisfaction repair (verifier가 done을 정의).
- Trigger: 공식 소스 공개로 계약 격차가 확정됨.
- Goal: 위 5개 격차가 회귀 테스트 + 라이브 스모크로 닫힌 로컬 커밋.
- Non-goals: OUT 항목 전부.
- Verifier: `bun test <targeted>` + `bunx tsc --noEmit`(구성 시) + 서빙 phase는
  `curl 127.0.0.1:10100/v1/responses` xai/grok-4.5 completed 스모크.
- Stop: 5 phase 완료(DONE) / 외부 인증 불능(BLOCKED) / ~4h(BUDGET_EXHAUSTED).
- Memory artifact: 본 유닛 decade docs + goalplan ledger.
- Escalation: 저장소 보안 약화가 필요해지면 UNSAFE로 중단.

## Dependency-ordered phase map

| Doc | Work-phase | 내용 | 의존 |
|-----|-----------|------|------|
| 010 | wp1_reasoning_fold | [reasoning, assistant] → 단일 assistant + reasoning_content 폴딩, parser-to-wire 회귀 | — (wire 형태가 이후 스모크의 기준) |
| 020 | wp2_localcli_ownership | `~/.grok/auth.json` 임포트 자격증명 단일 소유권(refresh 전 재읽기/세대 채택) | — |
| 030 | wp3_refresh_lock | `~/.opencodex/auth.json` cross-process 락 + 세대 재확인 + 토큰 교환 bounded retry | 020 (소유권 규칙 위에 직렬화) |
| 040 | wp4_401_replay | OAuth xAI 요청 업스트림 401 → singleflight 강제 refresh + 1회 replay | 030 (replay가 락/세대 경로를 사용) |
| 050 | wp5_header_parity | 공식 per-request 헤더 패리티 + 클라이언트 버전 호환 프로파일 | 010 (동일 transport 파일, 순서 고정) |

효과 기반 버킷 없음 — 각 phase는 이전 phase의 검증된 산출물을 소비한다(PHASE-SPLIT-01).

## 공식 계약 앵커 (감사 확정)

- folding: `xai-grok-sampling-types/src/conversation.rs:1814` (+회귀 8413)
- auth 단일 소유/락: `xai-grok-shell/src/auth/manager.rs:1529,1560,1604`
- 401 회복: `xai-grok-shell/src/auth/recovery.rs:440`, `manager_tests.rs:1293`
- retry: `xai-grok-sampler/src/retry.rs:14,210,225`
- 헤더: `xai-grok-sampler/src/client.rs:43-70,485`

## SoT sync target (SOT-SYNC-01)

확정: 레포에 CHANGELOG 파일과 xAI 전용 docs 문서는 없음. SoT는
`structure/04_transports-and-sidecars.md`(전송/사이드카 구조 문서)로 하고,
xAI 전송 계층의 락/401 replay/헤더 프로파일 변경을 각 phase D에서 반영한다.
`README.md:202`의 xAI 표는 프로토콜/모드 변경이 없는 한 그대로 둔다.

## Verification commands (확정)

- `bun test --isolate ./tests/xai-transport.test.ts` (+ phase별 신규 테스트 파일)
- `bun run typecheck` (= `bun x tsc --noEmit`)
- 서빙 phase 라이브 스모크: ocx 재시작 후
  `curl -sS 127.0.0.1:10100/v1/responses -d '{"model":"xai/grok-4.5",...}'` → `status: completed`

## Acceptance criteria (활성화 시나리오 포함)

- c1: 새 parser-to-wire 테스트가 `[reasoning(summary), assistant]`와
  `[reasoning(encrypted-only), assistant]` 두 입력에서 assistant 메시지 1개를 단언.
  활성화: 테스트가 parser 경계를 실제 통과(기존 테스트처럼 수동 조립 금지).
- c2: Grok 저장소에 더 새로운 refresh 세대가 있을 때 OpenCodex가 IdP 호출 없이 채택.
  활성화: temp HOME에 모의 `~/.grok/auth.json` 세대 교체 후 refresh 경로 호출.
- c3: 동시 refresh 2건 → 토큰 엔드포인트 호출 1건. 활성화: mock fetch 카운터.
- c4: mock 업스트림 401 → refresh 1회 + replay 1회, 두 번째 401은 그대로 전파.
  활성화: 서빙 경로 통합 테스트 + ocx 재시작 후 라이브 스모크 completed.
- c5: 아웃바운드 헤더 스냅샷 테스트 + 라이브 스모크 completed.
