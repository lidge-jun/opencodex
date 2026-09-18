# 260914 godfile round2 — src 갓파일 분해와 파일 크기 래칫

`dev`에는 사람이 유지하는 2,000줄 이상 텍스트 파일이 52개 있고(래칫이 실제로 스캔하는 범위, 즉 `devlog/` 제외 기준으로는 51개) 그중 15개가 `src/`에 있다. 이 단위는 그중 7개를 facade 보존 순수 이동으로 분해하고, 같은 일이 다시 쌓이지 않도록 파일 크기 래칫 게이트를 CI에 넣는다. 기여자에게 바뀌는 것은 두 가지다. 새 파일은 처음부터 2,000줄 미만이어야 하고, 기존 초과 파일은 더 길어질 수 없다. 분해 대상 파일을 import하던 코드는 facade가 남으므로 바뀌지 않는다.

숫자의 출처는 `git ls-files`에 대한 줄 수 측정이며, 생성물·벤더 스냅샷·로케일 미러 12경로를 제외한 값이다. 그 12경로는 `010_phase1_file_size_ratchet.md`의 `generated` 목록이 권위를 갖는다.

## 로프스펙

| 항목 | 내용 |
|---|---|
| Loop archetype | satisfy-spec. 완료 조건이 파일별로 고정돼 있고 사이클마다 종료한다 |
| Trigger | 사용자 요청: 스택 PR로 쌓고 tip-only CI로 추적하며 5~6 PABCD 사이클로 dev 머지까지 완료 |
| Goal | 7개 `src/` 갓파일을 1,999줄 이하로 분해하고 래칫 게이트와 함께 `origin/dev`에 머지 |
| Non-goals | 기능 정책 변경, 버그 수정 동반, `tests/` 33개 분해, i18n·생성물·devlog 분해, `core.ts`·`server/index.ts`·`auth-api.ts`·`providers/registry.ts` 본체(별도 단위) |
| Verifier | hosted CI. 수동 브랜치 체인의 tip PR 실행을 레인 게이트로 쓴다(DEV-STACK-08, owner 승인) |
| Stop condition | 6개 사이클의 D가 모두 닫히고 레인이 `dev`에 머지될 때 |
| Memory artifact | 이 단위(`devlog/_plan/260914_godfile_round2/`)와 각 PR 본문 |
| Expected outcomes | 성공 = 7파일 facade화 + 래칫 녹색 / 차단 = tip CI 적색이 반복되고 원인이 분해 외부일 때 |
| Escalation | tip CI가 분해와 무관한 이유로 적색이거나, 래칫 기준선이 다른 작업과 충돌할 때 |

## 제약

로컬에 `node_modules`가 없고 사용자 환경에서 install·build·typecheck·full suite를 돌리지 않는다. 따라서 이 단위의 모든 검증은 hosted CI이며, 문서와 PR 본문에서 로컬 실행 결과를 주장하지 않는다. 각 PR의 CI를 개별로 기다리지 않고 후행 추적한다. 최종 판정은 레인 tip의 exact-head 실행이다.

열린 PR과의 충돌은 순서 제약에서 제외한다(사용자 지시). 순서는 기술 의존성만으로 정한다. 그 대가로 `src/config.ts`에 걸린 21건을 포함해 47건이 리베이스 대상이 되며, 이 단위는 그 비용을 감수한 것으로 기록한다.

## 작업 단계 지도

| 사이클 | 문서 | 대상 | 브랜치 | PR base |
|---|---|---|---|---|
| 0 | `000_plan.md` + 010~050 | 로드맵(코드 변경 없음) | `codex/m2k-l1-roadmap` | `dev` |
| 1 | `010_phase1_file_size_ratchet.md` | 래칫 게이트 | `codex/m2k-l2-ratchet` | L1 |
| 2 | `020_phase2_state_and_shim.md` | `src/responses/state.ts`, `src/codex/shim.ts` | `codex/m2k-l3-state-shim` | L2 |
| 3 | `030_phase3_inject_and_catalog_sync.md` | `src/codex/inject.ts`, `src/codex/catalog/sync.ts` | `codex/m2k-l4-inject-sync` | L3 |
| 4 | `040_phase4_routing_and_quota.md` | `src/codex/routing.ts`, `src/providers/quota.ts` | `codex/m2k-l5-routing-quota` | L4 |
| 5 | `050_phase5_config.md` | `src/config.ts` | `codex/m2k-l6-config` | L5 |

