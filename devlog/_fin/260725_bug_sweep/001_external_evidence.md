# 001 — 외부 근거 (원문 확인 완료)

decade 구현 문서가 참조하는 공식 문서 근거를 한곳에 모은다. 구현 문서는 여기를 링크만
하고 조사 서술을 반복하지 않는다 (LEXICO-SPLIT-01).

독립 리뷰어가 2026-07-25에 아래 URL을 다시 열어 주장 일치를 확인했다.

## Windows Task Scheduler 스키마 기본값 (#432)

- [Task Scheduler Schema](https://learn.microsoft.com/en-us/windows/win32/taskschd/task-scheduler-schema)
  — Trigger `Enabled`와 Settings `Enabled` 모두 `default="true" minOccurs="0"`.
  Principal `RunLevel`은 `minOccurs="0"`.
- [Common Trigger Elements](https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-tsch/a0cf999f-aa47-4821-a46a-00fd28431f65)
  — "필드가 없거나 TRUE이면 enabled, FALSE이면 disabled".
- [SchRpcRegisterTask](https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-tsch/849c131a-64e4-46ef-b015-9d4c599c5167)
  — Settings/Enabled가 "존재하고 FALSE일 때"만 실행하지 않는다. `RunLevel` 생략 시
  서버가 `LeastPrivilege`를 사용한다.

개별 [Enabled(settingsType) 페이지](https://learn.microsoft.com/en-us/windows/win32/taskschd/taskschedulerschema-enabled-settingstype-element)는
`minOccurs="1"`이라 적지만 전체 XSD 및 등록 프로토콜과 모순된다. 전체 스키마와 동작
프로토콜을 우선 근거로 채택한다.

## xAI Responses vs Chat Completions (#404)

- [Comparison with Chat Completions API](https://docs.x.ai/developers/model-capabilities/text/comparison)
  — Responses API만 search/code/MCP agentic tool을 native 지원. Chat Completions는
  function calling만 지원하는 deprecated legacy endpoint.
- [Web Search](https://docs.x.ai/developers/tools/web-search)
  — `grok-4.5`를 `POST /v1/responses` + `tools:[{"type":"web_search"}]`로 호출.
- [Tool Usage Details](https://docs.x.ai/developers/tools/tool-usage-details)
  — server-side 검색은 `web_search_call`, client function은 `function_call`.

결론: 이름이 `web_search`인 Chat Completions function은 xAI hosted search와 동등하지 않다.
혼합 게이트웨이에서 Grok의 올바른 wire는 `/v1/responses`다.

## OpenAI Compaction (#422)

- [Compaction guide](https://developers.openai.com/api/docs/guides/compaction)
- [Responses compact API reference](https://developers.openai.com/api/docs/api-reference/responses/compact)
  (이전 `/api/reference/resources/...` 경로는 현재 공식 guide가 링크하는 경로가 아니다)

공식 Responses API는 `context_management`와 `POST /responses/compact`를 지원한다.
**이슈 본문의 "표준 OpenAI API는 compaction 미지원" 주장은 틀렸다.** 공개 API에 없는 것은
`/responses` 입력의 `compaction_trigger` item이다.

따라서 정확한 근거는 "표준 compaction 미지원"이 아니라 **"Responses wire를 지원한다는
사실만으로 Codex v2 trigger 지원을 추론할 수 없다"** 이다.

- upstream fatal 지점: [compact_remote_v2.rs:380-423](https://github.com/openai/codex/blob/4c43465133428898aa84f0bfc02c306ed65fb66a/codex-rs/core/src/compact_remote_v2.rs#L380-L423)
  — `compaction_count != 1`이면 `CodexErr::Fatal`.
- trigger 부착 지점: [compact_remote_v2_attempt.rs:69-79](https://github.com/openai/codex/blob/4c43465133428898aa84f0bfc02c306ed65fb66a/codex-rs/core/src/compact_remote_v2_attempt.rs#L69-L79)

## 경쟁 PR 현황 (2026-07-25 기준)

- [PR #376](https://github.com/lidge-jun/opencodex/pull/376) — #373을 닫으려 했으나
  CHANGES_REQUESTED. estimator가 wire pruning 이전 원본을 계산하고, payload 구성을
  중복 수행하며, 두 결과가 같은 인스턴스에서 나온다는 보장이 없다는 지적.
  owner 요구: 이미 pruning·정규화된 wire payload를 소비하고, request 구성을 중복하지 말며,
  checkpoint/carry가 없을 때만 계산할 것.
- [PR #408](https://github.com/lidge-jun/opencodex/pull/408) — Windows UAC 승격.
  **최신 head는 `src/service.ts`에 대규모 변경을 담고 있으며**
  `evaluateWindowsSchedulerInstallVerification()`이라는 새 `windowsTaskRegistrationHealthy()`
  소비자와 전용 테스트를 추가했다. WP2 착수 시 최신 head 기준으로 재확인해야 한다.

## 기준선 측정

`bun install` 후 (독립 리뷰어 재확인 포함):

```
bun run typecheck                                            exit 0
tests/codex-routing.test.ts                                  59 pass / 0 fail
tests/responses-compaction.test.ts + openai-responses-passthrough  46 pass / 0 fail
tests/service.test.ts                                        34 pass / 0 fail
tests/cursor-*.test.ts                                       112 pass / 0 fail
tests/server-auth.test.ts                                    54 pass / 0 fail
bun run privacy:scan                                         통과
```

## ref 상태 (착수 전 재확인 필요)

로드맵 작성 시점의 `origin/dev`는 `f77e3963`이었으나, 리뷰어 확인 시점에는 `9bf85aea`로
21커밋 앞서 있었다. **다만 `src/`와 `tests/`의 런타임 소스는 그 사이 변하지 않았다**
(GUI/devlog 커밋). 위 기준선 수치는 그대로 유효하다.

WP1 착수 시 `000_plan.md`의 sync gate 절차를 따라 다시 확인한다.
