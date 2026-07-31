# 260720_windows_service — Windows 서비스 콘솔 창 문제: 조사 + GitHub 이슈 2건 등록

## Objective

`ocx service install`이 Windows에서 만드는 Task Scheduler 태스크가 사용자 세션에
콘솔 창을 띄우고, 사용자가 그 창을 닫으면 프록시가 죽어 Codex의 모든 모델(GPT 포함)
연결이 끊기는 문제를 문서화하고, 조사 결과를 근거로 GitHub 이슈를 버그/개선 2건으로
분리 등록한다. 이 유닛은 문서화+이슈 등록까지만 다룬다 (코드 수정은 후속 유닛).

## Trigger (사용자 제보)

DC 갤러리 제보 (2026-07-15): "on Windows … closing the proxy's console window can
make every model (even gpt models) disconnect". 댓글 스레드에서 원인 후보가 이미
정확히 지목됨:

- "윈도우에서 서비스로 설치해도 cmd창 떠서 작업스케줄러 설정에서 로그인하지 않아도
  실행하기로 옵션 바꿔주고 비밀번호 넣어줘야 창 사라짐"
- "애초에 진짜 서비스로 설치된 게 아니라서 그럼"
- "nssm으로 등록하면 해결될 거 같긴 함"

## Work-phase map (dependency-ordered)

| Phase | Doc | Deliverable |
|-------|-----|-------------|
| WP1 (docs-only) | `001_research.md` | 근본 원인 분석 + 대안 비교 + 현재 코드 인벤토리 |
| WP1 (docs-only) | `010_issue_bug_console_window.md` | 버그 이슈 초안 (등록용 최종 문안) |
| WP1 (docs-only) | `020_issue_feature_windowless_service.md` | 개선 이슈 초안 (등록용 최종 문안) |
| WP2 | `030_issue_submission.md` | gh issue 2건 등록 결과(URL) 기록 |

## Scope boundary

- IN: devlog 문서 4건, `gh issue create` 2건 (lidge-jun/opencodex), 로컬 커밋.
- OUT: `src/service.ts` 등 코드 수정, git push, 릴리스. 워크트리의 기존 dirty
  변경(`gui/src/pages/Models.tsx`)은 건드리지 않는다.

## 문서별 diff-level 내용 계획

### 001_research.md

1. **증상과 재현 경로** — `ocx service install` → `opencodex-service.cmd` 콘솔 창
   노출 → 창 닫기(대표 재현; logoff/작업관리자 종료도 같은 계열의 강제 종료) →
   Windows가 콘솔의 모든 프로세스에 `CTRL_CLOSE_EVENT` 전달, 기본 핸들러가 프로세스
   종료(MS Learn HandlerRoutine) → 래퍼가 Bun을 동기 실행하므로(src/service.ts:320
   `"%OCX_BUN%" "%OCX_CLI%" start`) 래퍼+프록시가 같은 콘솔 수명에 묶여 함께 사망
   → Codex가 바라보는 localhost 프록시 부재 → 모든 모델 disconnect.
   **needs-verification**: 이 종료가 Task Scheduler에서 실패로 기록되어
   `RestartOnFailure`(PT1M x3)가 발동하는지는 미확인 — 공식 문서는 "task failure 시
   재시작"만 정의. Windows 실측 관측 항목: `LastTaskResult`, TaskScheduler
   Operational 이벤트 로그, 래퍼/자식 PID, 프록시 health, PT1M 후 재시작 여부.
2. **근본 원인 (조합)** — (a) `buildWindowsTaskXml()`(src/service.ts:352)의
   `<LogonType>InteractiveToken</LogonType>`이 태스크를 대화형 세션에서 실행하고,
   (b) task action이 콘솔 프로그램인 `.cmd` 배치를 직접 실행하며(src/service.ts:375),
   (c) 창을 숨길 hidden-launch 메커니즘이 없다. 셋의 조합이 원인이며 InteractiveToken
   단독이 아니다. 주의: `<Hidden>`은 Task Scheduler UI에서 태스크를 숨기는 설정일 뿐
   콘솔 창과 무관(MS Learn TaskSettings.Hidden). `windowsHide: true`(src/service.ts:251)
   는 `schtasks.exe` 관리 호출에만 적용되고 등록된 태스크 실행에는 영향 없음.
   래퍼의 "runs in its own hidden console" 주석(src/service.ts:298)은 실제 동작과
   모순 — 문서에 명시.
3. **`ocx stop`과의 대비** — stop 경로(src/cli/index.ts:267 이후 handleStop)는
   `stopServiceIfInstalled()` → graceful drain(`stopProxy`) → 네이티브 Codex 복원
   순서로 수행하므로 문제가 없다. 대표 문제 경로는 콘솔 창 닫기류의 강제 종료.
4. **대안 비교** — (A) LogonType S4U: 비대화형 실행이라 창이 뜨지 않음. 단 "확정
   권장안"이 아닌 후보: 실행 계정 `Log on as a batch job` 권한 필요, 네트워크
   자격증명/EFS 접근 불가(MS Learn security-contexts), 현재 XML에 명시적 `UserId`가
   없어 단순 문자열 교체의 안정성 미검증, Microsoft 계정 passwordless 등록 호환성
   미확인. 검증 매트릭스(로컬 계정/MS 계정/EFS/UNC·custom home/기업 정책/프로필 환경
   로딩)를 Feature 이슈에 수용 기준으로 포함. (B) WinSW: 진짜 SCM 서비스 래퍼,
   선언형 XML/로그 롤링 공식 지원, 저장소는 2026년에도 활동 중 — 단 최신 stable은
   v2.12.0(2023), 3.x는 prerelease 계열임을 정확히 표기하고 배포 비용/관리자 권한
   요구를 명시. (C) NSSM: 커뮤니티 제안이며 여전히 동작하나 공식 정식판 2.24
   (2014-08-31), 추천 prerelease도 2017년 — "abandoned/unsafe" 단정은 하지 않되
   신규 채택 후보로는 WinSW 대비 열위로 서술. (D) sc.exe 단독: Node/Bun 프로세스가
   SCM 핸드셰이크를 구현하지 않아 부적합. 각 항목 MS Learn/공식 출처 링크.
