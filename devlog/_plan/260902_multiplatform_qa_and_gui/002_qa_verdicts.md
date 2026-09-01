# 002 — QA 판정 요약 (증거는 추적되지 않는다)

`.codexclaw/`는 `.gitignore`에 있다(45-46행). 의도된 설계다 — 세션
증거는 워크스페이스 산출물이지 저장소 이력이 아니다. 그래서 판정만 여기 남긴다.
아티팩트 원본은 `.codexclaw/evidence/<sessionId>/qa/`에 있고, 세션이 끝나면
그 경로에서만 볼 수 있다.

## 시나리오별 판정

| 시나리오 | 표면 | 판정 | 핵심 근거 |
| --- | --- | --- | --- |
| `macmini-prestate` | cli | PASS | HEAD 0cc73411a / branch dev / dirty 0 / launchd 80761 / 2.39.0 |
| `macmini-deploy` | cli | PASS | 0d8147c20으로 pull, 재기동 후 healthz가 2.40.0 응답 |
| `macmini-cli-adversarial` | cli | PASS | 8클래스, exit 1/4 계약 일치 |
| `macmini-restore` | cli | PASS | branch/HEAD/dirty/link/서비스/버전 6항목 사전 일치 |
| `lidge-prestate` | cli | PASS | npm글로벌 2.21.0 / bun 1.3.14 |
| `lidge-deploy` | cli | PASS | 2.39.0 갱신 |
| `lidge-cli-adversarial` | cli | PASS | exit 0/1/4 macOS와 동일 |
| `lidge-http-runtime` | http | PASS | healthz/readyz 200, 반복 200/200, 404, GUI 200, stop 후 down |
| `lidge-restore` | cli | PASS | 2.21.0 복원, 포트 free, /tmp none |
| `intmb-prestate` | cli | PASS | 6항목 전부 none |
| `intmb-deploy` | cli | PASS | nvm + mktemp prefix 격리 설치, 전역 미변경 |
| `intmb-cli-http` | cli | PASS | exit 0/1/4, 기동 로그로 GUI 서빙 확인 |
| `intmb-restore` | cli | PASS | ~/.codex 부산물 3건 삭제, 6항목 전부 none 복귀 |

`NA`로 처리한 것: `intmb`의 HTTP 재확인. 프록시를 `stop`으로 이미
내린 뒤 curl을 다시 쳤기 때문에 000이 나왔다. 기동 시점 로그에 healthz와 GUI
서빙이 기록돼 있으므로 CLI 시나리오 안에서 다룬다.

## 정리 영수증

| 자원 | 정리 | 확인 |
| --- | --- | --- |
| `macmini-cf` launchd | 재기동(내린 적 없음) | `launchctl list` PID 64484 |
| `lidge` 포트 10777 | `ocx stop` | `lsof` 비어 있음 |
| `lidge` 임시 홈 | `rm -rf` | `/tmp/ocxqa-*` none |
| `intmb` 포트 10778 | `pkill` | `lsof` 비어 있음 |
| `intmb` 격리 prefix | `rm -rf` | 경로 gone |
| `intmb` `~/.codex` 부산물 | 파일명 지정 삭제 | opencodex 흔적 0건 |
| 로컬 데모 프록시 | `SIGINT` | 포트 10399/10401 리스너 없음 |

