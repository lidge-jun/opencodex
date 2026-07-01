# chase — 따라갈 내용 인덱스 (실행 순)

> reviewed through: jawcode `27311f6` · cca `00114be` · litellm `be4d0d8` (2026-07-01)
> 갭 분류: `01_overview.md` · 인벤토리: `02_gap_inventory.md`

## Tier 1 — 저비용/고가치 (먼저)

| 순 | 항목 | 종류 | 작업 | 완료 기준 |
|---|---|---|---|---|
| 1 | deepinfra provider | G1 | registry 한 줄 + 모델 시드 (jawcode HEAD `27311f6` 참조) | `registry.ts`에 entry, 라우팅 스모크 |
| 2 | models.json delta 동기화 | G1 | jawcode 3758 엔트리 중 누락 모델·컨텍스트 윈도우 반영 | 카탈로그 diff 0 신규 누락 |
| 3 | 모델 가격/컨텍스트 교차검증 | G3 | litellm 맵으로 기존 카탈로그 컨텍스트 윈도우 검증 | 불일치 목록 0 또는 의도 기록 |

## Tier 2 — wire/auth 깊이 (중간)

| 순 | 항목 | 종류 | 작업 | 완료 기준 |
|---|---|---|---|---|
| 4 | antigravity replay 깊이 | G2 | cca 667줄 ↔ opencodex 136줄 line 대조, clear-on-invalid·캐시 키·멀티턴 보존 누락 식별 | 누락 항목 목록 + 보강 결정 |
| 5 | vertex OAuth | G2 | cca `vertex_credentials.go` 참조, 서비스계정 OAuth 경로 보강 여부 | 결정 기록 (보강 or key-only 유지 근거) |
| 6 | xai reasoning-replay/WS | G2 | opencodex xai가 forward-only인지 확인, cca 전용 모듈 대비 gap 평가 | gap 확정 + 우선순위 |

## Tier 3 — 폭/고비용 (나중)

| 순 | 항목 | 종류 | 작업 | 완료 기준 |
|---|---|---|---|---|
| 7 | chat 롱테일 provider | G3 | cohere·databricks·ai21 등 openai-호환 후보 registry 추가 | 후보 목록 + 선별 추가 |
| 8 | cursor 어댑터 | G1 | jawcode `cursor.ts` agent 프로토콜 포팅 (별도 work-phase) | 어댑터 + 라우팅 + 테스트 |
| 9 | 직접 amazon-bedrock | G1 | sigv4 직접 경로 (kiro 외) 필요성 평가 | 결정 기록 |

## opencodex 선행 (유지·회귀 방지)

G4 항목(kiro 풀세트·codex WS·구독 IDE provider)은 따라잡을 대상이 아니라 **opencodex 우위**다.
upstream import 시 회귀하지 않도록 보존한다.

## 갱신 규칙

upstream fetch → `00_parity-index.md` HEAD 갱신 → `02_gap_inventory.md` reviewed-through 행 갱신
→ 상태 어휘 재평가 → 이 인덱스 Tier 재정렬.
