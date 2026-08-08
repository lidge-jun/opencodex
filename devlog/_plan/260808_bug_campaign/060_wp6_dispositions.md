# 060 — WP6: 위양성 판정 및 close 집행

선행: WP4 (카탈로그 PR이 착지해야 일부 이슈의 최종 상태가 확정된다).

## 원칙

close는 되돌리기 쉽지만 리포터에게는 무례할 수 있는 행위다. 모든 close에
**실증 근거**를 코멘트로 남긴다. 근거는 코드 인용, ancestry 증명, 또는 재현 실패
로그여야 한다. "오래됐다" 는 근거가 아니다.

`main` 에는 아직 수정이 없고 다음 릴리스에 포함된다는 점도 함께 알린다.

## 060-1 · PR close

### PR #1155 (myrosla) — **close 철회** (감사에서 뒤집힘)

"도달 불가" 판정이 틀렸다. PR의 `upstreamStreaming: parsed.stream` 훅 때문에
**사용자 요청이 직접 그 분기를 켠다** — `web_search` 를 쓰면서 `stream` 을
생략하거나 `false` 로 보내는 라우팅 `/v1/responses` 요청이 정확히 그 경로다.
`stream` 은 스키마상 optional이고(`src/responses/schema.ts:133-144`),
`planWebSearch()` 에 스트림 요건이 없다(`src/web-search/index.ts:148-150`).

레지스트리 opt-in이 없다는 부분만 맞았고, 그것이 전부가 아니었다.

**처분: 열어둔 채 코멘트.** 상세와 보완 요청은 `015` 참조.

<details>
<summary>철회된 근거 (기록용)</summary>

코멘트 요지:

> 이 PR이 다루는 buffered upstream 경로는 현재 `dev` 에서 도달할 수 없습니다.
> 유일한 프로덕션 후보였던 DeepSeek V4 Flash가 `0b8e608c0` 에서 bounded-JSON
> 정책을 폐기했고(`src/providers/registry.ts:1318-1326`),
> `providerModelResponsesUpstreamStreaming()`(`:2248-2256`)에 opt-in 하는
> 레지스트리 항목이 없습니다. 웹 검색은 `src/web-search/loop.ts:364-366` 에서
> 항상 `stream: true` 를 요청하고 `:539-544` 에서 항상 `parseStream` 을
> 바인딩합니다. 문서 변경분도 현재 `docs-site/.../sidecars.md:32-35` 와
> 모순됩니다.
>
> 정책 훅 자체는 향후 호환성을 위해 남아 있으니, 실제로 buffered를 요구하는
> 프로바이더가 등장하면 이 작업을 되살리는 게 맞습니다. 조사에 감사드립니다.

</details>

### PR #1119 (본인) — **close 보류** (커버리지 손실)

착지한 계약이 #1119 내용을 **전부** 흡수하지는 않았다. 커스텀 프로바이더의 명시적
`modelSupportsReasoningSummaries: true` 가 템플릿 경로와 routed-strip 순서를
통과하는 케이스는 현재 dev에 없다.

**처분: 세 테스트를 현재 dev에 재작성해 착지시킨 뒤 superseded로 close.**

<details>
<summary>부분적으로만 유효한 원래 근거</summary>

유일한 코드 훅이 낡은 `tests/codex-catalog.test.ts` 추가인데, 주장하는 #1100
계약이 이미 `tests/codex-catalog.test.ts:2391-2451` 에 있다. GitHub도 DIRTY로
보고한다. devlog 16파일은 별도로 살릴 가치가 있으면 분리해 재발행한다.

</details>

### PR #1240 (snowyukitty) — 재발행으로 대체

close가 아니라 **supersede**다. WP2의 `codex/260808-sse-non-record-frames` 가
같은 결함을 다루되 종료 대신 건너뛰기로 처리한다. 코멘트로 재발행 PR을 연결하고,
원작자를 co-author로 보존했음을 알린다. 종료 동작이 왜 틀렸는지(후속 finish
청크와 `[DONE]` 유실) 설명한다.

## 060-2 · 이슈 close

### #1100 routed effort 미전파 — 이미 종결됨, 조치 없음

2026-08-08T02:14:24Z에 이 캠페인 밖에서 CLOSED 되었다. 우리가 닫을 것이 없다.

판정 근거는 유효했음을 기록해 둔다: 회귀 커버리지가
`tests/codex-catalog.test.ts:2391-2451` 에 존재하며 리포터의 커스텀 이름/BigModel
Coding Plan 형태도 `:2454-2489` 가 덮는다. 구현 이력 `aa8851f38`, `2f242bb7c`,
`07e7525b8`.

### #1128 remote compaction — **close 대상에서 제외** (착수 전 재확인)

