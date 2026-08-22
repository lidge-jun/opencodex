# 015 — 스택 병합 완료와 dev 최종 검증

소유자(코드오너) 지시로 스택 4층 전부를 `dev` 에 병합했다.

## 병합 순서 (bottom-up, DEV-STACK 준수)

| 순서 | PR | 병합 시각 (UTC) | 병합 커밋 |
| ---: | --- | --- | --- |
| 1 | #1812 docs | 2026-08-16T05:42:04Z | `ead632749` |
| 2 | #1813 roster | 2026-08-16T05:42:32Z | `e516912e6` |
| 3 | #1814 daybreak | 2026-08-16T05:42:52Z | `aa585e742` |
| 4 | #1815 five-cap | 2026-08-16T05:43:12Z | `09bf1f1ef` |

각 하위 레이어가 병합된 뒤 상위 PR의 base를 `dev` 로 재타깃하고 병합했다
(`gh pr edit <n> --base dev`). 스택 순서를 어기지 않았다.

## 권한 처리

`Protect dev branch` 룰셋(id `20763889`)이 `required_approving_review_count: 1` +
`require_code_owner_review: true` 를 요구한다. PR 작성자와 코드오너가 동일인이라
self-approve가 불가능하므로, 룰셋에 이미 정의된 **admin bypass**
(`bypass_actors: [{actor_id: 5, actor_type: RepositoryRole, bypass_mode: pull_request}]`)를
`gh pr merge --admin` 로 사용했다. 권한 우회를 새로 만들지 않았고, 저장소가 이미 부여한
경로를 그대로 썼다.

**병합 전 확인한 것:** 4개 PR 모두 `mergeable: MERGEABLE`, 실패·대기 체크 **0건**
(`gh pr checks` 에서 pass/skipping 외 항목 없음). #1812만 `BLOCKED` 였는데 사유는
`REVIEW_REQUIRED` 였고 CI 실패가 아니었다.

## dev 최종 검증 (ssh lidge)

병합 후 `origin/dev` 를 체크아웃해 전체를 다시 돌렸다:

| 게이트 | 결과 |
| --- | --- |
| `bun x tsc --noEmit` | **exit 0** |
| `OCX_TEST_NO_QUEUE=1 bun scripts/test.ts` | **12576 pass / 0 fail** (`TEST_EXIT=0`) |

`dev` 에 실제 반영된 코드도 직접 확인:

```
$ git show origin/dev:src/codex/catalog/sync.ts | rg -A2 'isEligibleV2SubagentEntry'
121:export function isEligibleV2SubagentEntry(entry: RawEntry): boolean {
122-  return entry.multi_agent_version !== "disabled";

$ git show origin/dev:src/codex/catalog/native-models.ts | rg 'NATIVE_DAYBREAK_BLUE_MODEL,$'
61:  NATIVE_DAYBREAK_BLUE_MODEL,
```

devlog 유닛 19개 문서, `structure/03` 의 five-cap 섹션 모두 `dev` 에 존재한다.
네 레이어의 tip 커밋(`bba4b9669`, `df83829cd`, `926ca6cdd`, `86042ab5d`)이 전부
`origin/dev` 의 조상임을 `git merge-base --is-ancestor` 로 확인했다.

## 최종 상태

- **Luna 위임 가능**: `v1` 핀이 자격 있는 리프 워커로 인정되어 로스터에 진입한다.
- **비-OpenAI 라우팅 모델 위임 가능**: 상류 선택 경로에 벤더 게이트가 없음을 소스로 확인.
- **`gpt-daybreak-blue-latest` 전역 카탈로그 편입**: 관측 없이도 행이 존재한다.
- **5-모델 창의 V1/V2 차이 문서화**: 코드 변경 불필요, SoT에 기록.

## 남은 갭 (열린 상태)

`000_plan.md` 의 C2/C3: G1b(`default` 모드 blanket 스탬프 — `8a0de6c44` 가 고치지 않음),
G2(capability creation path), G12(fallback capability class — 암호화 NEW_TASK와 얽힘),
G14(`model_messages.multi_agent`, 상류 #38619).

원격 스택 브랜치 4개는 삭제하지 않고 남겨두었다(병합 이력 추적용).

