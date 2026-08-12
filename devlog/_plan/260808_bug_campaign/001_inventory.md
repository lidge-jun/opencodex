# 001 — 커트오프 인벤토리

수집 시각: 2026-08-08. Base `origin/dev@a259d63dc`.

> **재동결 기록.** 최초 수집은 `ec8ceef00` 기준이었으나 감사(A) 도중 dev가
> `a259d63dc` 로 이동하고 PR 2건(#1263, #1260)이 추가되었다. 감사 블로커 1번에
> 따라 전 항목을 재수집해 아래로 교체한다.

## 수집 명령과 원본 수치

```
gh issue list --state open --limit 200            -> 64건 (전체 열린 이슈)
  라벨 bug 또는 provider-compatibility 필터        -> 25건
gh pr list --state open --limit 100               -> 39건 (전체 열린 PR)
  제목이 fix( 또는 test( 로 시작                    -> 27건
gh run list --status action_required --limit 400  -> 52개 브랜치
  그중 열린 PR의 head 브랜치                        -> 26건
```

## 버그 계열 PR 30건 (dev 범위 29 + main 제외 1)

아래 표는 30행이다. 그중 #1265는 `main` 을 타겟하는 릴리스 경로 항목이라 캠페인
실행 대상이 아니다. **실제 처리 대상은 29건**이며, #1265는 배제 사실을 명시하기
위해 표에 남긴다.

게이트 2차 실행(`013` 문서)에서 #1269, #1268이 추가됐다. 둘 다 우리 WP5 계획과
겹치므로 직접 구현 대신 채택으로 전환했다.

| PR | 제목 | 작성자 | draft | 처분 | WP |
|---|---|---|---|---|---|
| 1269 | check live proxy before journal recovery | Ingwannu | Y | 채택 + handleEnsure 보완 요청 | WP5 |
| 1268 | hide npm launcher proxy child | Ingwannu | Y | 채택 (050-2 대체) | WP5 |
| 1266 | replay Vertex thought signatures | Ingwannu | N | 재발행 | WP4 |
| 1265 | promote workflow comment-spam hardening to main (hotfix) | Wibias | N | **범위외**(main 핫픽스) | — |
| 1264 | reject null Claude toggle bodies | luvs01 | Y | 재발행 | WP1 |
| 1263 | reject profile FIFOs without blocking | luvs01 | Y | 채택 + 테스트 수정 요청 | WP1 |
| 1260 | restrict plaintext sideband overrides to numeric loopback | luvs01 | Y | 재발행(보안) | WP1 |
| 1259 | require paginated aggregate-check evidence | luvs01 | Y | 재작업(라벨 필요) | WP3 |
| 1258 | bound reasoning-effort trace hydration | luvs01 | Y | 재발행 | WP1 |
| 1256 | bound startup hydration tail reads | luvs01 | Y | 재발행 | WP1 |
| 1249 | ignore empty data: frames | Yuxin-Qiao | N | 재발행 | WP2 |
| 1244 | preserve routed models in desktop picker | Wibias | N | 재발행 | WP4 |
| 1240 | treat non-record data frame as malformed | snowyukitty | N | **채택** (작성자가 continue로 수정 완료) | WP2 |
| 1228 | Add native image support for Cursor | yansigit | Y | 재발행(대형단독) | WP4 |
| 1226 | restore DeepSeek V4 context window | iF2007 | N | 재발행(dirty 충돌) | WP4 |
| 1224 | keep per-provider context caps independent | iF2007 | N | 재발행 | WP4 |
| 1210 | move per-role model fallback into config | Yuxin-Qiao | Y | 재발행 | WP1 |
| 1205 | inject reasoning placeholder on replay miss | Yuxin-Qiao | Y | 재발행 | WP2 |
| 1202 | stop reporting every history failure as DB lock | Yuxin-Qiao | Y | 재발행 | WP1 |
| 1195 | keep unbound account quota unknown | luvs01 | Y | 재발행 | WP1 |
| 1192 | bound synthesized SSE expansion | luvs01 | Y | 재발행 | WP1 |
| 1189 | stream request index ingestion | luvs01 | Y | 재발행 | WP1 |
| 1187 | tolerate malformed historical attempts | luvs01 | Y | 재발행 | WP1 |
| 1185 | bind Windows shard assertion to executable command | luvs01 | Y | 재발행 | WP3 |
| 1184 | guard own-property model lookups | luvs01 | Y | 재발행 | WP1 |
| 1178 | discover Antigravity live models | iF2007 | N | 재발행(보안검토) | WP4 |
| 1169 | warn when codex-shim install cannot prove routing | TyroneXie | Y | 재발행 | WP1 |
| 1163 | synthesize incomplete combo members | eachann1024 | Y | 재발행 | WP4 |
| 1155 | preserve buffered upstream policy | myrosla | Y | **close(위양성)** | WP6 |
| 1119 | pin the routed reasoning joint contract | lidge-jun | N | **close(위양성)** | WP6 |

감사 라운드 1에서 추가: #1263, #1260, #1257, #1228, #1210, #1205. #1163도 WP4로
배정했다. 감사 라운드 3에서 추가: #1264(WP1 재발행), #1265(범위외).

#1265는 `main` 을 타겟하는 워크플로 핫픽스다. 이 캠페인은 `dev` 대상 버그
처리이고 `main` 승격은 maintainer 릴리스 경로이므로 범위 밖이다. 다만 #1255와
같은 워크플로 표면을 건드리므로 **WP3 착수 전에 그 착지 여부를 확인**해야
한다 — 이미 `main` 에 올라간 내용을 `dev` 에서 다시 만들면 충돌한다. 보안
검토는 릴리스 경로에서 별도로 수행된다.

### 부록 — 캠페인 중 외부에서 종결된 항목

아래는 위 현재 집합(PR 표 30행 / 실제 처리 29건)에 **포함되지 않는다.** 이력 보존용이며 실행할 작업이
없다. 표 행수를 셀 때 이 항목들을 더하지 말 것.

| 항목 | 종결 | 원래 배정이었던 것 |
|---|---|---|
| PR #1257 | 머지 `db371021c`, 2026-08-08T05:50:40Z | WP1 GUI 재발행 |
| PR #1255 | 머지 `d55b903d8`, 2026-08-08T05:54:05Z | WP3 스택 루트 |
| 이슈 #1100 | CLOSED 2026-08-08T02:14:24Z | WP6 close |
| 이슈 #1102 | CLOSED 2026-08-08T02:14:44Z | WP6 close |
| 이슈 #1218 | CLOSED 2026-08-08T03:40:15Z | WP5 050-5 수정 |

#1255의 머지가 WP3 구조를 바꿨다. 스택 루트가 dev에 흡수됐으므로 #1259와 #1185는
각각 `origin/dev` 기반 독립 PR이 된다. 상세는 `030` 문서 참조.

## 버그 계열 이슈 25건 (현재 열린 집합)

열린 이슈만 담는다. 종결된 #1100, #1102, #1218은 부록에 있으며 이 행수에
포함하지 않는다.

| 이슈 | 제목 요약 | 대응 PR | 처분 | WP |
|---|---|---|---|---|
| 1245 | GUI Startup Safety stale error | 없음 | 직접수정 | WP5 |
| 1236 | Windows 콘솔창 팝업 (windowsHide) | 없음 | 직접수정 | WP5 |
| 1230 | 동시 start 시 journal 선복원 | 없음 | 직접수정 | WP5 |
| 1229 | ChatGPT auth가 namespaced 모델 거부 | 없음 | 직접수정 | WP5 |
| 1222 | Windows STATUS_STACK_BUFFER_OVERRUN | 없음 | tracking(반증실험 요청) | WP6 |
| 1219 | SSE null 프레임 크래시 | #1240 | #1240 착지 후 close | WP2 |
| 1213 | Claude Desktop 카탈로그 무단 교체 | 없음 | 직접수정 | WP5 |
| 1196 | issue-quality media 정규화 손상 | 없음 | 직접수정 | WP5 |
| 1193 | preserveReasoningContentModels 400 | #1205 | PR 착지 후 close | WP2 |
| 1191 | Windows DB locked 오탐 | #1202 | PR 착지 후 close | WP1 |
| 1190 | per-role model_fallback TOML 거부 | #1210 | PR 착지 후 close | WP1 |
| 1176 | DeepSeek V4 Flash 502 | 없음 | **tracking 유지** (감사 블로커 2) | WP6 |
| 1162 | Cursor Claude 계열 실패 | 없음 | tracking(wire 캡처 요청) | WP6 |
| 1145 | opencode-zen rate limit 무고지 | 없음 | 직접수정(범위 제한) | WP5 |
| 1128 | remote compaction 실패 | 없음 | close(해결됨) | WP6 |
| 1091 | ChatGPT OAuth 커스텀 업스트림 URL | 없음 | 범위외(enhancement) | — |
| 1059 | Windows 스위트 dispatch-only | 없음 | 상태규명 선행 | WP5 |
| 1024 | 커스텀 프로바이더 vision 모호 | 없음 | **tracking 유지** (감사 블로커 3) | WP6 |
| 904 | Kimi/Opus 한글 U+FFFD | 없음 | tracking(needs-info) | WP6 |
| 796 | Volcengine Ark 400 | 없음 | tracking(needs-info) | WP6 |
| 540 | WordPress Studio Code 프로바이더 | 없음 | 범위외(feature) | — |
| 418 | V2 delegation 실패 | 없음 | tracking(needs-info) | WP6 |
| 417 | 한국어 음성 U+FFFD | 없음 | tracking(업스트림) | WP6 |
| 241 | Desktop picker 라우팅 모델 누락 | #1244 | PR 착지 후 close | WP4 |
| 92 | V2 NEW_TASK body 소실 | 없음 | tracking(업스트림) | WP6 |

#1091과 #540은 `provider-compatibility` 라벨 때문에 모수에 잡히지만 실제로는
프로바이더 추가 요청(enhancement)이다. 이번 버그 캠페인 범위 밖임을 명시하고
처분표에서 제외한다 — 감사 블로커 1번의 "orphan" 지적에 대한 답이다.