집행 직전 확인에서 뒤집혔다. 다른 사용자의 추가 보고가 있고(awillheartwu,
2026-08-06 "same here, compact failed"), **maintainer가 2026-08-08T07:09:36Z에
"v2.11.0에서 재시험 후 회신 대기, leaving this open" 코멘트를 남기고 열어두었다.**

#1176과 같은 구조다. 정책 폐기라는 코드 사실은 맞지만 리포터의 실패가 사라졌다는
증명은 아니며, 같은 날 열어둔 판단을 몇 시간 뒤 뒤집을 근거가 없다.

**처분: tracking 유지.** 아래 근거는 기록으로만 남긴다.

`src/server/responses/compact.ts:651-665` 가 내부 Responses 요청을 `stream: false`
로 구성하고 `:666-709` 가 JSON을 소비한다. 기원 커밋 `87e1d000b`. 보고된
"compaction이 여전히 업스트림 스트리밍" 경로가 현재 구현에 없다.

### #1102 wildcard bind — 이미 종결됨, 조치 없음

2026-08-08T02:14:44Z에 이 캠페인 밖에서 CLOSED 되었다. 우리가 닫을 것이 없다.

판정 근거는 유효했음을 기록해 둔다: 선택적 루프백 리스너가
`src/server/index.ts:499-540` 에 구현되고, `src/codex/inject.ts:638-649` 가
Codex를 그쪽으로 전환하며, 실소켓 테스트
`tests/loopback-listener-integration.test.ts:108-122` 가 public 401 대 loopback 200을
증명한다.

## 060-3 · tracking 유지 (닫지 않음)

### #1176 DeepSeek V4 Flash 502 — 닫지 않는다 (감사 블로커 2)

초안은 이 이슈를 "해결됨" 으로 분류했다. **틀렸다.**

`0b8e608c0` 이 강제 bounded-JSON을 제거한 것은 사실이고
(`src/providers/registry.ts:1318-1325`,
`src/server/responses/core.ts:937-942`), 그래서 보고된 30초 inter-chunk 경로가
더는 적용되지 않는 것도 사실이다. 그러나 그것이 리포터가 겪은 502가 사라졌다는
증명은 아니다. 정책 제거는 한 가설을 배제할 뿐이고, 업스트림 stall 자체는
다른 원인일 수 있다.

결정적으로, maintainer가 2026-08-08T02:15:06Z에 이 이슈에 직접 남긴 코멘트가
v2.11.0에 **타깃 수정이 없다**고 명시하며 캡처 요청을 유지한 채 열어두었다.
같은 날 그 판단을 뒤집어 닫는 것은 근거 없는 번복이다.

조치: 열어둔 채로 유지한다. v2.11.0에서 502가 재현되는지에 대한 리포터 회신을
기다린다. 재현되지 않는다는 답이 오면 그때 어떤 변경이 작용했는지 좁혀 닫는다.

### #1024 커스텀 프로바이더 vision — 닫지 않는다 (감사 블로커 3)

초안은 "OpenCodex 결함 아님" 으로 닫으려 했다. 코드 분석 자체는 유효하다:
커스텀 프로바이더는 `src/types.ts:1213,1360` 에서 `modelInputModalities` 와
`noVisionModels` 를 지원하고, 텍스트 전용 모델은
`src/server/responses/core.ts:1765` 에서 사이드카를 태우거나 이미지를 제거하며
fail-closed 한다(`tests/vision-sidecar-e2e.test.ts:376`). 미분류 모델을 전부
텍스트 전용으로 취급하면 네이티브 비전 모델이 회귀하므로 OpenCodex 측 수정은
정당화되지 않는다.

**그러나 원인을 업스트림으로 돌리는 주장이 아직 증명되지 않았다.** 우리 계획
스스로가 "TokenRouter에 직접 요청" 이라는 대조 실험을 제안해놓고, 그 실험을
수행하기 전에 결론을 내리고 있다. 대조군 없이 인과를 단정하는 것은 이 캠페인이
다른 항목에 적용한 기준과 어긋난다.

조치: tracking으로 유지하며 리포터에게 대조 실험을 요청한다 — OpenCodex를 거치지
않고 동일한 캡션 전용 페이로드로 TokenRouter에 직접 요청. 그 결과가 나오면
업스트림 귀속이 증명되거나 반증된다.