의존은 단순하다. 사이클 1의 래칫이 먼저 있어야 이후 사이클이 만드는 새 파일이 게이트를 통과했다는 증거를 남길 수 있고, 사이클 2~5는 서로 파일이 겹치지 않으므로 체인 순서는 리뷰 편의를 위한 것이다. 사이클 5를 마지막에 두는 이유는 `src/config.ts`가 가장 많은 문서(10곳)와 오라클(9건)을 끌고 있어 앞 단계에서 얻은 패턴을 그대로 쓰기 위해서다.

사이클 내부의 PR 순서는 각 decade 문서가 소유한다. 특히 `050_phase5_config.md`는 초안의 묶음에 순환 의존이 있음을 실측으로 확인하고 순서를 재배치했다(salvage가 `configSchema`를, diagnostics가 salvage와 load-degrade를, live-reconcile이 `persistConfigUnlocked`를 쓴다). 이 문서의 표는 사이클 경계만 정의하며, 사이클 안의 순서는 decade 문서를 따른다.

## 스택 형태

수동 브랜치 체인이다. GitHub 네이티브 스택은 사용하지 않는다(DEV-STACK-OPT-IN-01: 명시적 opt-in 없음). 각 링크의 PR base는 바로 아래 링크의 head 브랜치이고, 최하단 L1만 `dev`를 base로 한다.

```
codex/m2k-l6-config        → PR (base: l5)   ← tip
codex/m2k-l5-routing-quota → PR (base: l4)
codex/m2k-l4-inject-sync   → PR (base: l3)
codex/m2k-l3-state-shim    → PR (base: l2)
codex/m2k-l2-ratchet       → PR (base: l1)
codex/m2k-l1-roadmap       → PR (base: dev) ← bottom
─────────────────────────── dev
```

## CI 정책 (DEV-STACK-08, owner 승인)

비-tip 링크의 head 커밋 제목에 `[skip ci]`를 붙여 tip만 비싼 스위트를 돌린다. 이 전략은 저장소 소유자가 이 배치에 한해 승인한 예외이며 기본값이 아니다.

지켜야 할 것은 셋이다. 누락·스킵·취소된 체크는 통과가 아니다. `[skip ci]`가 trunk에 착지하는 커밋 제목에 도달하면 안 된다(머지 커밋 제목에는 붙이지 않는다). 레인이 착지한 뒤 `dev`를 관찰하고 적색이면 다음 레인을 멈춘다.

## 머지 순서

체인 자식은 top-down으로 머지한다. 스택 자식을 머지하면 trunk가 아니라 부모 브랜치에 착지하기 때문이다. L6 → L5 → L4 → L3 → L2 순으로 각각 부모에 착지시키고, 마지막에 L1(base `dev`)을 머지하면 전체가 `dev`에 올라간다. L1을 머지하기 직전의 exact-head CI가 이 단위의 최종 게이트다.

각 머지 전에 조상 불변식을 확인한다.

```sh
git merge-base --is-ancestor origin/<link-branch> <tip-commit>
```

## 완료 조건

| 검사 | 조건 |
|---|---|
| 파일 크기 | 대상 7개가 전부 1,999줄 이하, 새 모듈 전부 1,999줄 이하 |
| 래칫 | 기준선 대비 증가 0. 각 사이클 D에서 `ratchet:update`로 기준선 회수 |
| 상태 소유권 | 각 decade 문서가 지정한 소유 모듈 배치대로, 인자로 새는 상태 0 |
| 금지 분할 | 각 decade 문서의 함정 항목 미발생 |
| 오라클·INV | 본문을 텍스트로 읽는 오라클의 읽기 경로 갱신 완료, INV 승계 모듈 지정 |
| 문서 | `structure/` 백틱 참조와 소유권 갱신, `bun run structure:check` 녹색 |
| 머지 | 6개 PR 전부 MERGED, `dev` 최종 CI 녹색 |

## 사이클 D에서 기록할 것

각 사이클은 D에서 다음을 이 단위에 남긴다. 남은 초과 파일 수, PR 번호와 head SHA, 관찰한 CI 실행 ID와 결론, 개선되지 않은 것과 죽은 가설(LOOP-PESSIMIST-01).
