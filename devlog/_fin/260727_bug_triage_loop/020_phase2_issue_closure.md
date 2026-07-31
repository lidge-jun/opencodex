# 020 — WP2: 이슈 종결

근거: `001_issue_triage_matrix.md`, `003_claude_desktop_path_rca.md`
선행: WP1 (푸시 SHA가 #539 종결의 근거이므로)

## 종결 원칙

근거 없는 종결 금지. 모든 close는 다음 중 하나를 코멘트로 동반한다:

- 수정을 담은 커밋 SHA와 해당 코드의 위치
- 왜 이 저장소의 결함이 아닌지에 대한 코드 인용

"고쳐진 것 같다"는 종결 사유가 아니다.

## 대상 1: #511 — Grok Build 200k

상태: CLOSE-READY

근거 커밋:

- `5ff20dc0` fix(grok): adopt our own pre-fence model entries so context windows are honoured
- `7ba0fec3` fix(grok): sweep an orphan's sub-tables too, not just its parent

두 커밋 모두 `origin/main`에 있었고 2026-07-27 pull로 `dev`(`f327db1e`)에도 포함됐다.
`git rev-list --left-right --count origin/main...origin/dev` = `0 122` — main-only 커밋
0건이므로 `dev`가 main을 완전히 포함한다.

구현 확인 (`src/grok/inject.ts`):

| 심볼 | 역할 |
|------|------|
| `findOpencodexOrphans` (174) | 관리 블록 밖 opencodex 소유 엔트리 탐지 |
| `removeOrphanTables` (210) | 탐지된 orphan 제거 (역순 slice로 인덱스 보존) |
| 221행 주석 | adopted orphan을 `[models] default`가 가리킬 때의 재지정 처리 |

이슈 본문이 지적한 두 가지 실패 동작이 모두 해소된다: (1) 마커 밖 영역 미수정,
(2) `userModelAliases`가 자기 소유 별칭을 사용자 소유로 오인해 `-2` 접미사 중복 생성.

이미 메인테이너 코멘트(2026-07-26T18:36)가 소유권 판정을 conjunctive로 설계한 근거를
설명해 두었다. 종결 코멘트는 그 위에 "`dev`에도 반영 완료"를 더한다.

코멘트 문안:

> Fixed and now on `dev` as well (`f327db1e` includes `5ff20dc0` + `7ba0fec3`).
>
> `src/grok/inject.ts` now detects opencodex-owned entries outside the managed block
> (`findOpencodexOrphans`), removes them (`removeOrphanTables`), and re-points
> `[models] default` when the adopted orphan was the default target. Sub-tables of an
> orphan are swept together with their parent.
>
> Please re-run `ocx sync` and confirm the duplicate `-2` aliases are gone and the
> context window reads 372k / 500k instead of Grok's 200k fallback. Reopen if it
> persists.

## 대상 2: #539 — Desktop 3P 경로

상태: FIX-NOW → WP1 완료 후 종결

종결 전 필수: WP1의 커밋이 `dev`에 푸시되어 있어야 한다. 그 SHA가 근거다.

코멘트에 반드시 포함할 것 — **제보자의 진단 정정**. 이유를 밝히지 않고 다른 수정을
하면 제보자는 자기 보고가 무시됐다고 느낀다:

> Thanks for the detailed report — the symptom is real, but the diagnosis needs one
> correction, and it changes the fix.
>
> `Claude-3p` is Desktop's own default, not our mistake. The reason you only found one
> string match in `app.asar` is that the directory name is assembled at runtime:
>
> ```js
> const Bu = "-3p", zW = "Claude", ND = `${zW}${Bu}`;
> function GE(){
>   if (process.env.CLAUDE_USER_DATA_DIR) return app.getPath("userData");
>   if (process.platform === "win32" && process.env.LOCALAPPDATA) return join(process.env.LOCALAPPDATA, ND);
>   const t = app.getPath("userData");
>   return t.endsWith(Bu) ? t : `${t}${Bu}`;
> }
> ```
>
> So switching the hardcoded segment to `Claude` would break every user for whom the
> current path already works.
>
> The actual defect is that we implemented only the third branch. When
> `CLAUDE_USER_DATA_DIR` is set, Desktop drops the `-3p` suffix entirely — which is
> almost certainly why your workaround worked. On Windows we were building a
> `~/Library/Application Support/...` path that cannot exist.
>
> Fixed in <SHA>: path resolution now mirrors `GE()` for all three branches, and the
> status API also reports whether `_meta.json`'s `appliedId` actually points at our
> profile (Desktop reads only that one, so an unapplied opencodex entry used to be
> reported as applied).

`<SHA>`는 WP1 푸시 후 실제 값으로 대체한다.

## 대상 3: #241 재평가

WP1 후 확인. "라우팅 모델이 Desktop 모델 피커에 미표시"가 경로 결함의 하위 증상이면
`upstream-tracking` 라벨이 잘못된 것이다. 판정만 하고, 확실하지 않으면 라벨을 건드리지
않는다.

## 하지 않는 것

- `needs-info` 3건(#462, #521, #509): `stale-needs-info.yml`이 처리한다. 수동 종결하면
  그 워크플로가 실제로 동작하는지 확인할 기회를 잃는다.
- `upstream-tracking` 4건: 정의상 이 저장소 수정으로 닫히지 않는다.
- `roadmap` 기능 요청: 버그 루프의 대상이 아니다.
