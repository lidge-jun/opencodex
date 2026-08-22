# 040 — WP4: 릴리스 (dev 감사 → preview/main 승격 → 배포 검증)

의존: 010/020/030 전부 green. 감사 반영: 005 B10.

## 사전 문서 동기화 (B10)

docs-site의 372k 언급을 새 계약으로 갱신한다. 영어 원문과 각 로케일:

- `docs-site/src/content/docs/guides/codex-app-models.md` (+ ja/tr/zh-cn/zh-tw/ko/ru/fr)
- `docs-site/src/content/docs/guides/providers.md` (+ 로케일)
- `docs-site/src/content/docs/reference/configuration/providers.md` (+ 로케일)
- `docs-site/src/content/docs/getting-started/quickstart.md` (해당 로케일에 372k 언급 있음)

## 검증 (전부 exit 0)

```
bun run typecheck
bun run test
bun run lint:gui
cd gui && bun run lint:i18n
cd gui && bun run build
bun run privacy:scan
```

docs-site를 수정하므로 빌드 검증도 필수다 (R3#4):

```
cd docs-site && bun install --frozen-lockfile && bun run build
```

깨진 frontmatter, 죽은 링크, Astro 빌드 실패는 이 명령으로만 잡힌다.

`gui/dist`는 gitignored 산출물이지만 런타임/패키지가 서빙하므로 build 검증은 필수다.

## 절차

1. `git log --oneline main..dev` 전수 감사. 각 커밋을 릴리스 노트 관점에서 분류.
2. 위 검증 전부 green.
3. dev push 후 **정확한 head SHA**의 CI 성공을 `gh run list --commit <sha>`로 확인.
4. preview / main 승격은 저장소 정규 절차. 직접 `npm publish` 금지 —
   `scripts/release.ts` + `.github/workflows/release.yml` (OIDC)만 사용한다.
5. 배포 검증: 릴리스 워크플로 성공, 조상 관계(`git merge-base --is-ancestor`),
   `npm view opencodex dist-tags`, GitHub release/tag 존재.

## 수용 기준

로컬 성공이나 푸시 성공은 배포 완료가 아니다. 5번의 네 가지 원격 증거가 모두 있어야 DONE이다.
