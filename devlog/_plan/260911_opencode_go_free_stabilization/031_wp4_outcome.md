# 031 — wp4 결과

PR: <https://github.com/lidge-jun/opencodex/pull/4274> (base `dev`, head `codex/260911-opencode-go-free-stabilization`)

## 최종 변경 범위

| 커밋 | 내용 |
| --- | --- |
| `d0e4e5218` | `noJsonSchemaModels` 계약: 타입, 레지스트리 필드와 세 프리셋 시드, 라우터 병합/emit, config zod + superRefine, auth-cors 검증기 + 필드 정책, provider-routes PATCH + DTO, 어댑터 두 와이어의 낮추기, 회귀 테스트 10건 |
| `58fe2b07f` | opencode-go `thinkingBudgetModels` 를 Go 전용 목록으로 좁힘 + 구조 가드 2종 |
| `4ed244bca` | docs-site en + 7개 로케일 |
| `ecb6a14a4` | 프랑스어 문서의 기존 행 조판 원복 (감사 지적) |

## 검증

포커스 스위트만 돌렸다. 사용자가 전체 스위트를 명시적으로 금지했고, 푸시는 `--no-verify` 로 지시했다.

- 어댑터/프리셋 155 pass / 0 fail
- parity + 카탈로그 효율 97 pass / 0 fail
- config/management 637 pass / 0 fail
- `bun run typecheck` exit 0, `bun run privacy:scan` 통과
- red-green: 세 가드 모두 수정 전 실패를 직접 확인

전체 스위트는 CI 에 맡겼다. 이전에 로컬에서 한 번 시도했을 때 879초가 걸렸고 exit 1 로 끝났는데, 출력이 잘려 어떤 파일이 실패했는지는 확인하지 못했다. 이 브랜치가 원인인지도 확인되지 않았다 — 재확인은 CI 결과로 대체한다.

## 남긴 것

- `deepseek-v4.1-flash` 는 시드하지 않았다. 게이트웨이가 서빙한다는 근거가 트리에 없다.
- `json_object` 수용 여부는 미검증이다. DeepSeek 계열이 프롬프트에 `json` 문자열을 요구하는 구현이면 낮추기가 400 대신 빈 응답이 될 수 있다. PR 본문에 후속 조건으로 명시했다.
- 구조 가드는 세 프리셋 id 를 루프로 돈다. 네 번째 Zen 계열 프리셋이 생기면 목록에 추가해야 한다.
- 스키마 강등을 관측 가능한 신호로 남기는 건(요청 본문 로깅 금지와 인접) 후속 판단으로 미뤘다.
