# 010 — 라이브 상태 실측 스냅샷 (WP1)

측정: 2026-07-28 KST 저녁, `gh` + `git` 실측. 기억이나 이전 원장 인용 아님.

## 1. 브랜치 / 리모트

`git fetch origin --prune` 후:

| 브랜치 | 로컬 | origin | 관계 |
| --- | --- | --- | --- |
| `dev` | `7710185c0` | `7710185c0` | 동일 (FF 4커밋 적용) |
| `main` | `7cb15bff4` | `7cb15bff4` | 동일 |
| `preview` | `b04b8729e` | `b04b8729e` | 동일 |
| `dev2-go` | `2bdb748e1` | `2bdb748e1` | 동일 |

`origin/dev` 기준 ahead/behind (`git rev-list --left-right --count origin/dev...<b>`):

| 브랜치 | origin/dev만 가진 것 | 해당 브랜치만 가진 것 |
| --- | --- | --- |
| `main` | 42 | 3 |
| `preview` | 42 | 4 |
| `dev2-go` | 188 | 335 |

`main`/`preview`가 `origin/dev`에 없는 3~4 커밋을 가진 건 릴리스 프로모션 이력이라
정상이다. `dev2-go`의 335는 Go 포트 라인 고유 작업이다.

### FF로 흡수한 4커밋

```
7710185c0 fix stale update jobs and combo quota fallback
d482086bf fix(windows): grant owner ACE before ACL inheritance removal (#601)
406a522fe refactor(responses): single-pass SSE payload rewrite composition (#602)
c380ef72a feat(auth): account pool round-robin and fill-first strategies (#593)
```

45파일 +3407/-331. rebase/reset 없이 `git merge --ff-only`만 사용했다.

### 워크트리 (11개, 전부 보존)

`260727-live-triage`, `260727-pr533-current`, `260727-pr551-image-relay`,
`260728-pr527`, `260728-preview`, `404d`(main), `6cce`(dev2-go),
`e4f5`(go-tray-daemon), 그리고 detached 2개 + macos-app.
이 유닛은 메인 워크트리에서만 작업한다.

## 2. 열린 PR — 15건 실측

| # | base<-head | mergeable | state | 실패 체크 | 작성자 |
| --- | --- | --- | --- | --- | --- |
| 611 | dev<-feat/volcengine-providers | MERGEABLE | UNSTABLE | — | yrooogerg |
| 610 | dev<-fix/catalog-runtime-probe-cache | MERGEABLE | UNSTABLE | — | mihneaptu |
| 607 | dev<-fix/gui-chrome-forms (draft) | MERGEABLE | UNSTABLE | ubuntu, macos | Wibias |
| 599 | dev<-fix/codex-spark-quota-scope | MERGEABLE | UNSTABLE | — | akrock |
| 583 | dev<-chore/agent-guidance-hardening | MERGEABLE | CLEAN | — | Wibias |
| 582 | dev<-feat/video-bridge-v2 (draft) | MERGEABLE | CLEAN | — | tizerluo |
| 581 | dev<-feat/zh-tw-localization | CONFLICTING | DIRTY | — | letr1n1ty |
| 576 | dev<-codex/pr527-rebase | CONFLICTING | DIRTY | windows | lidge-jun |
| 575 | dev<-codex/260728-tls-altname-diagnosis | MERGEABLE | CLEAN | — | lidge-jun |
| 569 | dev<-agent/macos-post-sync-readiness (draft) | CONFLICTING | DIRTY | — | diegocantarero |
| 565 | dev<-agent/codex-account-pause | CONFLICTING | DIRTY | — | Alvin0412 |
| 562 | dev<-feat/modelsell-provider (draft) | MERGEABLE | UNSTABLE | — | modelsell |
| 557 | dev<-codex/pr533-update-recovery-hardening (draft) | CONFLICTING | DIRTY | — | lidge-jun |
| 533 | dev<-fix/gui-update-install-failure-recovery (draft) | CONFLICTING | DIRTY | CHANGES_REQ | WZBbiao |
| 512 | dev<-split/426-01-namespace-foundation | MERGEABLE | CLEAN | — | chrisae9 |

전부 base=`dev`. 잘못 타깃된 PR 없음 → AGENTS.md 브랜치 타깃 규칙 위반 0건.

