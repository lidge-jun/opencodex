---
title: Replit 게이트웨이 컴패니언
description: Replit AI Integrations를 통해 OpenAI Chat과 Anthropic Messages를 중계하는 자체 Replit 배포와 opencodex를 페어링합니다. 옵트인 커스텀 워크플로이며 정식 레지스트리 프리셋이 아닙니다.
---

**Replit 게이트웨이 컴패니언**은
[`integrations/replit-gateway`](https://github.com/lidge-jun/opencodex/tree/dev/integrations/replit-gateway)의
사용자 소유 Bun 서비스로 **Replit 배포 내부**에서 실행됩니다. Repl 환경의 Replit AI Integrations
자격 증명을 읽고 opencodex에 두 개의 네이티브 와이어 엔드포인트를 노출합니다:

```text
opencodex (로컬)
  -> HTTPS + 게이트웨이 키
  -> Replit 배포 (integrations/replit-gateway)
  -> Replit AI Integrations 업스트림 (OpenAI Chat / Anthropic Messages)
```

opencodex는 `AI_INTEGRATIONS_*` 비밀을 받지 않습니다. 별도의 **게이트웨이 키**
(`REPLIT_GATEWAY_KEY`)를 opencodex가 로컬에 저장하고 모든 요청에
`Authorization: Bearer …`로 전송합니다.

> **커스텀 워크플로만.** `replit`과 `replit-anthropic`은 **정식 레지스트리 프리셋이 아닙니다.**
> opencodex는 공식 Replit 프로바이더를 주장하지 않으며, 서면 Replit 승인 전까지 레지스트리 승격은
> 차단됩니다([증거 게이트](#증거-게이트) 참고).

> **실험적 — 배포 미검증.** 코드와 v1 계약은 `experimental-pending-canary` 상태이나 **실제 Replit 배포는 Replit 주입 환경 계약 대비 검증되지 않았습니다.**

## 필요 사항

- [Replit AI Integrations](https://docs.replit.com/features/integrations/replit-ai-integrations)를
  사용할 수 있는 **유료 Replit 플랜**.
- Replit Agent가 OpenAI·Anthropic 관리형 통합 추가를 요청할 때의 **수동 승인**. opencodex는 Replit
  로그인, 결제, 통합 대화를 자동화하지 않습니다.
- 공개 **HTTPS** 오리진(일반적으로 `https://<repl>.replit.app`)에서 도달 가능한 게이트웨이 패키지.
- 대시보드 페어링 또는 CLI 설치를 위한 실행 중인 opencodex 프록시(`ocx start`).

배포 및 구성은
[패키지 README](https://github.com/lidge-jun/opencodex/blob/dev/integrations/replit-gateway/README.md)를
따르세요.

## 게이트웨이 배포(요약)

1. `integrations/replit-gateway/`를 Bun Repl에 복사합니다.
2. `loadGatewayConfigFromEnv()`와 `createGatewayServer()`를 호출한 뒤
   `Bun.serve({ fetch: gateway.fetch, port, hostname: "0.0.0.0" })`인 `server.ts`를 추가합니다.
3. Replit UI에서 **OpenAI**·**Anthropic** 관리형 통합을 승인합니다.
4. **관찰된 `AI_INTEGRATIONS_*` 이름**을 값 없이 확인합니다(아래).
5. `REPLIT_GATEWAY_KEY`(**32–512** 출력 가능 ASCII), `REPLIT_GATEWAY_PUBLIC_ORIGIN`, 모델 허용 목록, 네 개의 정확한 통합 변수 이름을 설정합니다.
6. `GET /healthz`와 인증된 `GET /v1/models` 성공을 확인합니다.

### Replit 환경 이름(미검증 관찰 관례)

필수 이름: `AI_INTEGRATIONS_OPENAI_BASE_URL`, `AI_INTEGRATIONS_OPENAI_API_KEY`, `AI_INTEGRATIONS_ANTHROPIC_BASE_URL`, `AI_INTEGRATIONS_ANTHROPIC_API_KEY`. **공식 플랫폼 외 계약 아님.** **canary 검증 대기.**

```bash
printenv | grep '^AI_INTEGRATIONS_' | cut -d= -f1 | sort -u
```

게이트웨이 키 **32–512** 출력 가능 ASCII:

```bash
openssl rand -base64 48 | tr -d '\n'
```

Replit Secrets와 opencodex 페어링에만 저장하고 git에는 넣지 마세요.

## opencodex 페어링

설치 시 배포 오리진에서 파생된 **두** 커스텀 프로바이더가 기록됩니다:

| 프로바이더 id | 어댑터 | base URL | 참고 |
| --- | --- | --- | --- |
| `replit` | `openai-chat` | `<origin>/v1` | `GET /v1/models`로 라이브 모델 탐색 |
| `replit-anthropic` | `anthropic` | `<origin>` | Bearer 전송; `liveModels: false` |

동일한 게이트웨이 키를 공유합니다. 기존 페어의 비파생 필드(선택 모델, pacing, 자격 증명이 아닌
커스텀 헤더)는 교체 시 보존됩니다.

### CLI — `ocx provider install-replit`

```bash
export REPLIT_GATEWAY_KEY='your-gateway-key'
ocx provider install-replit --origin https://my-app.replit.app
```

키 소스(하나만): `REPLIT_GATEWAY_KEY`, `--stdin`, `--gateway-key-file <path>`. 키는 **명령줄에
넣으면 안 됩니다**.

유용한 플래그: `--allow-custom-domain`, `--replace`, `--set-default`, `--json`.

설정 쓰기 전 opencodex는 **비과금** 엔드포인트만 프로브합니다: `GET <origin>/healthz`,
`GET <origin>/v1/models`(Bearer).

### 대시보드 마법사

**Providers**에서 **Replit gateway…**를 클릭합니다:

1. **HTTPS 오리진**과 **게이트웨이 키** 입력.
2. `.replit.app`이 아니면 **Allow custom domain** 선택.
3. 설치 후 **replit**을 기본 프로바이더로 설정(선택).
4. 성공 시 health·models 프로브 시간이 표시됩니다.

기존 페어가 있으면 **Replace pair** 전에 명시적 확인이 필요합니다. 정식 레지스트리 프리셋이
**아님**을 안내합니다.

## 커스텀 도메인 옵트인

기본적으로 `.replit.app` HTTPS 오리진만 허용됩니다. opt-in은 **소유권을 증명하지 않으며** DNS 리바인딩/TLS **운영 책임을 제거하지 않습니다.** opencodex는 HTTPS 구문, 설치 전 destination/DNS 평가, HTTPS 프로브를 **수행**하지만 **일회성**입니다.

## 콜드 스타트

유휴 Repl은 잠들 수 있습니다. 첫 요청은 느리거나 `upstream_error`/`upstream_timeout`이 될 수
있습니다. 설치 프로브 타임아웃은 8초입니다. 과금 릴레이는 자동 재시도하지 않습니다.

## 게이트웨이 한도(v1)

| 한도 | 기본값 |
| --- | --- |
| 최대 요청 본문 | 32 MiB |
| 최대 헤더 | 32 KiB |
| 최대 동시 요청 | 10 |
| 업스트림 타임아웃 | 300초 |
| 클라이언트 타임아웃 | 310초 |

업스트림 HTTP 리다이렉트는 거부됩니다. 허용 범위는 패키지 README 참조.

## 오류 범주

게이트웨이는 안정적인 JSON 오류 범주를 반환합니다(비밀값이나 본문은 절대 반환하지 않음):

`auth_failed`, `config_invalid`, `request_too_large`, `headers_too_large`,
`unsupported_content_encoding`, `model_not_allowed`, `concurrency_limited`, `upstream_timeout`,
`client_timeout`, `client_aborted`, `redirect_rejected`, `upstream_error`, `internal`.

일반적인 HTTP 매핑: `401` 인증, `400` 허용되지 않은 모델, `413` 본문 초과, `415` 인코딩된 본문, `429` 동시성, `408` 클라이언트 타임아웃, `504` 업스트림 타임아웃, `502` 업스트림/리다이렉트 실패.

## 네이티브 기능(v1)

**지원** — OpenAI Chat·Anthropic Messages 바이트 스트리밍. SSE `: heartbeat\n\n`는 **완전한 줄 경계**에서만.

**지연 LF 정책:** CRLF가 청크로 분할되고 `\n`이 지연되면 `\r`을 줄 경계로 간주해 heartbeat 타이밍에 사용할 수 있습니다. **페이로드 바이트는 변경되지 않음**; 드문 split-CRLF에서 **타이밍**만 다를 수 있습니다.

## v1 미지원

- 정식 Replit 레지스트리 프리셋·피커 타일
- 이 게이트웨이를 통한 Google Gemini·OpenRouter 등
- OpenAI Responses·이미지·오디오·전사
- OpenAI↔Anthropic 프로토콜 변환
- 자동 업스트림 재시도·캐시·정규화
- 브라우저 CORS
- identity가 아닌 `Content-Encoding`
- `replit-anthropic` 라이브 모델 탐색
- Replit 계정·승인·배포 자동화

## 개인정보·크레딧·약관

- **자격 경계:** 게이트웨이 키만 `~/.opencodex/config.json`에 저장됩니다.
- **결제:** Replit AI Integrations 사용량은 공개 API 요금으로 Replit 크레딧에 청구됩니다.
- **약관:** **해당 Replit 약관.** [ToS](https://replit.com/terms-of-service)(**Replit, Inc.**); **Pro/Enterprise**는 [Commercial Agreement](https://replit.com/commercial-agreement). **플랫폼 외 라우팅 승인 미확보.**
- **로깅:** 게이트웨이는 메타데이터만 기록합니다.

## 증거 게이트

[기여 — 정식 프리셋 증거](/contributing/#evidence-required-for-a-canonical-preset) 기준을
오늘 Replit 컴패니언은 **충족하지 않습니다**.

| 항목 | 상태(2026-08-22 검증) |
| --- | --- |
| **플랫폼 외** OpenAI Chat + Anthropic Messages | **미확립** |
| `AI_INTEGRATIONS_*` 이름 | **미검증 관찰 관례**; canary 대기 |
| 약관·법인 | ToS — **Replit, Inc.**; Pro/Enterprise: Commercial Agreement |
| 플랫폼 외 라우팅 승인 | **미취득** |
| 명명된 유지보수 책임자 | **opencodex:** [@lidge-jun](https://github.com/lidge-jun), [@Ingwannu](https://github.com/Ingwannu)([`MAINTAINERS.md`](https://github.com/lidge-jun/opencodex/blob/main/MAINTAINERS.md)). **Replit:** 이 워크플로의 파트너 아님. |
| 인용 가능 검증일 | **2026-08-22** |

**레지스트리 승격 차단.** `replit`/`replit-anthropic`은 `src/providers/registry.ts`에 없습니다.

## 참고

- [패키지 README](https://github.com/lidge-jun/opencodex/blob/dev/integrations/replit-gateway/README.md)
- [설계 사양](https://github.com/lidge-jun/opencodex/blob/dev/docs/superpowers/specs/2026-08-22-replit-gateway-design.md)
- [프로바이더](/guides/providers/)
- [웹 대시보드](/guides/web-dashboard/)
