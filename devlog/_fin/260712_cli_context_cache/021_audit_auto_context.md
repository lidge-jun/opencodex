# 021 — 감사 합성: auto-context (Lovelace/sol, VERDICT FAIL → 전건 수용)

| # | 심각도 | 지적 | 처분 |
|---|---|---|---|
| 1 | High | AUTO_COMPACT_WINDOW 유효범위 100k..1M (바이너리 pSo=1e5, yDs=1e6 — 본 세션 재검증) | 수용 — resolveAutoContext 범위검증(벗어나면 350k 기본), PUT 400, GUI min/max |
| 2 | High | user-wins env가 마킹 술어와 분리 (env 500k + 372k 모델 → [1m] 마킹인데 컴팩션 500k) | 수용 — resolveAutoContext(cc, envOverride): 유효 env는 그 값으로 술어 계산, 무효 env는 auto OFF. buildClaudeEnv는 base env, injectSystemEnv는 launchctlGetenv 전달 |
| 3 | High | sub-1M anthropic 라우트가 auto-마킹되면 canonical id+[1m] → 네이티브 패스스루 오염 | 수용 — buildClaudeContextWindows에서 anthropic provider는 >=1M만 등록, model-info routed 루프에서 anthropic은 AUTO_CONTEXT_OFF로 변형 억제 |
| 4 | High | manualEnv에 AUTO_COMPACT export 부재 → 수동 경로가 372k 행을 1M 회계로 오도 | 수용 — GUI manualEnv에 effective 값 export 추가 (maxContextTokens 설정 시 생략) |
| 5 | Medium | bare routed selector가 맵에 없음 | 수용(보수) — routed id가 전 프로바이더에서 유일할 때만 bare 키 등록 (native 선등록 first-wins 유지, 모호하면 미마킹) |
| 6 | Medium | 테스트 계약 공백 (cli no-override, system-env 기본 lever) | 수용 — 범위/외부오버라이드/anthropic/bare 케이스 + 기존 테스트 갱신 |
| 7 | Low | [1m] 대소문자 (CLI는 /i) | 수용 — strip/detect를 /\[1m\]$/i 공용 헬퍼로 통일 (context-windows, inbound, claude-messages) |

잔여 리스크 (기록): /v1/models는 클라이언트 env를 알 수 없어, 어떤 주입 경로도 안 거친
수동 사용자가 372k 변형 행을 고르면 1M 회계+컴팩션 부재. manualEnv/ocx claude/systemEnv
세 경로 모두 env를 주입하므로 안내된 경로에서는 발생 불가 — docs에 명시.
