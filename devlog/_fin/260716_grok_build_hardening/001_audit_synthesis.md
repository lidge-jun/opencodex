# 001 — A-round 1 감사 합성 (reviewer: sol/Aristotle, VERDICT: FAIL, blockers 9)

전 블로커 수용. 반박 없음. 문서별 처분:

| # | 대상 | 결정 | 수정 방향 |
|---|------|------|-----------|
| 1 | 010 | 수용 | pendingReasoning의 경계 규칙 완전 정의: user/tool-result/agent 경계에서 clear, function/tool call은 보존(공식 BackendToolCall 규칙), 복수 reasoning sibling은 공식대로 newline join, trailing reasoning은 폐기. 각 경계 활성화 테스트 추가 |
| 2 | 020 | 수용 | placeholder 주석 제거, 완전한 before/after 블록, `hasComparableGrokIdentity` 정의·export, Kiro/merge 분기 명시 보존 |
| 3 | 020 | 수용 | "newer" 판정을 단조 규칙으로 교체: authority = 더 늦은 `expiresAt` 세대(고정 수명 토큰에서 늦은 만료 = 늦은 발급), 동률이면 disk(Grok 소유) 우선. 단순 불일치를 newer로 간주 금지. stale-different-generation 테스트 추가 |
| 4 | 030 | 수용 | 락 획득/해제, stale takeover, retry 루프, index 통합, 테스트 본문 전부 컴파일 가능한 코드로 |
| 5 | 030 | 수용 | persist 직전 store-version compare-and-retry(CAS): 락 진입 시 스냅샷한 파일 fingerprint와 persist 직전 재읽기 비교, 불일치 시 재병합 후 기록. 무관 계정 mutate 경쟁 테스트 추가 |
| 6 | 030+040 | 수용 | 세대 표현 통일: opaque string fingerprint(SHA-256) + equality 비교. numeric/greater-than 제거 |
| 7 | 040 | 수용 | `...`/prose 블록을 완전한 코드로. 네트워크 seam은 030 확정 심볼 기준으로 서술하되 stale-check에 rebase 의무 유지 |
| 8 | 050 | 수용 | `x-grok-req-id` 생성을 transport resolve 시점이 아니라 outbound attempt(fetch wrapper 내부) 시점으로 이동. retry/sidecar 경로에서 attempt별 상이 ID + 고정 session/conv ID 테스트 |
| 9 | 050 | 수용 | 테스트를 산문 지시가 아닌 완전한 교체 코드로 |
| 10 | 020-050 | 수용(Medium) | 각 문서에 Risk/rollback 섹션 추가(재태깅·adopt·needsReauth 상태의 롤백 의미 포함) |

리뷰어 확인 사항(유지): 공식 앵커 전부 실재, 401은 recovery loop에 실제 도달(사이드카 경로는 미커버로 명시), 020 Grok 재읽기는 030 락과 재귀 없음.

## Round 2 (VERDICT: FAIL, blockers 5 — 1,2,6,7,9,10 해소 확인)

전 블로커 수용. 반박 없음.

| # | 대상 | 결정 | 수정 방향 |
|---|------|------|-----------|
| R2-1 | 030 | 수용 | authority 규칙 자체 재구현 금지: 020의 `shouldAdoptGrokGeneration(stored, disk, now, REFRESH_SKEW_MS)`를 import해 사용. 사용 불능(skew창 내) disk 세대는 refresh 입력 금지. later-but-unusable/equal-expiry/missing-expiry 조합 테스트 추가 |
| R2-2 | 030 | 수용 | 읽기-재병합-원자적 rename은 CAS가 아님. 결정: 모든 whole-store writer(`persist` 경유 전부)가 동일 글로벌 락을 짧게 획득(로그인·계정전환 포함, 쓰기 빈도 낮아 비용 무시 가능), refresh는 교환 전체 동안 보유. CAS-read 직후 결정적 테스트 seam 추가, 무관 writer 경쟁 테스트를 그 seam에서 수행 |
| R2-3 | 030 | 수용 | cleanup/release 전 exact-byte/stat 스냅샷 검증(스탈 takeover와 동일 기법). 부분 기록 실패·release-검사-unlink 사이 교체 테스트 추가 |
| R2-4 | 050 | 수용 | adapter-level fetchResponse hook이 서버의 `fetchWithHeaderTimeout`(responses.ts:1228) 경로를 우회함. req-id 주입을 timeout-capable fetch 경계 안쪽(transport fetch wrapper)으로 이동, `ctx.timeoutMs`/`ctx.stream` 의미 보존. timeout 활성화 테스트 추가 |
| R2-5 | 010 | 수용 | 서명 무결성: newline join은 unsigned plaintext sibling에만 적용. `ocxr1` 서명 sibling은 각각 독립 thinking part로 보존(서명↔텍스트 대응 유지). 서명 2개 sibling의 Anthropic replay 테스트 추가 |