> A 게이트 정정: 최초 측정에서 #569/#562/#512가 `UNKNOWN`으로 잡혔던 것은 GitHub이
> mergeable을 비동기 계산 중이었기 때문이다. 재폴링 결과를 위 표에 반영했다.

우리 소유 PR 3건: #575(CLEAN, 머지 대기), #576(CONFLICTING + windows 체크 실패),
#557(draft, CONFLICTING).

## 3. 열린 이슈 — 27건, `--label bug` 필터로 14건

```
612 608 606 604 591 586 570 553 545 543 418 417 241 92
```

enhancement/roadmap/upstream 계열 13건은 이 유닛의 처리 대상이 아니다.

## 4. 원장 델타 — 이전 문서가 틀린 것

| 이전 기재 | 현재 사실 |
| --- | --- |
| `260728_bug_bundle_resolution` WP2 = 진행 예정 | **완료**. `e2da6f6df` → PR #573 머지 (`3a2b2ea8c`) |
| `007_delta` 기준 `origin/dev`=`461de3961` | `7710185c0` (그 뒤 다수 머지) |
| 열린 PR 15 (ready 5 / draft 10) | 열린 PR 15 (ready 9 / draft 6) — 구성이 다름 |
| 열린 이슈 23 | 27 |
| needs-info 3 (`462,543,553`) | **4** (`591,553,543,462`). #462는 `upstream-tracking`을 **추가로** 얻었을 뿐 `needs-info`를 잃지 않았고, #591도 이미 needs-info다 |

### 07-27 저녁 이후 머지된 PR 20건

`602 601 600 597 595 594 593 589 588 585 580 579 578 577 574 573 571 568 567 566`

### 07-27 저녁 이후 클로즈된 이슈 (해결 완료) 주요 항목

`609 605 603 598 596 592 590 587 584 563 560 549 548 547 546 542 541 539 538`

## 5. 이슈 ↔ 코드 대조 결과

| 이슈 | 코드 현황 | 판정 |
| --- | --- | --- |
| #570 | `src/server/auth-cors.ts:51` `isLoopbackRequestHost`가 포트 비교를 제거하고 hostname만 검사. `tests/server-loopback-host-gate.test.ts:16`이 `localhost:20100`/`127.0.0.1:20100`/`[::1]:20100`을 통과로 고정 | **부분 해결 — 6항목 중 1(a)/2만. alias(항목 4)는 여전히 403. 클로즈는 `NEEDS_HUMAN` → `020_issue_disposition.md` §A** |
| #612 | `src/lib/windows-secret-acl.ts:79` 여전히 `Bun.spawnSync(["icacls.exe"...])` 동기 호출 | 미해결 |
| #608 | `src/service.ts:1080`이 `taskXmlString()`(`"`→`&quot;`)로 이스케이프한 문자열과 원문 XML을 `includes()` 비교 | 미해결, 원인 확정 |
| #606 | `src/codex/catalog/bundled.ts:146` `loadBundledCodexCatalog`가 캐시 히트 판정 전에 `resolveAndPersistCodexRuntime`(→ `--version` 프로브, `timeout: 8_000`)를 호출. cacheKey 자체가 프로브 결과로 만들어지는 구조 | 미해결, PR #610이 이미 제출됨 |
| #586 | `src/server/management/provider-routes.ts:137` PATCH 엔드포인트 존재. GUI에는 `CodexAuth.tsx` 배너만 있고 전환 컨트롤 없음 | 미해결 |
| #604 | 재현 정보가 Cursor Auto + PowerShell 5.1 환경 의존 | 리포터 대기 |
| #591 | `schtasks.exe /create` 권한 거부. 리포터는 **관리자 권한으로는 설치에 성공**했고 그 이후 사용에서 문제가 남는다고 후속 코멘트에 적었다. Ingwannu가 이미 ccswitch 충돌 부정 + 추가 정보 요청 코멘트를 남겼고 `needs-info` 라벨도 붙어 있다 | 리포터 응답 대기 (추가 코멘트 불필요) |
| #553 | PR #575(OPEN, MERGEABLE/CLEAN)가 진단 메시지 **분류**를 분리. TLS altname 불일치 자체는 미해결 | PR 대기 + 잔여 결함 |
| #545 | 메인테이너가 OAuth identity 제거를 안전하지 않다고 판정 | NEEDS_HUMAN |
| #543 #418 | 리포터 캡처 대기 | BLOCKED |
| #92 #241 #417 | 업스트림 | BLOCKED |
