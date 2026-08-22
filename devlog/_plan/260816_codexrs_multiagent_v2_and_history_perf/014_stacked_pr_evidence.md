# 014 — 스택 PR 개설과 레이어별 검증 증거

`origin/dev` 위에 4층 스택을 구성하고 PR 4개를 열었다. DEV-STACK-01/02/03 준수.

## 스택 구조 (bottom-up 병합)

| # | PR | 브랜치 | base | 커밋 | 논지 |
| ---: | --- | --- | --- | ---: | --- |
| 4 | [#1815](https://github.com/lidge-jun/opencodex/pull/1815) | `codex/compat-v2-five-cap` | `codex/compat-v2-daybreak` | 5 | 5-모델 창의 V1/V2 차이 문서화 + SoT 동기화 |
| 3 | [#1814](https://github.com/lidge-jun/opencodex/pull/1814) | `codex/compat-v2-daybreak` | `codex/compat-v2-roster` | 4 | daybreak 전역 네이티브 행 (소유자 결정) |
| 2 | [#1813](https://github.com/lidge-jun/opencodex/pull/1813) | `codex/compat-v2-roster` | `codex/compat-v2-docs` | 3 | 로스터 술어: `v1` 핀 = 자격 있는 리프 |
| 1 | [#1812](https://github.com/lidge-jun/opencodex/pull/1812) | `codex/compat-v2-docs` | **`dev`** | 2 | 상류 분석 문서만, 코드 없음 |

각 레이어가 자기 커밋만 담는지 확인 (`git log <lower>..<upper>`):

```
L2 over L1: df83829cd  feat(agents): treat a v1 pin as an eligible leaf subagent
L3 over L2: 926ca6cdd  feat(catalog): ship gpt-daybreak-blue-latest as a global native row
L4 over L3: 9a75124c1  docs(agents): document the five-model spawn_agent window...
```

base ref는 `gh pr list --json baseRefName` 로 되읽어 확인했다.

## 레이어별 독립 검증 (ssh lidge, Ubuntu 16-core)

DEV-STACK-03 "각 레이어는 자기 tip에서 빌드·테스트를 통과해야 한다"를 만족한다.
레이어마다 체크아웃 → `tsc` → 전체 스위트를 각각 돌렸다:

| 레이어 | SHA | `tsc --noEmit` | 전체 스위트 |
| --- | --- | --- | --- |
| L1 docs | `bba4b9669` | **0** | **12575 pass / 0 fail** |
| L2 roster | `df83829cd` | **0** | **12575 pass / 0 fail** |
| L3 daybreak | `926ca6cdd` | **0** | **12576 pass / 0 fail** |
| L4 five-cap | `9a75124c1` | **0** | **12576 pass / 0 fail** |

L3에서 pass가 1 늘어난 것은 daybreak 전역 행을 증명하는 신규 테스트
("ships as a global native row without an observation")가 추가되었기 때문이다.

L2 단독 포커스 검증도 별도로 수행: `multi-agent-compat` + `multi-agent-keep-native-v1` +
`codex-catalog-model-picker-order` = **69 pass / 0 fail**.

## 분할 방식

`729e2e4a2` 는 로스터 변경과 daybreak 변경을 한 커밋에 담고 있었으므로 파일 단위로 갈랐다:

- L2 ← `src/codex/catalog/sync.ts`, `tests/multi-agent-compat.test.ts`, 관련 devlog
- L3 ← `src/codex/catalog/native-models.ts`, daybreak 픽스처 4개 + `codex-catalog`/`native-model-toggle`

L4 tip을 원래 검증된 브랜치(`codex/compat-multiagent-v2-catalog`)와 diff한 결과, 차이는
`013_five_cap_v1_vs_v2.md` 와 `structure/03` 신규 섹션뿐이다 — 즉 **분할 과정에서 코드가
유실되거나 변형되지 않았다.**

## 주의: `main` 푸시 관찰

`git push` 중 `6abcd2631..e664647de main -> main` 이 함께 실행되었다. 확인 결과 로컬
`main` 에 이미 있던 **기존 유지보수 커밋**(`bitkyc08-arch` 작성, "Merge dev into main: bind
the retained usage window")이 fast-forward된 것으로, **이번 작업 커밋은 포함되지 않았다.**
그럼에도 의도치 않은 원격 상태 변경이므로 기록해 둔다. 이후 push는 전부
`refs/heads/<branch>:refs/heads/<branch>` 형태로 명시했다.

## 다음

병합은 bottom-up: #1812 → #1813 → #1814 → #1815. 하위 레이어가 수정되면 상위를
`git rebase --update-refs` 로 캐스케이드하고 `--force-with-lease` 로 재푸시해야 한다
(DEV-STACK-02). 병합은 사용자 결정 사항이며 이 작업에서는 수행하지 않았다.

여전히 열린 갭: G1b(default 모드 blanket 스탬프), G2, G12, G14 — `000_plan.md` 의 C2/C3 참조.

