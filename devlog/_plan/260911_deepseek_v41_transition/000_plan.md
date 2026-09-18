# 260911 — DeepSeek V4.1 전환

DeepSeek가 2026-09-10에 V4.1-Flash를 내면서 V4 계열의 이름이 한 번에 움직였다. `deepseek-v4-flash`와 `deepseek-v4-flash-vision-exp`는 모델로서 은퇴하고 이름만 V4.1-Flash로 라우팅되는 별칭이 됐고, `deepseek-v4-pro`는 2026-09-14 04:00 UTC부터 단계적으로 퇴역하며 그 시점부터 요청이 V4.1-Flash로 넘어간다. opencodex는 이 두 id를 13개 프로바이더 프리셋에 손으로 박아두고 있어서, 그대로 두면 Pro 컨텍스트 창과 Pro 가격을 광고하면서 실제로는 Flash를 서빙하는 상태가 된다. 이 유닛은 V4.1을 전개하고 v4-pro를 걷어내고, 같은 영역을 건드리는 기여자 PR을 먼저 정리한 뒤 둘 다 dev에 머지한다. 바뀌는 사람은 DeepSeek 경로를 쓰는 모든 사용자다.

근거는 `001_evidence.md`, 출현 지점 집계는 `002_inventory.md`에 있다.

## 루프 스펙

| 항목 | 내용 |
| --- | --- |
| Loop archetype | satisfy-spec |
| Trigger | 사용자 지시: v4.1-flash를 v4-flash가 있는 모든 곳에 전개하고, 퇴역한 v4-pro를 전부 제거하고, PR #4258과 #4274를 머지하라 |
| Goal | V4.1 전개 + v4-pro 제거가 focused 테스트와 함께 dev에 머지되고, #4258/#4274도 머지된다 |
| Non-goals | 새 사용자 config 필드, 어댑터 와이어 동작 변경, main/preview 승격, 릴리스, 생성 메타데이터 수작업 편집 |
| Verifier | `bun test` 영향 도메인, `bun run typecheck`, `bun run privacy:scan`, 머지 전 exact-head CI |
| Stop condition | 두 PR과 이번 변경이 dev에 머지된 시점 |
| Memory artifact | `devlog/_plan/260911_deepseek_v41_transition/` |
| Expected terminal outcomes | DONE = 머지 완료. BLOCKED = CI가 이 변경과 무관한 이유로 반복 실패하거나 머지 권한이 거부될 때 |
| Escalation condition | 사용자가 머지를 명시 승인했다. main/preview 승격과 릴리스는 별도 승인 필요 |
| Resource bounds | 쓰기 범위: `src/`, `tests/`, `docs-site/`, 이 플랜 유닛. 전체 스위트는 사용자 지시로 로컬에서 돌리지 않고 CI에 위임한다 |

## 작업 단계 지도

| work-phase | 문서 | 내용 |
| --- | --- | --- |
| wp1 | 000-002 | 근거·인벤토리·로드맵 잠금 (docs only) |
| wp2 | `010_phase1_pr4258.md` | 기여자 PR #4258 리뷰와 머지 |
| wp3 | `020_phase2_v41_rollout.md` | V4.1-Flash 전개 |
| wp4 | `030_phase3_v4pro_removal.md` | v4-pro 퇴역 제거 |
| wp5 | `040_phase4_merge.md` | docs-site 동기화, PR 게시와 머지 |

## 이 유닛이 내린 두 가지 판단

**1. id는 프로바이더별로 다르다.** DeepSeek 1st-party API의 공식 id는 `deepseek-flash`다. 게이트웨이가 노출하는 철자는 `deepseek-v4.1-flash`이고, 이건 이슈 #4253과 PR #4258이 저장소 안에서 확인해 준 사실이다. "모든 곳에 같은 id"로 넣으면 네이티브 쪽이 틀린 id를 갖는다.

**2. 벤더 호스팅 스냅샷은 DeepSeek 수명주기와 별개다.** Volcengine Ark는 `deepseek-v4-pro-260425`처럼 날짜가 박힌 스냅샷을 고정하고, Alibaba·Ollama Cloud·NVIDIA NIM·Baseten도 각자 로스터를 따로 발표한다. DeepSeek 1st-party 퇴역 공지가 그 벤더들의 배포까지 끝내지는 않는다. 그래서 제거는 **DeepSeek 1st-party와 그것을 되파는 Zen 계열을 먼저** 확정하고, 벤더 호스팅 프리셋은 같은 커밋에서 분리해 PR 본문에 근거와 함께 드러낸다 — 리뷰어가 한 커밋만 떼어낼 수 있게.

## wp1 감사 반영 (2026-09-11)

독립 감사가 로드맵 초안의 결함 6건을 잡았고 전부 수용했다. 가장 큰 것 둘:

- 초안은 공유 상수 `DEEPSEEK_THINKING_MODELS`에 V4.1을 넣으려 했는데, 그 상수는 `deepseek` 1st-party 프리셋의 `models:` 배열 자체를 포함해 6개 프리셋 21곳이 소비한다(`registry.ts:2045`). 그대로 하면 게이트웨이 철자가 네이티브 프리셋으로 새서 020의 수용기준이 자기모순이 된다. 상수를 분리하는 설계로 다시 썼다.
- 초안의 "Pro 사다리를 광고한다"는 근거가 없다. `DEEPSEEK_PRO_*`와 `DEEPSEEK_FLASH_*` 효율 맵은 값이 같다(`registry.ts:701-715`). 실제로 어긋나는 건 **컨텍스트 창과 가격**이다.

나머지는 002/020/030의 해당 절에 반영했다.
