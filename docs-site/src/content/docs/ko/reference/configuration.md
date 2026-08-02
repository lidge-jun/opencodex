---
title: 설정 레퍼런스
description: opencodex가 설정을 저장하는 위치, 편집 방식, 각 설정 도메인으로 가는 링크를 안내합니다.
---

opencodex는 지속 설정을 `$OPENCODEX_HOME/config.json`에 저장합니다. 보통은
`~/.opencodex/config.json`이며, Windows에서는 기본값이
`%USERPROFILE%\.opencodex\config.json`입니다.

## 설정을 편집하는 방법

작업에 맞는 편집 경로를 선택하세요.

- **대시보드:** 안내형 UI에서 프로바이더, 모델, 에이전트, 접근, 저장소 설정을 조정합니다.
- **CLI:** `ocx init`은 초기 파일을 만들고, `ocx provider`, `ocx models`, `ocx combo`,
  `ocx agent`, `ocx config` 같은 명령은 각 명령이 맡은 설정을 갱신하거나 조회합니다.
- **파일:** 전용 UI나 CLI 명령이 없는 필드는 `config.json`을 직접 편집합니다. 파일은 유효한 JSON이어야
  합니다.

대시보드, 관리 API, 그리고 설정을 바꾸는 CLI 명령은 모두 같은 파일에 저장합니다. 가능하면 그 경로를
쓰고, 직접 손으로 고쳐야 한다면 프록시를 멈춘 뒤 하세요. 실행 중인 프로세스는 설정을 메모리에 유지하므로,
나중에 라이브 저장이 스냅샷을 기준으로 손수 고친 내용을 다시 덮어쓸 수 있습니다. 라이브 저장은 충돌 보호
경로가 명시된 `claudeCode`와 리스너 바인딩 필드의 외부 수정분을 병합하지만, 그 보호가 모든 하위 트리를
덮지는 않습니다.

파일을 파싱할 수 없으면 opencodex는 `config.json.invalid-<timestamp>`로 백업하고, 콘솔에 경고를
남긴 뒤 기본값으로 시작합니다. 파일이 없어도 새로 설치한 경우의 기본값을 그대로 사용하며, 그것은 단일
`openai` forward 프로바이더입니다.

## 우선순위와 기본값

`config.json`의 유효한 값은 내장 기본값보다 우선합니다. 선택 사항으로 비어 있는 필드는 각 도메인 페이지에
문서화된 기본값을 사용합니다. `OPENCODEX_HOME`은 기본 설정 디렉터리보다 우선합니다.
`apiKey: "${PROVIDER_API_KEY}"`처럼 환경 참조를 허용하는 필드는 요청 시점에 해당 변수를 풉니다.
외부로 나가는 프록시 연결에서는 이미 설정된 `HTTP_PROXY` 또는 `HTTPS_PROXY`가 최상위 `proxy` 필드보다
우선합니다.

라우팅은 자체적인 순서형 해석 규칙을 따릅니다. [라우팅](/reference/configuration/routing/)을
참조하세요.

## 설정 도메인

- [프로바이더](/reference/configuration/providers/) — 프로바이더 항목, 인증, 엔드포인트,
  카탈로그, allowlist, context limit, quota, 프로바이더별 옵션을 다룹니다.
- [라우팅](/reference/configuration/routing/) — `defaultProvider`, 모델 해석 순서, combo,
  alias, combo effort 기본값을 다룹니다.
- [에이전트](/reference/configuration/agents/) — 멀티 에이전트 모드, 위임 가이드, fallback 모델,
  네이티브 기본값 동기화, effort 상한을 다룹니다.
- [서버와 런타임](/reference/configuration/server/) — 리스너와 원격 접근, admission key,
  timeout, 저장소, sidecar, 시작 동작, shadow call을 다룹니다.

## 파일에 비밀을 남기지 마세요

API 키에는 `${ENV_VAR}` 참조를 쓰는 편이 좋습니다. `apiKey`, `apiKeyPool[].key`, `apiKeys[].key`
에 들어 있는 리터럴 값은 비밀 정보입니다. 커밋하거나 로그에 붙여 넣거나 다른 사람과 공유하지 마세요.
OAuth와 forward-provider 토큰은 `config.json`이 아니라 별도의 자격 증명 저장소에 보관합니다.
account id와 이메일도 공개하지 않는 편이 좋으니, 가능하면 공개 selector alias를 사용하세요.

:::note[원자적 쓰기]
opencodex는 관리형 `config.toml`과 `opencodex-catalog.json` 파일을 임시 파일로 쓴 뒤 rename하는
방식(`atomicWriteFile`)으로 저장합니다.
이렇게 하면 `ocx stop`과 프록시 종료 handler처럼 동시에 실행되는 writer가 Codex를 되돌릴 때도
부분 파일이 생기지 않습니다.
:::
