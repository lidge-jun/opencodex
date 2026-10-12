---
title: Codex에 로그인할 수 없거나 화면이 열리지 않을 때
description: opencodex 적용 후 Codex 로그인이나 모든 요청이 실패할 때 프록시 없이 Codex를 원래 계정으로 되돌리는 방법을 설명합니다.
---

opencodex를 설정한 뒤 Codex가 로그인 화면에서 멈추거나 로그인 요구 사항을 불러오지 못하거나 모든 모델 요청에 실패한다면, Codex가 실행되지 않는 opencodex 프록시를 계속 바라보는 것이 가장 유력한 원인입니다. 이 문제는 [#5261](https://github.com/lidge-jun/opencodex/issues/5261)로 보고되었습니다.

## 발생 원인

기본 루프백 설정에서 opencodex는 Codex에 별도 프로바이더를 추가하지 않습니다. 대신 `$CODEX_HOME/config.toml`(Windows에서는 `%USERPROFILE%\.codex`)에 루트 오버라이드를 기록해 Codex의 내장 `openai` 프로바이더가 프록시를 향하도록 합니다.

```toml
model_catalog_json = "/absolute/path/to/opencodex-catalog.json"
# Auto-injected by opencodex (undo: ocx restore)
openai_base_url = "http://127.0.0.1:10100/v1"
# Auto-injected by opencodex (undo: ocx restore)
experimental_realtime_ws_base_url = "http://127.0.0.1:10100/v1"
```

이 줄은 디스크에 기록되므로 재부팅 뒤에도 남습니다. Codex가 시작할 때 프록시가 실행되지 않으면 해당 주소에서 응답이 없고, Codex에는 대체할 두 번째 엔드포인트도 없습니다. 화면에는 opencodex에 관한 설명이 없어 Codex 자체의 문제로 오해하기 쉽습니다.

프록시가 실행되지 않는 데에는 평범한 이유도 있습니다. Codex 연동을 적용해도 백그라운드 서비스가 설치되지는 않습니다. 서비스 설치는 별도 `ocx service install` 단계이므로 재시작 뒤 프록시를 띄울 것이 없을 수 있습니다. 등록된 Windows 예약 작업은 부팅이 아닌 로그인 시 시작됩니다. 작업이 비활성화되거나 실행에 실패하거나 다른 프로세스가 포트를 차지할 수도 있습니다.

## Codex 다시 사용하기

원하는 결과에 맞는 방법을 고르세요. 프록시가 꺼져 있어도 둘 다 실행할 수 있습니다.

**Codex를 원래 계정과 엔드포인트로 되돌리기:**

```bash
ocx restore
```

이 명령은 주입된 라우팅, 실시간 통신 오버라이드, opencodex 카탈로그 경로를 제거합니다. 실행 중인 프록시나 대시보드 세션, 네트워크가 필요하지 않습니다. 이후 Codex는 정상적으로 로그인하고 실행됩니다. opencodex를 다시 사용하려면 `ocx restore back`으로 Codex가 프록시를 바라보게 하세요.

**또는 프록시 다시 실행하기:**

```bash
ocx start
ocx service install   # keep it running across restarts
```

`ocx status`는 프록시 응답 여부와 Codex가 현재 프록시를 통해 라우팅되는지를 보여줍니다. `ocx doctor`는 같은 상태를 더 자세히 설명하고 권장 복구 방법을 알려줍니다.

## ocx를 사용할 수 없을 때

라우팅을 직접 되돌릴 수 있습니다. `$CODEX_HOME/config.toml`을 열고 세 가지를 삭제하세요. `openai_base_url` 줄, `experimental_realtime_ws_base_url` 줄, 그리고 `opencodex-catalog.json`으로 끝나는 `model_catalog_json` 줄입니다. 앞의 두 줄 바로 위에 있는 `# Auto-injected by opencodex` 주석도 함께 제거하세요.

주석이 아니라 키 이름을 기준으로 판단하세요. opencodex는 주입된 `developer_instructions` 등 다른 관리 키에도 같은 소유권 주석을 사용합니다. 그런 키를 지워도 로그인 문제는 해결되지 않고 되돌리고 싶을 설정만 잃을 수 있습니다.

`model_catalog_json` 줄만 따로 삭제하지 말고 라우팅과 **함께** 삭제하세요. 존재하지 않는 파일을 가리키는 `model_catalog_json`이 남으면 Codex가 설정 자체를 불러오지 못해 다른 원인으로 같은 잠김 상태가 발생합니다.

## 계정이 추가되거나 표시되지 않을 때

Pool에 계정을 추가하지 못하거나 추가한 계정이 보이지 않는 문제는 같은 세션에서 일어나더라도 위 로그인 잠김과 별개입니다. 계정 Pool은 프록시 관리 API가 제공하므로 `ocx account login openai` 흐름과 대시보드 목록 모두 먼저 프록시가 실행되어야 합니다. 브라우저 로그인도 고정 주소인 `http://localhost:1455/auth/callback`으로 돌아오며 다른 포트로 바꿀 수 없습니다. 다른 프로세스가 1455 포트를 점유하거나 브라우저를 열 수 없다면 기기 인증 흐름을 사용하세요.

```bash
ocx account login openai --device
```

연동이 기록하는 내용과 라우팅 선택 방식은 [Codex 연동](/ko/guides/codex-integration/)을 참고하세요.
