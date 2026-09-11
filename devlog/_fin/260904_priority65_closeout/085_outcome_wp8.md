# 085 — wp8 — 처분과 최종 회귀 증명

## 처분

| 대상 | 처분 |
|------|------|
| #3061 | close — `78c630a93`이 상위 구현을 이미 랜딩, 90초 예산으로도 실패해 전제 반증 |
| #3461 #3332 #3327 #3251 | close + `landed-via-maintainer`, 각각 랜딩 SHA와 변경 사유 코멘트 |
| #3348 | 근거 코멘트 — head `928841669` `failover.ts:627`에 410/413 hop 잔존, 체리픽 가능 조각 3개 명시 |
| #3389 | 근거 코멘트 — Bun 1.4.0에서 2청크 방출 후 리셋 시 리더가 0바이트를 관측하는 것 4/4 재현, 전제 반증 |
| #3329 | 근거 코멘트 — `coolComboTarget` 쿨다운 우선순위 무단 역전, 3조각 분할 제안 |
| #3425 | 근거 코멘트 — `liveHealthAccountIds`가 config 전체를 담아 가드 미발화, 질문을 삭제/재등록과 fixedAccount로 교체 |
| #3245 | 근거 코멘트 — 실패가 첫 POST 이전 지점이라 코드로 갈 곳 없음 |

## 최종 회귀 증명

| | SHA | Cross-platform CI |
|---|-----|-------------------|
| 세션 시작 | `2421e44ce` | **FAILURE** — macos `tests/codex-auth-context.test.ts:1461` |
| 최종 | `413227888` | **SUCCESS** |

회귀가 없을 뿐 아니라, 시작 시점이 이미 빨간색이었고 최종은 초록이다. 시작 상태를 먼저
확정하지 않았다면 "내가 깼는지"를 판정할 수 없었을 것이다.

랜딩 3건 모두 최종 `origin/dev`의 조상임을 `git merge-base --is-ancestor`로 확인했다.

## macOS flake 관찰

이번 유닛에서 macOS 잡이 두 번 실패했고 두 번 다 재실행으로 통과했다. 실패한 테스트는
`tests/codex-shim.test.ts`의 detached redispatch 하나와 `tests/lab-fabric-task.test.ts`의
CL-07 inactivity timeout 하나로, 둘 다 이 브랜치의 diff에 없는 파일이고 로컬에서는
각각 77/77, 49/49로 통과한다. 타이밍에 민감한 두 테스트가 macOS 러너에서 간헐적으로
무너진다는 뜻이고, 별도 조사 대상이다.

## 로컬 스위트

`bun run test`와 인자 없는 `bun test`는 이 유닛에서 **0회** 실행했다.
