# dev → dev-B 최종 마이그레이션 감사 (머지 전 최종 loop)

2026-07-07. 3개 병렬 gpt-5.5 xhigh 탐사 감사(기존 사용자 업그레이드 / codex-rs 프로토콜 /
구조 개편 사이드이펙트) + 로컬 검증. 목적: dev→dev-B(커밋 39개, 파일 248개, src/ 폴더
구조화) 머지 전에 기존 사용자가 in-place 업그레이드해도 아무것도 잃지 않는지 확정.

## 발견 및 수정 (이번 사이클에서 닫음)

P0 — 레거시 OAuth 계정 id 비결정성 (`src/oauth/store.ts` `newAccountId`):
identity 없는 레거시 단일 credential은 로드시마다 `${refresh}:${Date.now()}` 해시로
id가 재생성됨. 레거시 스토어는 읽기 경로에서 영속화되지 않으므로 `getAccountSet()`과
`getAccountCredential()`이 서로 다른 id를 만들 수 있음 → 유효한 auth.json인데
`OAuthLoginRequiredError`(가짜 로그아웃), 회전된 refresh 토큰의 persist가 조용히
no-op(토큰 유실). 수정: id를 `hash(accountId ?? email ?? refresh)`로 결정적으로.
회귀 테스트: tests/oauth-store-multi.test.ts "deterministic account id across loads".

P1 — 구 엔트리포인트 경로에 고착된 런처: 구조 개편으로 `src/cli.ts`가 사라졌는데,
dev 시절 shim/service 래퍼는 그 절대경로를 명령줄에 구웠음. `ocx update`는 설치 후
shim/service를 재작성하므로 안전하지만, 맨 `npm install -g`로 올리는 사용자는 죽은
경로에 좌초. 수정: `src/cli.ts` 호환 스텁(`import "./cli/index.ts"`) 1릴리스 이상 유지.

P1 — Anthropic many-image 가드가 URL/미상 치수 이미지를 "안전"으로 취급:
>20장 요청에서 2000px 초과 판정이 "치수를 아는" 이미지에만 발동 → URL 소스나
스니핑 불가 포맷이 실제 위반자면 그대로 400. 수정: 치수 미상을 risky로 계산해
20장 이하로 트림(`src/adapters/anthropic-image-guard.ts`). 회귀 테스트 3건 추가/갱신.

P2 — freeform(custom) 툴콜 입력 스트리밍 패리티: `response.custom_tool_call_input.delta`
/`.done` 미방출로 apply_patch 라이브 프리뷰가 없었음(치명 아님 — codex-rs는 완료
아이템만으로 실행). 수정: 부분 JSON 언랩 스트리머로 delta/done 방출(src/bridge.ts).

P2 — 문서/주석 표면: structure/01_runtime.md 모듈 지도에 adapters/oauth/responses/
vision/web-search 누락 보완, flat 경로 잔존 주석 4곳(bin/ocx.mjs, catalog.ts,
cursor-errors.ts, bun-runtime.ts) 갱신.

## 기존 사용자 업그레이드 호환 확인 (감사 결과: 안전)

- config: `~/.opencodex/config.json` 경로/스키마 유지, zod `.passthrough()`로 미지 필드
  보존, 누락 필드는 기본값 수리. 단일 `apiKey` → 멀티키 풀 자동 시드, 페일오버는
  키 2개 이상일 때만 활성.
- auth: `auth.json` 경로 유지, 레거시 단일 credential은 로드시 정규화(+최초 변이시
  `.pre-multiauth` 백업). 위 P0 수정으로 identity 없는 레거시도 안전.
- 상태 파일: usage.jsonl / ocx.pid / 런타임 포트 / codex-accounts.json 전부 경로 불변.
  responses-state.json은 additive.
- 패키지 엔트리: bin/ocx.mjs → src/cli/index.ts 해석 확인, `node bin/ocx.mjs --version`
  실측 통과. CLI 명령 표면 dev 대비 보존.
- codex-rs 프로토콜(업스트림 소스 대조: sse/responses.rs, compact_remote{,_v2}.rs,
  client.rs): SSE 수명주기/컴팩션 v1·v2/WS 426 폴백/reasoning ladder/usage 표면 모두
  정합. P0 없음.

## 잔여 (머지 블로커 아님, 백로그)

- madge 순환 4건: dev에도 동일하게 존재(dev-B가 도입한 것 아님). 후속 사이클에서
  타입 추출/콜백 역전으로 해소 후보.
- many-image 가드의 URL 이미지 실측 스니핑(타임아웃 fetch)은 미구현 — 보수적 트림으로
  대체(구현 비용 대비 이득 낮음).
- 000_plan.md의 기존 커버리지/위생 백로그 승계 항목 유지.

## Evidence

- 수정 전 베이스라인: tsc 0 / 1605 pass 0 fail.
- 수정 후: tsc 0 / 1609 pass 0 fail (신규 회귀 테스트 +4).
- 감사 리포트: gpt-5.5 xhigh 3렌즈(업그레이드/프로토콜/구조) — P0 1건은 코드로 실증
  후 수정, 나머지 표면은 "정합" 판정 근거와 함께 수신.
