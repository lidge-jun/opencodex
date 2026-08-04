# WP1 — PR #437 Bun 요구사항 문서화

대상: PR #437 (CooperSheroy), head `86e963c6`. `git merge-tree` clean (tree `7e15334a`).
보안 경계 없음. 문서 전용.

## 적용 diff

```bash
git fetch origin pull/437/head:pr-437
git diff dev...pr-437 -- CONTRIBUTING.md README.md docs-site/src/content/docs/contributing.md | git apply -3
```

세 파일 각각에 아래 취지의 문단이 들어간다. 기여자 문구를 수정할 필요는 없다.
`README.md:67`의 최종 사용자 설치 안내와 모순되지 않는다.

- `CONTRIBUTING.md` — "Agent-facing repository and review rules" 문단 뒤, `## Pre-push hook` 앞
- `README.md` — `## Development` 헤딩 바로 뒤, `git clone` 블록 앞
- `docs-site/src/content/docs/contributing.md` — `## Setup` 뒤, `git clone` 블록 앞

공통 문장:

```
Source development requires the `bun` CLI on your `PATH`.
```

## 회귀 테스트

A-gate blocker 1 반영: 최초 안이 제안한 단일 루프는 GREEN이 될 수 없다. `README.md`에서
"published npm"과 "package's bundled" 사이에 줄바꿈이 들어가 `/published npm package/`가
매치되지 않고, README에는 `local Bun` / `checkout's scripts` 문구가 아예 없다.
실측 매트릭스: CONTRIBUTING 1/1, README **0/0**, docs-site contributing 1/1.
파일별 기대값으로 분리하고 공백 허용 정규식을 쓴다.

NEW: `tests/docs-bun-source-requirement.test.ts`

```ts
import { expect, test } from "bun:test";

const SHARED_REQUIREMENT = "Source development requires the `bun` CLI on your `PATH`";

/** Each file states the shared requirement, plus its own bundled-runtime distinction. */
const CASES = [
  {
    path: "../CONTRIBUTING.md",
    distinction: /published npm\s+package\s+bundles its own\s+Bun runtime/,
    contrast: /local Bun installation/,
  },
  {
    path: "../README.md",
    distinction: /published npm\s+package's bundled Bun runtime/,
    contrast: /installed `ocx` commands/,
  },
  {
    path: "../docs-site/src/content/docs/contributing.md",
    distinction: /published npm\s+package bundles its own\s+Bun runtime/,
    contrast: /checkout's scripts run through your local Bun installation/,
  },
] as const;

test("source development docs require a local Bun CLI while preserving the bundled-runtime distinction", async () => {
  for (const entry of CASES) {
    const text = await Bun.file(new URL(entry.path, import.meta.url)).text();
    expect(text).toContain(SHARED_REQUIREMENT);
    expect(text).toMatch(entry.distinction);
    expect(text).toMatch(entry.contrast);
  }
});
```

정규식의 `\s+`가 필수다. 세 파일 모두 해당 구절에서 줄바꿈으로 접혀 있다.

RED→GREEN 근거: 패치 전 세 파일 어디에도 `SHARED_REQUIREMENT` 문장이 없어 첫 파일의
첫 assertion에서 실패한다. 패치 후에는 세 파일 × 3 assertion이 모두 통과한다.

**B 단계 필수 절차 (RED 확인):** `git stash`는 쓰지 않는다. 워크트리에 사용자의 무관한
더티 작업이 있을 수 있어 통째로 스태시하면 그것까지 딸려간다 (A-gate R2 지적).
대상 3개 파일만 되돌렸다가 복원하는 가역 패치를 쓴다.

```bash
# RED: 문서 패치만 역적용
git diff dev...pr-437 -- CONTRIBUTING.md README.md docs-site/src/content/docs/contributing.md \
  | git apply -R
bun test tests/docs-bun-source-requirement.test.ts   # 실패해야 함

# GREEN: 되돌린 것을 다시 적용
git diff dev...pr-437 -- CONTRIBUTING.md README.md docs-site/src/content/docs/contributing.md \
  | git apply
bun test tests/docs-bun-source-requirement.test.ts   # 통과해야 함
```

정규식이 실제 파일 내용과 맞는지는 `git show pr-437:README.md`로 대조한다.
확인된 사실: README `:459-460`에서 "published npm" 다음에 줄바꿈이 오고
"package's bundled Bun runtime"이 이어진다. `\s+` 없이는 매치되지 않는다.

## 활성화 시나리오

조건 분기가 없는 문서 변경이라 활성화 대상 분기는 없다. 테스트가 세 파일 모두를
읽어 문구 존재를 직접 확인하는 것이 유일한 관찰 지점이다.

## 커밋

```
docs: clarify Bun CLI requirement for source development (#437)

Co-authored-by: Sheroy Cooper <sheroycoops@gmail.com>
```

## 검증

```bash
bun test tests/docs-bun-source-requirement.test.ts
bun run typecheck
```
