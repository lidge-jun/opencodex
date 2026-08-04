# 001 — 오픈 이슈 18건 전수 분류 (2026-07-22 14:36 KST)

조사: terra 서브에이전트 A (본문+코멘트 전건 열람, 소스 스팟체크 포함).

## 버킷 정의

- **REPLY-ONLY**: 코멘트로 답변/클로즈 가능. 코드 불필요 (by-design, upstream 책임, 중복, 정보 부족).
- **HAS-PR**: 오픈 PR이 이미 커버 — 트리아지가 "해당 PR 리뷰"로 전환됨.
- **SHORT-FIX**: 유효 버그, 소규모 패치 필요, PR 미존재.
- **LONG-TERM**: 신규 프로바이더/아키텍처급. 별도 프로젝트 필요.

## 분류표

| Issue | 요약 | 버킷 | 연결 PR | 근거 | 우선순위 |
|---|---|---|---|---|---|
| #257 | fresh init이 tier backup에서 크래시 | HAS-PR | #258 | stale backup 충돌이 현행 `src/config.ts`에서 재현됨 | P1 |
| #253 | Claude subscription OAuth 파손 (host-managed flag) | HAS-PR | #254 | PR이 host-managed 모드를 auth token 제공 여부로 게이트 | P1 |
| #252 | Claude 서브에이전트가 Sonnet 플레이스홀더로 표시 | REPLY-ONLY | — | upstream 플레이스홀더/표시 의미론 설명으로 충분, 구체적 버그 미제시 | P3 |
| #246 | Fable + effort=max 빈 응답 (stop_reason 소실) | HAS-PR | #256, #237 | #256이 stop_reason 전파 + adaptive budget 리사이즈 모두 커버; #237은 부분 중복 | P1 |
| #245 | Cursor 툴 턴에서 context 100% left 고정 | SHORT-FIX | — | early finalization이 output-only usage로 폴백, checkpoint carry-forward 없음 — 소스 확인됨 | P1 |
| #242 | Copilot device code 하이라이트 UX | HAS-PR | #260 (wrong branch) | PR이 요청 UI/CLI 구현; retarget 후 리뷰 | P3 |
| #241 | Routed 모델이 Desktop picker에 안 뜸 | REPLY-ONLY | — | Codex Desktop 원격 allowlist 문제 — proxy 밖 (upstream). maintainer 답변 이미 존재 | P3 |
| #240 | 다계정 사용자 지정 별칭 | LONG-TERM | — | 프로바이더 횡단 계정 데이터모델 + UI 작업 | P2 |
| #239 | OAuth 중단 후 "이미 진행 중" 재시도 불가 | SHORT-FIX | — | API에 cancel은 있으나 GUI 409 경로가 flow ID 없이 에러만 표시 | P2 |
| #234 | Kimi reasoning_text가 remote compact 400 유발 | HAS-PR | #248 | compact 엔드포인트가 기존 reasoning sanitizer를 우회 — PR이 갭 봉합 | P1 |
| #228 | Kimi가 root object 없는 tool schema에 400 | HAS-PR | #250 | 현행 Kimi 경로는 schema를 무변환 전달 — PR이 root-object 정규화 추가 | P1 |
| #208 | chat/completions 호환 엔드포인트 요청 | REPLY-ONLY | — | 요구 계약(엔드포인트/동작) 상세 부족 — 재현 가능한 스펙 요청 또는 클로즈 | P3 |
| #201 | TRAE International 프로바이더 | LONG-TERM | — | 공식 trae.ai auth/transport 계약 확보 전 블록 | P3 |
| #178 | Factory 프로바이더 | LONG-TERM | — | 일반 모델 어댑터가 아닌 agent-backend 통합급 | P3 |
| #177 | Warp 프로바이더 | LONG-TERM | — | inference API 부재 — 별도 스코프의 agent backend 필요 | P3 |
| #95 | 멀티유저 proxy + LiteLLM | LONG-TERM | — | 테넌트 격리·인증·카탈로그 갱신 등 프로젝트 규모 | P2 |
| #92 | V2 cross-provider NEW_TASK 본문 소실 | REPLY-ONLY | — | upstream(Codex CLI) client ciphertext 한계 — docs가 이미 V1 안내. upstream tracking으로 유지 | P2 |
| #42 | Storage 페이지 + cleanup 정책 | LONG-TERM | — | Phase 1(진단) 완료, 잔여 cleanup/auto-cleanup은 고위험 lifecycle 작업 | P2 |

## 집계

| 버킷 | 건수 | 이슈 |
|---|---|---|
| HAS-PR | 6 | #257 #253 #246 #242 #234 #228 |
| REPLY-ONLY | 4 | #252 #241 #208 #92 |
| SHORT-FIX | 2 | #245 #239 |
| LONG-TERM | 6 | #240 #201 #178 #177 #95 #42 |

## 클러스터 노트

- 프로바이더 요청 3종(#201/#178/#177)은 "registry 한 줄 추가"가 아니다 — 각각 upstream 실행/auth 계약이 달라 개별 타당성 판단 필요.
- #92, #241은 proxy 수정 대상이 아니라 upstream tracking으로만 유지하거나 클로즈.
- 미점유 단기 패치는 #245(Cursor context 보고)와 #239(OAuth flow 재시도) 단 2건.