## Round 3 (VERDICT: FAIL, blockers 3 — R2-1/R2-3/R2-5 해소 확인) + 아키텍처 재계획

LOOP-REPAIR-01 3회 도달 → 메인 에이전트가 계획을 구조적으로 변경(단순 재수정 아님).

| # | 대상 | 결정 | 아키텍처 변경 |
|---|------|------|---------------|
| R3-1,2 | 030 | 수용 | 글로벌 동기 락 폐기. **이원 락 설계**로 교체: (a) refresh-intent 락 — provider+account 단위 락 파일, IdP 교환 전체 동안 비동기 보유(이중 소비 방지); (b) store-write 락 — 짧게 잡는 글로벌 락, load-merge-persist 임계구역만 보호, 네트워크 I/O 절대 포함 금지. 모든 whole-store writer는 async 직렬 큐 + store-write 락 경유(동기 `Atomics.wait` 금지 — Bun 이벤트 루프 차단). 기존 동기 호출자는 async로 전파 전환(호출부 실측 후 명시). refresh 흐름: intent 락 → 세대 재확인 → 교환 → store-write 락 안에서 재읽기·병합·persist → 해제. 동일 프로세스 writer-during-refresh 활성화 테스트 필수 |
| R3-3 | 050 | 수용 | 서버 seam을 050이 명시 소유: `fetchWithHeaderTimeout`(responses.ts:1228)에 executor 파라미터 추가(기본 global fetch, xAI route는 `route.provider.fetch` 전달), ordinary/recovery 호출자 전부 before/after 제시. 테스트는 실제 서버 경로 통과로 UUID 회전 + TimeoutError 증명. 040과 responses.ts 중복은 stale-check rebase 의무로 관리 |

## Round 4 (VERDICT: FAIL, blockers 1 — R3 3건 전부 해소 확인)

| # | 대상 | 결정 | 수정 방향 |
|---|------|------|-----------|
| R4-1 | 030 | 수용(메인 직접 수정) | 교환 중 동일 계정 write 경쟁: `mergeAccountCredential`에 `expectedGeneration` 가드 추가 — 저장 세대가 시도 세대와 다르면 덮어쓰지 않고 superseded 반환, 사용 가능하면 채택/불가하면 fail-closed(`OAuthLoginRequiredError`, 제3자 세대 재귀 소비 금지 근거 기록). `needsReauth`는 `markAccountNeedsReauthIfGeneration`으로 세대 조건부. 성공/터미널 실패 양쪽의 replacement-during-exchange 테스트 추가 |

## Round 5 (blockers 2 — R4-1 본체 해소 확인)

| # | 대상 | 결정 | 수정 방향 |
|---|------|------|-----------|
| R5-1 | 030 | 수용(메인 직접 수정) | 020-adoption 분기(pre-IdP)에도 동일 `expectedGeneration` 가드 적용: superseded 시 usable→채택, 아니면 fail-closed. adoption 경쟁 테스트 방침 기록 |
| R5-2 | 030 | 수용(메인 직접 수정) | 테스트 코드 결함: `XaiTokenRequestError` 인자 순서 `(status, oauthError, message)`로 정정, 가상 픽스처 별칭 제거 — 파일 내 실제 헬퍼(`seed`/`def`/`saveCredential`/`getAccountSet`)로 재작성 |
