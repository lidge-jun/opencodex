# 비전 사이드카 긴급 복구 + 사이드이펙트 전면 정리 (260707)

비상: Codex 앱 "This model does not support image inputs" — 사이드카 시작도 못 함.
Session 019f34f2-3c06-7250-a2ee-dd3707f8130d, 최소 3 PABCD 사이클, ocx 무재시작.

## WP1 — 비전 복구 (DONE, fb363e6)

2층 원인:
1. 카탈로그가 noVisionModels 모델(glm-5.2)의 jawcode text-only를 그대로 광고 → 앱이
   클라이언트 측 차단. 사이드카 설계(프록시가 이미지 묘사)는 카탈로그가 image를 광고해야 작동.
2. 1차 수정(applyProviderConfigHints) 후에도 실측 [text] — 사용자 persisted config에
   noVisionModels 부재(필드 추가 이전 생성). 라우터는 요청 시 레지스트리 병합(routedProviderConfig)
   하지만 gatherRoutedModels는 raw config 사용 → 프록시 동작과 카탈로그 광고가 드리프트.

수정: (a) applyProviderConfigHints — noVisionModels 모델에 image 모달리티 합성,
(b) gatherRoutedModels — 클론 enrich(enrichProviderFromRegistry)로 레지스트리 병합 후 리스팅
(persist 오염 없음). 라이브 카탈로그 재sync 실측: opencode-go/glm-5.2 [text,image],
xai/grok-composer-2.5-fast [text,image]. 전량 1592/0, tsc 0. 프록시 무접촉.

주의(NEEDS_HUMAN 아님, 메모): 실행 중 프록시의 GUI "Sync models" 버튼은 구코드로 카탈로그를
재작성하므로 이 수정 이전 상태(text-only)로 되돌릴 수 있음 — 다음 재시작 전까지 버튼 사용 자제.

## WP2 — 사이드이펙트 전면 감사 (DONE, 852ab04)

gpt-5.5 xhigh 3명 병렬: Bohr(비전 경로 end-to-end), Nietzsche(웹서치 사이드카 + 최근
하드닝/페일오버/compaction/ocxr1 상호작용), Pasteur(카탈로그 광고 vs 프록시 능력 전수 대조,
codex-rs 그라운드트루스 포함).

P0 0건. P1 수정: 웹서치 루프 429 페일오버(deps.on429) + per-iteration 타임아웃, 비전
fail-closed 스트립(사이드카 플랜 부재 시 이미지를 명시 마커로 치환), opencode-go text-only
9종 noVisionModels 등재, cursor 정적 모델 전체 사이드카 커버 + cursor search 광고 중단.

## WP3 — thinking×websearch 리플레이 + P2 기록 (DONE)

웹서치 루프의 synthetic web_search 리플레이가 서명된 thinking을 버려 anthropic extended
thinking에서 tool-use 400 위험 → extractIterationThinking으로 첫 콜의 assistant 턴에
[thinking, toolCall] 순서 보존. 테스트: 리플레이 메시지 실측.

### P2 백로그 (미수정, 근거 포함)
- [N] 루프 iteration별 usage 미집계 — 요청 로그는 최종 브리지 usage만 (loop.ts:236/355)
- [N] 반복 실패 쿼리로 forceAnswer 미도달 시 response.incomplete 종료 가능 (loop.ts:256)
- [N] structured-output 배치 결과 JSON 문자열 클램프로 invalid JSON 가능 (format-result.ts:63)
- [N] 웹서치 턴 forceEmptyResponseId + 상태 미저장 → previous_response_id 연속성 갭 (responses.ts:474)
- [B] authorization이 opencodex API key일 때 사이드카가 ChatGPT 토큰으로 오인 → 실패 시 fail-closed 마커 (수용)
- [B] input_image file_id / input_file 참조는 사이드카 미커버(파싱 단계 텍스트 강등) (parser.ts:37)
- [B] previous_response_id 상태가 raw input 저장 → 이미지 턴 재확장 시 재묘사 비용 (state.ts:125)
- [B] compaction v1 보존 메시지에서 이미지 블록 탈락 (compaction.ts:68)
- [B] grok-build-0.1 역드리프트(jawcode는 image 가능인데 noVisionModels 등재) — 보수적 유지
- [P] openai-chat 업스트림이 parallel_tool_calls=false 무시하고 interleave 시 브리지 단일-콜 모델 크로스와이어 가능
- [P] search 광고 전역 조건화(포워드 프로바이더 부재 시) 미구현 — planWebSearch 불가 시 툴이 목록에서 빠져 저위험
- [P] sol 브랜치 머지 시 reasoning "max" 레벨: 현행 codex-rs ReasoningEffort에 Max 없음 — 머지 전 codex-rs 버전 확인 필수

## Evidence ledger

- WP1 실측: 수정 전 [text] → 힌트만 [text] → enrich 후 [text,image] (catalog json 직접 판독)
- WP2: 감사 3건(각 file:line 인용), 수정 후 1596/0 + tsc 0, 카탈로그 재sync 실측
- WP3: 리플레이 테스트로 [thinking, toolCall] 순서 실측, web-search 16/16
