# 070 — WP4: backend 영속화(state v2) + update 보존 + SoT 갱신 + #166 댓글

## 목표

backend 선택(scheduler|native)이 설치 수명 전체에 걸쳐 보존되고, `ocx update`가
선택된 backend 그대로 재설치하며, 문서(SoT)가 실제 동작을 서술한다.

## 범위 재배치 (감사 WARN 9)

state **v2 스키마 + exported accessor는 WP3(060)에서 도입**된다 — 하나의 스키마
계약을 두 phase에 쪼개지 않기 위함. WP4는 그 위에서 (a) update 두 경로의 backend
전파, (b) 고아/충돌 탐지, (c) SoT/README, (d) #166 댓글을 담당한다.

## Diff-level 변경

1. **MODIFY** `src/service.ts` `ServiceInstallState` (:84-95):
   `version: 1 | 2`, NEW `backend?: "scheduler" | "native"`,
   NEW `winswVersion?: string`, `winswSha256?: string`(native일 때).
   `writeServiceInstallState(backend)` — version 2로 기록.
   `readServiceInstallState()` — v1 허용(legacy, backend 없음 → scheduler 간주).
   (이 항목은 WP3에서 선행 구현; WP4의 P에서 stale check로 재검증만.)
   **NEW export** `readServiceBackend(): "scheduler" | "native"` — update 코드가
   private `readServiceInstallState`에 접근할 유일한 통로(감사 blocker 4).
   **NEW export** `serviceReinstallArgs(): string[]` — `["service","install"]` 또는
   `["service","install","--native"]`를 backend에서 유도하는 순수 함수.
2. **MODIFY** `stopServiceIfInstalled`/`uninstallServiceIfInstalled`/
   `serviceStatusSummary` (:619-681) — **state와 무관하게 양쪽 backend를 항상
   질의**(감사 blocker 5): schtasks TASK 존재 → scheduler 정리, winsw status
   `NonExistent` 아님 → native 정리. 둘 다 존재하면 충돌로 보고하고 둘 다 stop.
   (stop은 안전하므로 항상-양쪽; uninstall은 state 우선 + 고아 탐지 보조.)
3. **MODIFY** `src/update/index.ts` (:196-200) — 서비스 재설치 스폰이
   `serviceReinstallArgs()`를 사용. `isServiceInstalled()`는 기존 의미 유지(어느
   backend든 true).
   **MODIFY** `src/update/job.ts` (:158 `restartCommand`, :299 `restartAfterUpdate`)
   — GUI/백그라운드 업데이트 경로도 `service install`을 하드코딩하지 말고
   `serviceReinstallArgs()`를 사용(감사 blocker 4). `tests/update-job.test.ts:91`의
   고정 기대값도 함께 갱신.
4. **MODIFY** `bakedServicePathsDiagnostic` — native일 때 winswExePath 존재도 검사.
5. **SoT 갱신**:
   - `README.md:65` Windows 행 — "Task Scheduler (hidden) / opt-in native service
     (`--native`, WinSW)"로 갱신, known limitation 문구(logon 시작; native는 boot).
   - `README.md:237` — "starts on boot" 문구를 플랫폼 정확하게 수정(mac/linux는
     login/boot 각각, Windows 기본은 logon, `--native`는 boot).
   - `docs/codex-path-investigation.md` Windows 절 — hidden 런처 + `--native` 반영.
   - `ocx service --help`/usage 문자열 — `--native`/`--scheduler` 문서화.
6. **#166 댓글** (`gh issue comment 166`): 방향 결정(sol 검토 요지 — 창 없는
   Scheduler 기본 + `--native` 옵트인 + 영속화, WinSW 기본 승격은 실측 후),
   구현 커밋 요약, Windows 실측 요청 매트릭스(040 §실측).

## 테스트

- state v2 라운드트립(backend 보존), v1 읽기 호환(→scheduler) — WP3 스위트 재검증.
- `serviceReinstallArgs()` 단위 테스트(scheduler/native/state 부재).
- `src/update/index.ts`와 `src/update/job.ts` **양쪽**이 serviceReinstallArgs를
  쓰는지(소스 문자열 검사), `tests/update-job.test.ts` 기대값 갱신.
- 고아/충돌 탐지 분기(양쪽 질의, 둘 다 존재 시 충돌 보고) — mock 테스트.

## 완료 기준

tsc + service/winsw/update 관련 스위트 green, README/docs 갱신 diff 존재,
#166 댓글 URL 확보, 로컬 커밋.
