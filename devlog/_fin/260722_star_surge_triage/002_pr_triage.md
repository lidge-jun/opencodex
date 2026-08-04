# 002 — 커뮤니티 PR 18건 전수 분류 + dev 흡수 순서 (2026-07-22 14:36 KST)

조사: terra 서브에이전트 B (diff/CI/충돌 검토). #259는 maintainer 자체 PR로 제외.
CI 표기는 조회 시점 기준 — `target-only`/`없음`은 전체 플랫폼 CI 미부착 상태.

## 분류표

| PR | 저자 | 요약 | base | CI | 버킷 | 중복/연결 | 권고 |
|---:|---|---|---|---|---|---|---|
| #260 | fxzer | Copilot device-code 하이라이트 | **main** | target ✅ | REPLY-ONLY | #242 | dev retarget + draft 해제 요청 후 재심사 |
| #258 | Wibias | stale migration-backup 교체 | dev | **3 OS ❌** | NEEDS-REVIEW | #257 | e2e receipt 계약 갱신 + "수동 변경도 stale" 정책 재검토 후 재CI |
| #256 | Wibias | Anthropic adaptive max_tokens + stop_reason | dev | all ✅ | NEEDS-REVIEW | **#237 충돌**, #246 | #237 대신 우선 — truncation 상태 전파 포함. 32k vs 128k 정책 결정 필요 |
| #255 | rrmlima | provider JSON editor save flow | dev (draft) | target ✅ | NEEDS-REVIEW | #247/#231 UI 충돌 | 부분 실패/rollback 검토 + full CI 후 |
| #254 | MustangRider | Claude subscription OAuth host routing | dev | all ✅ | NEEDS-REVIEW | #253 | auth-mode 의미 변경 — Claude Code 실사용 회귀 확인 후 |
| #251 | HaydernCenterpoint | Antigravity schema required 중복 제거 | dev | target ✅ | SMALL-SAFE | — | full CI 확인 후 초반 흡수 |
| #250 | Wibias | Kimi root tool-schema object 보장 | dev | all ✅ | SMALL-SAFE | **#228** | 1-file 호환성 수정 — 최우선 흡수 |
| #249 | Aiweline | Cloudflare Named Tunnel 기본화 | dev | 없음 | BIG/LONG-TERM | — | +4.6k/25f, credential·public ingress — 보안/운영 설계 별도 단계 |
| #248 | Wibias | compact 엔드포인트 reasoning sanitize | dev | all ✅ | SMALL-SAFE | **#234** | 7줄 parity fix — 최우선 흡수 |
| #247 | HaydernCenterpoint | 통합 프로바이더 설정 UI | dev | target ✅ | BIG/LONG-TERM | #255/#231 충돌, #226 계승 | UX 방향 결정 후 별도 UI 리뷰 |
| #244 | Lqm1 | 일본어(ja) 로컬라이제이션 | dev | 없음 | BIG/LONG-TERM | i18n 광역 | +4.7k/41f — 번역 QA·docs build·locale parity 별도 검토 |
| #238 | eachann1024 | combo rename + public aliases | dev (draft) | target ✅ | BIG/LONG-TERM | #214 계승, #133 | routing/config migration — draft 해제 전 API 리뷰 |
| #237 | jonathanli12 | adaptive-thinking 128k 기본값 | dev | 없음 | REPLY-ONLY | **#256 충돌** | #256 채택 시 사유 코멘트 후 클로즈. 둘 동시 병합 금지 |
| #235 | riique | OpenRouter provider routing 설정 | dev | 없음 | NEEDS-REVIEW | — | fail-closed 의미론 + 외부 API 계약 코드리뷰 후 CI |
| #232 | Wibias | Kiro GUI 로그인 manual-paste 해제 | dev | all ✅ | SMALL-SAFE | — | 명확한 deadlock fix — 초반 흡수 |
| #231 | Wibias | Accounts 탭 죽은 API-key 행 제거 | dev | all ✅ | SMALL-SAFE | #247 겹침 | #247 보류 시 먼저 병합, #247 채택 시 그쪽에 흡수 |
| #230 | jonathanli12 | combo 자식 요청 content-encoding 제거 | dev | target ✅ | SMALL-SAFE | #238 인접 | full CI 후 초반 흡수 |
| #229 | Wibias | issue intake/quality 자동화 개편 | dev | all ✅ | BIG/LONG-TERM | #225 계보 | `provider-compatibility` 라벨 선생성 후 staged 리뷰 |

## 집계

| 버킷 | 건수 | PR |
|---|---|---|
| SMALL-SAFE | 6 | #248 #250 #232 #251 #230 #231 |
| NEEDS-REVIEW | 5 | #256 #254 #255 #258 #235 |
| BIG/LONG-TERM | 5 | #249 #247 #244 #238 #229 |
| REPLY-ONLY | 2 | #260 #237 |

## 권장 dev 흡수 순서 (one-at-a-time)

1. #248 → #250 → #232 (all-green, 독립, 소형)
2. #251 → #230 (full CI 부착·통과 후)
3. #231 — 단 #247 방향 결정 선행
4. #254 (Claude 실사용 회귀 확인 후)
5. #255 (full CI + partial-save 정책 검토 후)
6. #256 **또는** #237 중 택1 — 현재 #256 우선 권고
7. #235
8. #247 → #238 → #229 → #244 → #249 — 각각 독립 설계/리뷰 단계

## 충돌·결정점

- **#256 vs #237**: 동일한 adaptive-thinking ceiling 문제. #256은 stop_reason/incomplete 전파 + 32k headroom, #237은 단순 128k 기본값. 병합 전 정책 확정, 동시 병합 금지.
- **#247 vs #255/#231**: 셋 다 Providers UI. #247을 제품 방향으로 채택하면 소형 PR을 먼저 흡수해 rebase시킬지, #247에 재구현시킬지 결정.
- **#258**: 3 OS CI 실패가 전부 같은 e2e assertion — PR이 collision을 성공 처리로 바꿨는데 e2e 계약은 여전히 "collision fails"를 기대. 계약 갱신 필요.
- **#249**: Cloudflare API token/runner token 저장 + public ingress + rollback 포함, 실계정 provisioning 검증 없음. 보안 리뷰 없이 병합 불가.
- **#229**: `provider-compatibility` 라벨 미존재 상태로 병합하면 신규 issue form 라벨 적용 파손.
- **#260**: main 대상 + draft, branch-enforcement가 이미 wrong-branch 표시 — retarget 안내 코멘트만.
