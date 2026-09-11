# 260911 — opencode-go / zen / free 안정화

OpenCode Zen 게이트웨이(go, zen, free)로 붙는 세 프리셋은 정적 `models:` 배열이 없고, 카탈로그가 `liveModels !== false`인 프로바이더를 live로 훑는다(`src/codex/catalog/provider-fetch.ts:440`). free만 `liveModels: true`를 명시하고(`src/providers/registry.ts:3049`) go/zen은 선언 없이 기본값으로 그 경로를 탄다. 반면 모델별 능력은 손으로 적은 정확-id 표에 묶여 있다. 그래서 새 모델 id가 게이트웨이에 뜨면 추론 강도 사다리, reasoning 재생, 비전 사이드카가 조용히 빈 채로 통과하고, 게이트웨이가 거절하는 요청 형태(특히 `response_format` json_schema)는 프리셋이 표현할 수단조차 없어 사용자가 직접 config를 고쳐야 한다. 이 유닛은 그 세 가지를 고친다: 프리셋이 그 거절을 표현할 수 있게 하고, 이미 증명된 프리셋 내부 불일치 두 건을 맞추고, 같은 종류의 드리프트를 다음번엔 테스트가 잡게 만든다. 바뀌는 사람은 Zen Go/Free를 쓰는 운영자다 — 지금 손으로 넣고 있는 설정이 기본값이 되고, 새 id가 들어와도 능력 표가 어긋나면 CI가 먼저 운다.

연구 근거는 `001_issue_triage.md`(GitHub 트리아지), `002_cross_proxy_survey.md`(다른 프록시 교차 조사), `003_registry_gap_inventory.md`(코드 갭 인벤토리)에 있다.

## 루프 스펙

| 항목 | 내용 |
| --- | --- |
| Loop archetype | satisfy-spec. 열린 최적화가 아니라 확정된 갭 목록을 닫는다 |
| Trigger | 사용자 요청: opencode go/free 이슈·PR을 묶어 안정화 PR을 올려라 |
| Goal | dev를 base로 하는 PR 하나. 프리셋 능력 표현 + 내부 불일치 수정 + 회귀 가드 + 문서 동기화 |
| Non-goals | `src/providers/command-code-efforts.ts`(열린 PR #4258 소유), 어댑터 와이어 동작 변경, 새 사용자 config 필드, 라이브 업스트림 프로브가 필요한 주장, 무키 free 티어 정책 변경 |
| Verifier | `bun test tests/providers/provider-registry-parity.test.ts`, `bun test tests/providers/opencode-go-deepseek.test.ts`, `bun test tests/adapters/openai/openai-chat-hardening.test.ts`, `bun run typecheck`. 신설 가드는 수정 전 실패를 먼저 확인한다 |
| Stop condition | PR이 dev를 base로 열리고 템플릿 3개 섹션이 채워진 시점 |
| Memory artifact | `devlog/_plan/260911_opencode_go_free_stabilization/` |
| Expected terminal outcomes | DONE = PR 게시 + 모든 검증 명령 green. BLOCKED = 업스트림 사실 확인이 필요해 근거 없이 시드할 수 없는 항목이 남을 때 |
| Escalation condition | push 권한은 사용자가 이미 준 PR 게시로 한정한다. 머지·릴리스는 별도 승인. 라이브 프로브가 필요한 주장은 시드하지 않고 보고한다 |
| Resource bounds | 도구: repo 읽기/쓰기, gh 읽기 + PR 생성, grok-4.6 서브에이전트. 쓰기 범위: `src/providers`, `src/types`, `tests/providers`, `docs-site`, 이 플랜 유닛. 벽시계: 사용자 세션 내 |

## 작업 단계 지도 (의존 순서)

| work-phase | 문서 | 내용 | 선행 |
| --- | --- | --- | --- |
| wp1 | 000-003 | 조사 종합과 로드맵 잠금 (docs only) | — |
| wp2 | `010_phase1_preset_structured_output.md` | 프리셋이 `noStructuredOutputModels`를 표현하고 Zen 계열 DeepSeek에 시드 | wp1 |
| wp3 | `020_phase2_preset_consistency_guard.md` | 프리셋 내부 불일치 G1·G2 수정과 parity 회귀 가드 | wp2 |
| wp4 | `030_phase3_docs_and_pr.md` | docs-site 동기화와 PR 게시 | wp3 |

goalplan의 wp3 제목은 초기 등록 시 "어댑터 전송 계층"이었다. 조사 결과 어댑터 와이어 결함은 이미 랜딩되었거나(`002`) 우리 구조상 발생하지 않아, 이 문서가 wp3의 실제 범위를 정합성·가드로 확정한다.

## 자문과 감사 기록

- **아키텍트**: grok-4.6. 첫 턴이 끊겨 한 번 재촉한 뒤 제안서를 받았다. 초안의 `noStructuredOutputModels` 시딩을 MISALIGNED로 반박했고 main이 수용했다(010 수정절).
- **독립 감사 2레인**: grok-4.6과 상속 모델로 각각 한 번. 둘 다 `VERDICT: near-pass`. 지적은 010/020에 전부 반영했다.
- **G2 불일치**: 두 리뷰어가 갈렸다. grok 레인은 "free 로스터에 paid id 증거가 없으니 넣지 말라", 상속 레인은 "같은 엔트리가 이미 #1043 근거로 공유 text-only 목록을 free에 통째로 싣는 선례가 있고(`registry.ts:3076`), 능력 표는 정확 일치라 없는 id면 무해하다"고 했다. main은 후자를 채택한다 — 능력 표는 카탈로그 로스터를 만들지 않으므로(`applyProviderConfigHints`는 이미 들어온 id만 장식한다) 없는 모델을 광고하지 않는다.
- **실패한 레인**: GitHub 트리아지 레인과 첫 리뷰어 레인은 grok-4.6에서 최종 메시지 없이 턴이 끝나는 증상으로 각각 두 번 실패해 은퇴시켰고, 해당 작업은 main이 직접 수행했다.
