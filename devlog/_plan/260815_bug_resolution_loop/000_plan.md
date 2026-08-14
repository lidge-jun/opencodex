# 000 — Bug Resolution Campaign Plan

감사 기준: 2026-08-14 ChatGPT audit ZIP
실행 기준: 2026-08-15
Scope: 감사 시점 기준 열린 bug 이슈만 대상, 이후 생성된 이슈/PR은 건들지 않음

## 이미 해결된 이슈 (dev에 fix 랜딩됨)

| # | 제목 | 해결 근거 |
|---|------|-----------|
| 1601 | Bun.serve maxRequestBodySize | eb3c50b exercise body size above Bun 128 MiB default |
| 1573 | Windows Korean user paths | dev에 1678 fix 랜딩 |
| 1589 | PowerShell WindowStyle | dev에 1674 fix 랜딩 |
| 1661 | Cursor unified exec | dev에 fix 랜딩 |
| 1635 | Non-json config depth | 이미 닫힘 |
| 1582 | openai-chat URL doubling | 이미 닫힘 |
| 1580 | Usage dashboard history | dev에 1638 fix 랜딩 |

## 코드 수정 대상

| # | 제목 | 접근 |
|---|------|------|
| 1612 | Docker foreground ownership | ownership probe 수정 |
| 1296 | Windows ACL error taxonomy | error class 분리 |
| 1562 | GUI V2 codex ENOENT | preflight + error |
| 1483 | MiMo effort mapping | effort registry |

## Defer / Close

| # | 제목 | 조치 |
|---|------|------|
| 1672 | Codex sync needs-info | close |
| 1594 | DeepSeek needs-info | close |
| 나머지 | 설계/upstream/tracking | 열어둠 또는 코멘트 |

## translate.js

도입하지 않음.