5. **현재 코드가 이미 갖춘 것 인벤토리** — `MultipleInstancesPolicy=IgnoreNew`
   (src/service.ts:357, 중복 방지), `RestartOnFailure PT1M x3`(:368),
   래퍼 배치의 5s 재시작 루프(ping 지연, :325), `writeServiceAssetWithRetry`
   (EBUSY 재시도), `bakedServicePathsDiagnostic`(스테일 경로 진단), `OCX_SERVICE=1`
   재주입 계약. 빠진 것: "창이 안 보이고 창 닫기로 죽일 수 없는" 실행 모드 +
   비정상 종료 시 재시작 보장(실측 필요).

### 010_issue_bug_console_window.md

이슈 제목: `[Bug]: Windows 서비스 설치 시 콘솔 창이 표시되고, 창을 닫으면 프록시가
죽어 모든 모델 연결이 끊김`. 본문은 저장소 bug_report.yml 템플릿 섹션을 그대로 따름:
## Summary / ## Reproduction / ## Logs and screenshots / ## Area / ## Version /
## OS / ## Config shape / ## Checks (issue #160과 동일 골격). 내용: 증상 → 근본
원인 조합(InteractiveToken + 콘솔 배치 직접 실행 + hidden-launch 부재, 코드 참조)
→ 재현 절차 → RestartOnFailure 발동 여부는 needs-verification으로 관측 항목 명시
→ `ocx stop` 대비 → 기대 동작(창 미노출 또는 강제 종료에도 프록시 생존/재시작).
Bug 이슈는 관측 증상·재현·사용자 영향만 소유; 설계 선택은 020 이슈로 링크만.

### 020_issue_feature_windowless_service.md

이슈 제목: `[Feature]: Windows에서 창 없는 백그라운드 서비스 실행 모드`
(feature_request.yml의 공식 prefix `[Feature]:` 준수). 본문은 템플릿 섹션
(Problem to solve / Proposed solution / Alternatives considered / Additional
context)을 따름. 내용: 옵션 A(S4U 후보 — 창 제거 효과는 확실하나 검증 매트릭스
통과 전제: batch logon right, UserId 명시, MS 계정 passwordless, EFS/UNC/기업
정책, 프로필 환경 로딩) vs 옵션 B(WinSW — 진짜 SCM 서비스, stable 2.12.0(2023)/
3.x prerelease 표기, 배포·관리자 권한 비용) vs 참고(NSSM 2.24 — 동작하나 릴리스
정체) 트레이드오프 표. 확정 권장안 대신 "A를 우선 검증, 실패 시 B" 순서 제안.
수용 기준에 README 서비스 시맨틱 정정 포함(README.md:237 "starts on boot"는 실제
logon trigger(src/service.ts:345-348)와 불일치 — Windows 한정 known limitation
문구 갱신).

## Accept criteria (this unit)

- [ ] 001/010/020 문서가 이슈-ready 수준으로 존재하고 근거 출처가 링크됨
- [ ] 010/020이 근본 원인을 "조합"으로 서술하고 InteractiveToken 단독 단정이 없음
- [ ] RestartOnFailure 미재시작 주장이 needs-verification + 관측 항목으로 표기됨
- [ ] S4U가 후보로 서술되고 검증 매트릭스가 020 수용 기준에 포함됨
- [ ] 이슈 제목 prefix가 템플릿(`[Bug]:`/`[Feature]:`)과 일치
- [ ] sol 리뷰어 감사 VERDICT PASS 또는 GO-WITH-FIXES(fold-back 완료)
- [ ] gh issue 2건 등록, `gh issue view`로 확인
- [ ] 030에 URL 기록 + devlog 유닛 로컬 커밋

## Verifier

`ls devlog/_plan/260720_windows_service/`, 리뷰어 verdict 원문,
`gh issue view <n> -R lidge-jun/opencodex --json url,title`, `git log -1`.

## SoT sync target

`docs/codex-path-investigation.md`의 Windows 서비스 절과 README의 지원 플랫폼 표는
이번 유닛에서 변경하지 않는다(코드 미변경). 단 README.md:237 "starts on boot"와
실제 logon-trigger 동작의 불일치는 사용자-facing 모순이므로, 020 Feature 이슈의
수용 기준에 README 갱신을 명시해 후속 코드 유닛에서 SoT를 함께 정리한다.

## Audit record (round 1)

- 리뷰어: sol explorer 서브에이전트 (gpt-5.6-sol/high, agent 019f7b2c-fd12).
- VERDICT: GO-WITH-FIXES (blockers=3).
- 블로커 fold-back: (1) 근본 원인을 조합으로 수정, (2) RestartOnFailure 주장
  needs-verification 강등 + 관측 항목 명시, (3) S4U 후보 강등 + 검증 매트릭스.
- WARN 수용: 템플릿 섹션/제목 prefix 일치, NSSM/WinSW 릴리스 신선도 정확 표기,
  README 시맨틱 정정을 020 수용 기준에 포함, "대표 재현은 창 닫기" 표현.
- INFO 확인: 중복 이슈 없음(#30 graceful drain, #63 WSL은 별개), 2-이슈 분리 적절
  (Bug=증상/재현/영향, Feature=설계 선택/수용 기준 소유).
