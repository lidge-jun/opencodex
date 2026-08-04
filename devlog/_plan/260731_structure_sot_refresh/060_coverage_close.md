# 060 — WP6: 마감 감사 + Reading order 동기화

선행: WP1~WP5. 이 phase는 **감사 전용**이다(A 감사 블로커 14).
새 서술을 여기서 즉흥적으로 쓰지 않는다. 잔여 공백이 발견되면 그 내용을 담당 decade 문서에
수정으로 append하고 그 문서를 재감사한 뒤 해당 phase에서 적용한다. WP6이 스스로 편집하는 것은
아래 D2의 Reading order 표 한 곳뿐이다.

## 편집 대상

- MODIFY `structure/00_overview.md` (Reading order 표만)
- ADD `devlog/_plan/260731_structure_sot_refresh/070_closeout.md` (종료 요약 — 이 phase가 만드는 유일한 새 파일)
- 그 외 편집은 없다. 발견된 공백은 담당 decade 문서 수정 + 재감사 경로로 돌린다.

## D1. 잔여 공백 재측정

WP1~WP5 편집 후 `002_coverage_gaps.md`의 A~F를 다시 훑어 실제로 배치되지 않은 항목만 남긴다.
측정은 유닛 정본 스크립트만 쓴다. 임시 `rg` 루프는 쓰지 않는다(A 감사 R1 블로커 1, R2 블로커 11):

```bash
bash devlog/_plan/260731_structure_sot_refresh/004_measure.sh /tmp/ocx_wp6
cat /tmp/ocx_wp6/undocumented_dirs.txt
comm -13 /tmp/ocx_wp6/documented_routes.txt /tmp/ocx_wp6/registered_routes.txt   # 미기재 라우트
```

WP0 기준선(HEAD `286d24cbf`): `registered_route_literals 90`, `documented_route_literals 25`,
`doc_only_routes 0`, `dead_paths 0`, `brace_paths 0`, `undocumented_dirs 9`,
`initial_owned_paths 36`. WP6에서 기대하는 변화는 `documented_route_literals` 증가와
`undocumented_dirs` 감소이며, `doc_only_routes`·`dead_paths`·`brace_paths`는 계속 0이어야 한다.
이 스크립트가 증명하지 않는 것(메서드·형태·의미 일치)은 `000_plan.md` 서술 계약 5항을 따른다.

남은 항목의 처리 원칙:

- 불변 조건이 있는 것은 담당 decade 문서에 수정으로 추가하고, 그 phase를 재실행한다.
- 불변 조건이 없는 순수 구현 세부(내부 헬퍼 파일 등)는 넣지 않고, 넣지 않은 이유를 이 문서
  "판단 기록"에 남긴다. SOT는 파일 목록이 아니다.

## D2. Reading order 표 동기화

WP1~WP5가 절을 신설한 문서의 Purpose 셀을 갱신한다. 아래가 그대로 적용할 AFTER 행이다
(A 감사 R2 블로커 11·13: 개요가 아니라 축자 행). 나머지 행은 손대지 않는다.

```
| [`02_config-and-codex-home.md`](02_config-and-codex-home.md) | `CODEX_HOME`, the config surface, injection forms, profile files, restore rules, and Codex-home diagnostics. |
| [`03_catalog-and-subagents.md`](03_catalog-and-subagents.md) | Shared Codex catalog and per-catalog backups, account namespaces and pool rotation, model cache, effort ceilings, multi-agent surface mode, and subagent ordering. |
| [`05_gui-and-management-api.md`](05_gui-and-management-api.md) | Dashboard surfaces and the `/api/*` management surface, including which module owns each route area. |
| [`06_docs-and-release.md`](06_docs-and-release.md) | Public docs site, GitHub Pages, workflow map, branch and devlog policy, README ownership, and release flow. |
```

`03` 행이 필요한 이유: WP2가 계정·풀·캐시·effort·V2 내용을 `03`에 넣으므로 기존 Purpose
("Shared Codex catalog, Codex App picker, subagent ordering")가 내용을 덜 서술한다.

## D3. 문서 크기 판단 (`002` §G 미결 사항)

`04`가 35KB에서 더 커졌다면 분할 필요성을 판단한다. 기준은 크기 자체가 아니라
Writing rule의 "한 파일이 너무 넓어지면": 한 문서가 두 개의 독립적인 주제를 담고 있어서
독자가 자기 주제만 읽을 수 없을 때 분할한다.

분할한다고 판단되면 이 phase에서 옮기지 않는다. 분할은 `090_transport_split.md`를 새로 쓰고
감사를 받은 뒤 별도 work-phase(WP7)로 실행한다 — 감사받지 않은 대규모 문서 이동을 마감 phase에
끼워 넣지 않는다. 분할하지 않기로 하면 그 판단과 근거만 여기 남긴다.

## D4. 전체 게이트

```bash
bun x tsc --noEmit
bun test
bun run privacy:scan
git diff --check
```

`bun test`는 이 유닛에서 최소 한 번 전체로 돈다(문서 편집이 `repo-hygiene`·`privacy` 계열을
깨뜨리지 않음을 확인). WP1~WP5는 대상 테스트만 돌려도 된다.

## D5. `_fin` 승격은 이 유닛에서 하지 않는다

A 감사 블로커 9: `AGENTS.md:39-42`는 `_fin`을 "이미 공개 git 히스토리에 보이는 작업의 기록"으로
정의한다. 이 유닛의 범위는 로컬 커밋까지이고 푸시는 금지되어 있으므로, 로컬 커밋만으로는 그 조건을
만족하지 않는다. 유닛은 `_plan`에 남긴다.

대신 종료 요약 `070_closeout.md`를 `_plan` 안에 쓴다: 실제 정정 건수, 남긴 항목과 이유, 검증 증거,
work-phase별 커밋 해시, 그리고 "공개 랜딩 후 `_fin` 승격" 후속 항목.
승격은 관리자가 공개 랜딩 이후에 수행한다.

## 수용 기준

- `004_measure.sh`의 `undocumented_dirs`가 0이거나, 남은 항목마다 미기재 이유가 기록된다.
- `doc_only_routes`, `dead_paths`, `brace_paths`가 0이다.
- Reading order 표가 실제 문서 내용과 일치한다.
- `04` 분할 여부 판단과 잔여 항목 처리 결정이 `070_closeout.md`에 기록되고, 분할은 별도 감사·별도 phase(WP7)로 넘어간다.
- 전체 게이트 4개 통과.
- `070_closeout.md`가 존재하고 유닛은 `_plan`에 남는다.