| 이슈 | 사유 | 조치 |
|---|---|---|
| #1176 | v2.11.0에 타깃 수정 없음. maintainer가 캡처 요청 유지한 채 열어둠 | 리포터 회신 대기 |
| #1024 | 대조 실험(직접 TokenRouter 요청) 미수행 | 대조 실험 요청 |
| #417 | `openai/codex#35161` OPEN | 스윕 기록만 갱신 |
| #92 | `openai/codex#32031` OPEN. dev는 `src/server/responses/core.ts:1560-1564` 로 명시적 실패만 추가(완화이지 복구 아님) | 스윕 기록 갱신 |
| #904 | 재현 캡처 부재. 릴레이 포렌식 훅은 `src/server/live.ts:79-127` 에 존재 | needs-info 유지 |
| #796 | `d3abf4345` 로 호스트 게이트 수정 반영됐으나 회귀 자체가 라이브 Ark 미검증 명시(`tests/volcengine-ark-assistant-content.test.ts:16-18`) | 리다크션한 현재 Ark 결과 요청 |
| #418 | `src/server/responses/collaboration.ts:321-330` 개선됐으나 동일런 트레이스 없음. #92와 별개 | needs-info 유지 |
| #1162 | `src/adapters/cursor/live-transport.ts:175-180`, `cursor-errors.ts:83-100` 이 증상은 설명하나 핸드셰이크 원인 미증명 | 대조 wire 캡처 요청 |
| #1222 | Windows 네이티브 크래시. 재현 환경 부재 | 반증 실험 3종 요청 (`002` 문서 참조) |
| #241 | #1244 재발행이 실 구현 후보 | WP4 착지 후 close |
| #1191, #1193, #1190 | 각각 #1202, #1205, #1210 재발행이 해소 | 해당 PR 착지 후 close |

### #1222 반증 실험 (리포터 요청 사항)

추정으로 패치하지 않는다. 후보 커밋은 `0408dfdd7`(네이티브 프로파일 소유권,
최유력 — `src/server/index.ts:603`, `src/codex/native-profile-startup.ts:235`),
`254db138c`(PowerShell `execFile` 프로브 — `src/codex/native-profile-processes.ts:60`),
`14cc0d421`(저확률, 첫 tick이 60초라 18초와 안 맞음),
`9d271d091`/`8b6f16134`(저확률, 스트리밍 트래픽 필요).

요청할 실험:

1. 네이티브 프로파일 상태가 없는 새 `CODEX_HOME` 으로 시작
2. Codex 시작 동기화를 끈 상태로 시작
3. listen 이후 대시보드/클라이언트 트래픽 없이 재현

## WP6 수용 기준

**이번 사이클의 close 실행은 0건이다.** 승인 범위는 "위양성 close" 였고, 감사
결과 남은 후보 둘 다 위양성이 아니었다.

- **#1155: close하지 않는다.** 열어둔 채 철회 코멘트 — 도달 가능한 경로임을
  인정하고, 동시에 머지 준비가 안 됐음(tool-call 전용 응답 파서 오류)을 알린다
- **#1119: close 조건부.** 세 테스트 케이스를 현재 dev에 재작성해 **착지시킨
  뒤에만** superseded로 닫는다. 대체본 없이 닫으면 회귀 커버리지를 잃는다
- PR #1240 supersede 코멘트 + 채택 상태 연결
- 이슈 close **0건** — #1128이 착수 직전 재확인에서 tracking으로 이동(위 060-2)
- tracking **11건**(#1176, #1024, #417, #92, #904, #796, #418, #1162, #1222 등)에
  현재 상태 코멘트 갱신
- 모든 close에 코드 인용 또는 ancestry 증명 포함 (c6 기준)
- **착수 전 각 대상의 현재 state를 확인한다** (`010` 문서의 이슈 갱신 게이트).
  이미 닫힌 이슈에 close 액션을 보내면 실패한다

### close 대상이 5건에서 0건으로 줄어든 경위

범위 축소가 아니라 두 종류의 교정이다.

- **오판 교정 (2건):** #1176과 #1024는 감사에서 close 근거가 불충분한 것으로
  뒤집혀 tracking으로 이동했다. 근거는 060-3 참조.
- **외부 종결 (2건):** #1100과 #1102는 캠페인 진행 중 다른 경로로 이미 닫혔다.
  우리가 할 일이 남아 있지 않다.

착수 직전 재확인에서 #1128이 tracking으로 이동했고, 집행 직전 감사에서 남은
PR 2건마저 위양성이 아닌 것으로 판명됐다.

**이번 사이클 최종 close: 0건.**

close 5건에서 시작해 0건이 됐다. 축소가 아니라 매 단계 근거를 다시 확인한
결과다:

- 판정 오류 2건 — #1176, #1024 (감사에서 근거 불충분)
- 외부 종결 2건 — #1100, #1102 (다른 경로로 이미 닫힘)
- 회신 대기 1건 — #1128 (maintainer가 당일 재시험 요청)
- 도달 가능 1건 — #1155 (`upstreamStreaming: parsed.stream` 로 사용자가 활성화)
- 커버리지 손실 1건 — #1119 (대체 테스트 착지가 선행 조건)

승인 범위 안에 있다는 것이 근거 없이 실행해도 된다는 뜻은 아니다.

