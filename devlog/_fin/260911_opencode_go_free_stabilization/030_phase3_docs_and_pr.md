# 030 — wp4: 문서 동기화와 PR 게시

## 문서

`noStructuredOutputModels`는 이미 `docs-site/src/content/docs/reference/configuration/providers.md`와 각 로케일에 설명이 있다. 이번 변경은 그 옆에 **새 필드 `noJsonSchemaModels`** 를 추가하고, opencode go/zen/free 프리셋이 이를 기본으로 싣는다는 사실을 적는다.

| 파일 | 변경 |
| --- | --- |
| `docs-site/src/content/docs/reference/configuration/providers.md` | `noStructuredOutputModels` 항목 바로 뒤에 `noJsonSchemaModels` 항목 추가: json_schema만 json_object로 낮추고 json_object는 건드리지 않는다, 두 필드가 함께 있으면 `noStructuredOutputModels`가 우선한다, opencode go/zen/free 프리셋이 Zen 게이트웨이의 DeepSeek id에 기본 시드한다 |
| `docs-site/src/content/docs/ko|ja|fr|ru|tr|zh-cn|zh-tw/reference/configuration/providers.md` | 같은 항목의 로케일 번역. 영문 원문과 모순되지 않게 유지 |

로케일 파일이 영문과 구조가 다르면 해당 위치에만 맞춰 넣고, 번역이 불가능한 항목은 영문 문장을 그대로 두지 않는다.

## PR

- base `dev`, head `codex/260911-opencode-go-free-stabilization`
- 템플릿 3개 섹션(Summary / Verification / Checklist) 전부 채운다
- 본문에 반드시 포함: 닫는 이슈가 아니라 **묶음의 근거**(#1338, #1415, #1424, #2410), Zen Go의 `json_object` 수용 여부가 unverified라는 점과 그래서 킬스위치 대신 낮추기를 택한 이유, 라이브 프로브 불가로 시드하지 않은 항목(`deepseek-v4.1-flash`), PR #4258과의 비충돌(파일 교집합 없음)
- `gui` 단어를 제목/본문에 쓰지 않는다(스크린샷 게이트 유발)
- `Closes #`는 쓰지 않는다. 이 PR이 단독으로 닫는 열린 이슈는 없다

## 검증

```
bun run typecheck
bun run test
bun run privacy:scan
```

PR을 review-ready로 올리기 전 전체 스위트를 돌린다(AGENTS.md PR-ready 게이트).
