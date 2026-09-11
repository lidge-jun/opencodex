# 미해결 리뷰 스레드 원장 — 33건

`gh api graphql`로 `isResolved=false` 스레드를 전수 조회했다(2026-09-01).
각 건에 소유 단계를 배정한다. 소유 단계 = 그 결함을 처음 도입한 단계.

> **공개 시점에 관한 기록.** 이 문서는 스택이 `dev`에 머지된 뒤에 공개됐다.
> 여기 적힌 P1들은 전부 소유 단계에서 수정된 뒤 그 수정과 함께 랜딩했으므로,
> 이 원장은 미수정 결함의 사전 공개가 아니라 이미 공개 diff가 드러낸 것의
> 사후 기록이다. `AGENTS.md`의 판정 기준("이미 이 약점을 드러내는 공개 diff가
> 있는가")을 그대로 적용한 결과다. 특히 T20(미인증 바디 버퍼링)의 수정은
> `b7282858b`로 #2776(`39e5aefb6`)에 실려 들어갔고, `dev`의
> `src/server/index.ts`에서 `declaredLength` 하드 캡으로 확인된다. 수정 전에
> 이 문서를 머지했다면 규정 위반이었다 — 실제로 그 순서로 계획했다가 리뷰
> 지적을 받고 뒤집었다(`112_wp2_order_reversal.md`).

## #2771 design — 18건

대부분 CodeRabbit의 마크다운 린트(MD018/MD022, 테이블 파이프 이스케이프)와
문서 계약 지적이다. 실질 건만 추린다.

| # | 위치 | 등급 | 요지 | 배정 |
| --- | --- | --- | --- | --- |
| T1 | 000_research.md:22 | **P1** | 미공개 보안 분석이 추적되는 공개 devlog에 있다 | wp1 |
| T2 | 060_phase4_two_plane.md:348 | P2 | 연결된 GUI에 인증된 models 경로 필요(`/v1/models`가 데이터플레인으로 감) | wp5 |
| T3 | 070_phase5_deploy.md:164 | P2 | 관리 ingress에서 GUI health 엔드포인트 보존 | wp6 |
| T4 | 040_phase2_remote_session.md:19 | Major | D1과 동일 사안 | wp1+wp3 |
| T5 | 030_phase1_protocol_catalog.md:40 | Minor | D2와 동일 사안 | wp1+wp2 |
| T6 | 060_phase4_two_plane.md:305 | Major | D3과 동일 사안 | wp1+wp5 |
| T7 | 060_phase4_two_plane.md:431 | Major | 요약 경로 보안 | wp5 |
| T8 | 080_phase6_hardening.md:323 | Major | D4와 동일 사안(교체 이전 크래시) | wp1+wp7 |
| T9 | 080_phase6_hardening.md:501 | Major | D5 — 릴레이 응답 validator 보존 | wp1+wp5 |
| T10 | 050_phase3_connect.md:308 | Major | 데이터 정합 | wp4 |
| T11 | 070_phase5_deploy.md:300 | Major | 안정성 | wp6 |
| T12-T18 | 010/020/060/070 각처 | Minor | 마크다운 린트 6건 + 미래 날짜 1건 | wp1 |

**T1이 가장 무겁다.** `AGENTS.md`의 보안 작업 규정과 정면으로 부딪힌다:
미수정 결함의 분석은 추적 디렉터리가 아니라 스크래치에 있어야 한다.
이 스택의 devlog가 미공개 인증/세션 결함 분석을 담고 있다면, 그 부분은
공개 전에 제거되어야 한다. wp1에서 해당 문단을 판정하고 처리한다.

## #2772 p1 — 1건

| # | 위치 | 등급 | 요지 | 배정 |
| --- | --- | --- | --- | --- |
| T19 | src/server/index.ts:1013 | P2 | 확장된 readiness 응답을 `docs-site/.../cli/lifecycle.md`에 문서화 | wp2 |

## #2776 p2 — 2건

| # | 위치 | 등급 | 요지 | 배정 |
| --- | --- | --- | --- | --- |
| T20 | src/server/index.ts:1684 | **P1** | pairing 바디를 버퍼링 전에 제한. `Content-Length` 없거나 chunked면 `declaredLength`가 0이 되어 미인증 호출자가 무제한 버퍼링 유발 | wp3 |
| T21 | src/types/config.ts:251 | P2 | `hub.managementPublicOrigin`, `remoteGui.allowedTailscaleUsers`, `remoteGui.allowInsecure*` 문서화 | wp3 |

T20은 미인증 DoS다. D1과 같은 층에 있으므로 wp3에서 함께 닫는다.

## #2777 p3 — 3건

| # | 위치 | 등급 | 요지 | 배정 |
| --- | --- | --- | --- | --- |
| T22 | src/client/connect.ts:229 | **P1** | 연결 전 기존 Codex journal 재소유 필요. `ocx start` 후 정상 상태에서 `injectCodexConfig`가 소유권을 잃는다 | wp4 |
| T23 | src/client/hub-client.ts:85 | P2 | 신뢰할 수 없는 `Content-Length`에 대해 응답 읽기 제한 | wp4 |
| T24 | src/cli/help.ts:35 | P2 | connect/disconnect 워크플로 문서화 | wp4 |

## #2781 p4 — 4건

| # | 위치 | 등급 | 요지 | 배정 |
| --- | --- | --- | --- | --- |
| T25 | src/client/machine-listener.ts:79 | **P1** | `--management-transport relay` 선택 시 `connectClient`가 여전히 throw — 문서화된 옵션이 동작하지 않음 | wp5 |
| T26 | src/client/runtime.ts:27 | **P1** | systemd/WinSW로 뜬 런타임이 disconnect 후 재시작되지 않음(`OCX_SERVICE=1`이 분기를 건너뜀) | wp5 |
| T27 | gui/src/App.tsx:222 | P2 | disconnect 202 성공 시 targets 갱신 누락 | wp5 |
| T28 | gui/src/App.tsx:376 | P2 | pairing 완료 전 공유 페이지 게이팅 | wp5 |

## #2786 p5 — 2건

| # | 위치 | 등급 | 요지 | 배정 |
| --- | --- | --- | --- | --- |
| T29 | src/client/state.ts:46 | P2 | hub role을 disconnected client state에서 배제 | wp6 |
| T30 | src/client/state.ts:85 | P2 | missing-config 부트스트랩 조건화(락 획득 전 반환으로 경쟁) | wp6 |

## #2789 p6 — 3건

| # | 위치 | 등급 | 요지 | 배정 |
| --- | --- | --- | --- | --- |
| T31 | src/client/connect.ts:304 | **P1** | abort 실패 시 토큰 identity 보존. 새 토큰 설치 후 abort가 일시 실패하면 복원이 잘못된 세대를 남긴다 | wp7 |
| T32 | src/client/state.ts:95 | P2 | `ocx connect status`가 진행 중인 로테이션 백업을 삭제 | wp7 |
| T33 | src/client/hub-relay.ts:282 | P2 | 릴레이 오류를 과대 응답 노출 전에 반환 | wp7 |

T31/T32는 D4와 같은 사안의 서로 다른 얼굴이다. wp7에서 하나의 계약으로 닫는다.

## 처리 원칙

1. P1 6건(T1, T20, T22, T25, T26, T31)은 반드시 코드/문서 수정으로 닫는다.
2. P2/Minor는 수정하거나, 근거를 갖춘 반박을 스레드에 남기고 resolve한다.
   침묵은 허용하지 않는다.
3. 각 스레드는 소유 단계에서 닫고, 그 단계 head가 초록이 된 뒤 다음 단계를 쌓는다.
4. resolve 후 exact head로 재리뷰를 요청한다.
