<h3 align="center">make codex open!</h3>
<p align="center"><b>OpenAI Codex, Claude Code, Claude Desktop, Grok Build를 위한 범용 프로바이더 프록시</b><br>
명령어 두 줄이면, 그 모두가 지정한 LLM으로 돌아갑니다.</p>

<p align="center">
  <a href="https://x.com/claudeebum"><img src="https://img.shields.io/badge/%40claudeebum-000000?logo=x&logoColor=white" alt="X에서 @claudeebum 팔로우"></a>
  <a href="https://www.npmjs.com/package/@bitkyc08/opencodex"><img src="https://img.shields.io/npm/v/@bitkyc08/opencodex?color=cb3837&label=npm&logo=npm" alt="npm version"></a>
  <a href="https://github.com/lidge-jun/opencodex/blob/main/LICENSE"><img src="https://img.shields.io/npm/l/@bitkyc08/opencodex?color=blue" alt="license"></a>
  <img src="https://img.shields.io/node/v/@bitkyc08/opencodex?logo=node.js&label=node" alt="node version">
</p>

```bash
npm install -g @bitkyc08/opencodex
ocx start
```

<table>
<tr>
<td width="50%" valign="middle">

### Claude Code, 어떤 모델이든

선택기는 Claude Code 그대로입니다. 뒤에서 도는 두뇌만 다릅니다.

</td>
<td width="50%">
  <img src="../assets/claude-code-models.gif" alt="opencodex로 라우팅된 모델에서 돌아가는 Claude Code — 상태 표시줄에 gpt-5.6-luna-medium이 활성 모델로 표시됨" width="100%">
</td>
</tr>
<tr>
<td width="50%" valign="middle">

### Codex, 어떤 모델이든

프로바이더만 고르면 됩니다 — 같은 워크플로, 다른 두뇌.

</td>
<td width="50%">
  <img src="../assets/demo.gif" alt="opencodex 데모 — Codex 앱에서 비-OpenAI 라우팅 모델로 작업 실행" width="100%">
</td>
</tr>
<tr>
<td width="50%" valign="middle">

### Claude Desktop, 어떤 모델이든

Opus가 답한 다음, 작업을 GPT-5.6 Sol 서브에이전트에 넘깁니다.

</td>
<td width="50%">
  <img src="../assets/claude-desktop-subagent.gif" alt="Claude Desktop이 Claude Opus 4.8로 답한 뒤, opencodex로 GPT-5.6 Sol 서브에이전트를 보냄" width="100%">
</td>
</tr>
<tr>
<td width="50%" valign="middle">

### Grok Build, 어떤 모델이든

Sol이 세션을 이끌고 Kimi K3 서브에이전트를 호출합니다.

</td>
<td width="50%">
  <img src="../assets/grok-build-subagent.gif" alt="Grok Build가 opencodex로 GPT-5.6 Sol을 돌리고 Kimi K3 서브에이전트를 호출함" width="100%">
</td>
</tr>
</table>

<p align="center">
  <a href="../README.md">English</a> · <a href="README.fr.md">Français</a> · <b>한국어</b> · <a href="README.zh-CN.md">简体中文</a> · <a href="README.zh-TW.md">繁體中文</a> · <a href="README.ru.md">Русский</a> · <a href="README.ja.md">日本語</a> · <a href="README.tr.md">Türkçe</a> · 📖 <a href="https://opencodex.me/ko/"><b>전체 문서 →</b></a>
</p>

opencodex는 Codex의 Responses API를 프로바이더가 쓰는 프로토콜로 변환하는 가벼운 로컬 프록시입니다.
streaming, tool 호출, reasoning 토큰, 이미지를 양방향으로 모두 처리합니다. Claude, Gemini, Grok, GLM,
DeepSeek, Kimi, Qwen, Ollama를 비롯한 어떤 LLM이든 Codex, Claude Code, Claude Desktop, Grok Build에서
쓸 수 있습니다. Codex 인증용 **ChatGPT 계정 풀**도 관리합니다. 계정을 추가하고 대시보드에서 쿼터를
갱신하면, 새 세션은 사용량이 가장 적은 정상 계정으로 자동 라우팅되고 기존 스레드는 시작한 계정에
그대로 고정됩니다.

## 빠른 시작

### 개인 설치

```bash
npm install -g @bitkyc08/opencodex   # Node 18+; Bun 런타임은 자동으로 번들됩니다
ocx start                         # 프록시 + 대시보드: localhost:10100
```

백그라운드로 돌리려면 `ocx service`를 쓰세요.

**http://localhost:10100**을 열고 웹 대시보드에서 전부 설정하세요. 프로바이더 추가(내장 40개 이상,
또는 OpenAI 호환 엔드포인트), 모델 선택, 계정 관리까지 모두 여기서 합니다. `ocx gui`로 대시보드를 언제든 다시 엽니다.
Codex 인증용 **ChatGPT 계정 풀**도 관리합니다. ChatGPT / Codex 계정을 여러 개 넣고, 대시보드에서
5시간 / 주간 / 30일 쿼터를 갱신합니다. 쿼터 라우팅을 켜면 새 세션은 사용량이 가장 적은 정상 계정을 쓰고,
round-robin과 fill-first는 각자 정책을 따릅니다. 기존 Codex 스레드는 기본적으로 시작한 계정에 붙어
있어서, 긴 SSH·tmux·모바일 세션이 대화 도중에 계정을 바꾸지 않습니다. 다만 쿼터 재평가, failover,
계정 제외, affinity 만료, 401/403·429 복구가 일어나면 다시 묶일 수 있습니다. Codex Desktop 로그인처럼
다른 계정이 소진된 뒤에만 쓰고 싶은 계정이 있으면, 계정에 선택 순서를 지정하세요.

### 스폰서

업스트림 프로토콜이 바뀔 때마다 opencodex가 따라갈 수 있는 건 스폰서 덕분입니다. 관심이 있으면
[SPONSORS.md](../SPONSORS.md)를 확인하세요.

<!-- sponsors:main — one banner, model developers only; empty until a Main sponsor signs -->

<!-- sponsors:standard — one row per sponsor, in order of signing -->
<table>
<tbody>
<tr>
<td width="180"><a href="https://www.orcarouter.ai/?utm_source=opencodex&utm_medium=readme"><img src="../assets/sponsors/orcarouter.png" alt="OrcaRouter" width="150"></a></td>
<td><a href="https://www.orcarouter.ai/?utm_source=opencodex&utm_medium=readme">OrcaRouter</a>의 후원에 감사합니다. OrcaRouter는 프로덕션용 OpenAI 호환 AI 게이트웨이입니다. 프롬프트를 채점해 기준을 넘는 모델로 보내는 적응형 라우팅, 자동 failover, 코드로 쓰는 라우팅 규칙, 프롬프트 캐싱이 있는 무마진 프로바이더 가격, 그리고 200개 이상 모델의 모든 호출에 붙는 가드레일·에이전트 방화벽·요청 로그를 제공합니다. Add provider 선택기에서 <code>OrcaRouter</code>를 고르거나 <code>ocx provider add orcarouter</code>를 실행하세요. 적응형 라우터는 <code>orcarouter/auto</code>입니다.</td>
</tr>
<tr>
<td width="180"><a href="https://www.packyapi.com/register?aff=k5KT"><img src="../assets/sponsors/packycode.png" alt="PackyCode" width="150"></a></td>
<td><a href="https://www.packyapi.com/register?aff=k5KT">PackyCode</a>의 후원에 감사합니다. PackyCode는 안정적인 고성능 API 릴레이 프로바이더로, Claude Code, Codex, Gemini 등의 릴레이를 제공합니다. 자동 failover, 스마트 라우팅, 무제한 동시성으로 AI를 실제 생산성 도구로 만듭니다. <a href="https://www.packyapi.com/register?aff=k5KT">이 링크로 등록</a>하고 바로 시작하세요. Add provider 선택기에서 <code>PackyCode</code>를 고르거나 <code>ocx provider add packycode</code>를 실행하세요.<br><sub>PackyCode 是一家稳定、高效的 API 中转服务商，提供 Claude Code、Codex、Gemini 等多种中转服务。具备自动故障转移、智能路由和无限并发等多种功能，让 AI 编程成为真正的生产力工具。<a href="https://www.packyapi.com/register?aff=k5KT">点此链接注册</a>，立即开始使用！</sub></td>
</tr>
</tbody>
</table>

---

<details>
<summary>Docker Compose</summary>

이 저장소는 digest로 고정하고 root를 쓰지 않는 Compose 빌드를 제공합니다. 호스트에 Git과 Bun이
설치되어 있으면, 이미지를 빌드할 때마다 정식 호환성 매니페스트를 만든 다음, stdin으로 데이터 플레인
토큰을 한 번 초기화하고 허브를 시작하세요:

```bash
git clone https://github.com/lidge-jun/opencodex.git
cd opencodex
bun scripts/generate-compatibility-version.ts
docker compose build
openssl rand -hex 32 | docker compose run --rm -T hub bun run docker/bootstrap-token.ts
docker compose up -d
curl --fail --silent http://127.0.0.1:10100/healthz
curl --fail --silent http://127.0.0.1:10100/readyz
```

기본 호스트 바인딩은 `127.0.0.1:10100`입니다. 원격 노출은
`OPENCODEX_BIND_ADDRESS=<LAN-or-Tailscale-IP> docker compose up -d`를 명시해야 하며, `0.0.0.0`은
호스트의 모든 인터페이스를 엽니다. 방화벽과 인증된 TLS/tailnet 프론트엔드로 접근을 제한하세요.
생성된 JSON은 추적하지 않으며, `.git` 없이 이미지로 복사됩니다. 소스가 바뀌면 다시 생성하고,
생성과 빌드 사이에 소스를 고치지 마세요. 빌드는 낡은 매니페스트, 없거나 불일치하는 파일, 여분의
소스 파일, 심볼릭 링크를 거부합니다. 기록된 SHA-256을 빌드 컨텍스트와 복사된 런타임 파일
(`package.json`, `bun.lock`, 특별히 포함된 `scripts/model-metadata.source.json`)과 대조합니다.

토큰과 가변 상태는 `ocx-state` named volume에 남습니다. 이미지, Compose 파일, 환경, 셸 인자에는
자격 증명을 넣지 않습니다. 프로바이더 설정, 인증된 수락 검사, 원격 관리, 롤백은
[Remote Hub 배포 가이드](https://opencodex.me/ko/guides/remote-hub/)를 보세요.

</details>

<details>
<summary>소스에서 설치 (최신 dev)</summary>

**macOS / Linux:**

```bash
curl -fsSL https://bun.sh/install | bash
git clone https://github.com/lidge-jun/opencodex.git
cd opencodex && ~/.bun/bin/bun install
~/.bun/bin/bun run src/cli/index.ts start
```

**Windows (PowerShell):**

```powershell
irm bun.sh/install.ps1 | iex
git clone https://github.com/lidge-jun/opencodex.git
cd opencodex; bun install
bun run src/cli/index.ts start
```

소스 설치는 최신 `dev` 브랜치를 실행합니다. 메모리 소유권 패치, 런타임 GC 개선, 아직 npm 패키지에
안 들어간 수정이 여기에 먼저 있습니다.

</details>

<details>
<summary>에이전트용</summary>

```bash
npm install -g @bitkyc08/opencodex
ocx start     # 또는 `ocx service`
ocx init      # 대화형 설정: ~/.opencodex/config.json을 쓰고 Codex를 연결합니다
```

`ocx init`은 프록시를 시작하지 않습니다. 먼저 시작하세요. 나중이어도 순서는 상관없지만,
`ocx provider add`와 `ocx combo set` 같은 헤드리스 명령은 **실행 중인** 프록시와 통신하며
닿지 않으면 nonzero로 종료합니다. `ocx status` / `ocx doctor` / `ocx health`는 실행 상태를 보고합니다.

> **opencodex를 설치하거나 실행하는 에이전트:**
> [`AGENTS_INSTALL.md`](../AGENTS_INSTALL.md)를 읽으세요. 대화형 `ocx start`는 이 저장소를 star할지
> 한 번 물을 수 있습니다. 그 결정은 사용자 몫이며, 에이전트의 몫이 아닙니다. CLI는 에이전트 실행에서
> 프롬프트를 숨기고 API는 `403 agent_consent_required`로 거부합니다.

</details>

## 지원 플랫폼

| OS | 지원 상태 | 서비스 관리자 |
|---|---|---|
| macOS (arm64 / x64) | 완전 지원 | launchd |
| Linux (x64 / arm64) | 완전 지원 | systemd (user unit) |
| Windows (x64) | 완전 지원 | Task Scheduler (숨김) / 선택적 네이티브 서비스 (`--native`, WinSW) |

[Node](https://nodejs.org) 18 이상이 필요합니다. Bun 런타임은 `npm install` 때 번들되므로 따로 설치할
필요가 없고, Windows에서도 WSL이 필요 없습니다. npm이 번들 런타임의 설치 스크립트를 막았다면
[설치 문서](https://opencodex.me/ko/getting-started/installation/)를 보세요.

## 주요 기능

- **Codex, Claude Code, Claude Desktop, Grok Build에서 어떤 LLM이든** — 내장 프로바이더 40개 이상,
  각각 네이티브 UI를 유지합니다.
- **ChatGPT 계정 풀** — 스레드 affinity, 쿼터 기반 자동 전환, cooldown과 fail-closed 인증 처리.

  > **프로바이더 정책 안내:** 계정 풀은 라우팅과 운영 복원력만을 위한 것이며, 프로바이더 rate limit,
  > 제재, 정지, 기타 계정 조치로부터의 보호를 보장하지 않습니다. OpenCodex는 프로바이더 한도를
  > 우회하려고 추가 계정을 쓰거나, 계정 자격 증명을 사람들끼리 공유하는 행위를 지지하지 않습니다.
  > 각 프로바이더의 현행 약관을 지키는 책임은 사용자에게 있습니다.
  > [Codex Auth 계정 풀 가이드](https://opencodex.me/ko/guides/web-dashboard/)와
  > [OpenAI 이용 약관](https://openai.com/policies/terms-of-use/)을 확인하세요.
- **Combos** — failover나 가중 round-robin으로 프로바이더를 묶는 가상 모델 id 하나입니다.
  [combo 가이드](https://opencodex.me/ko/guides/combos/)를 확인하세요.
- **어떤 모델에서든 서브에이전트** — Codex 서브에이전트 선택기에 라우팅 모델을 올리고, v1/v2
  표면 제어와 fallback 체인을 둡니다.
  [서브에이전트 가이드](https://opencodex.me/ko/guides/sub-agent-surface/)를 보세요.
<!-- sponsors:main-first-mention -->
- **한 번 로그인하면 API 키는 생략** — xAI, Anthropic, Kimi는 OAuth. 아니면 `codex login`을
  forward하거나, 키를 붙여넣거나, `${ENV_VAR}` 참조를 씁니다.
- **웹 검색·비전 sidecar** — OpenAI가 아닌 모델도 ChatGPT 로그인 위의 sidecar로 실제 웹 검색과
  이미지 이해를 씁니다.
- **무슨 일이 일어나는지 보이게** — 대시보드가 프로바이더, OAuth 상태, 모델 선택, cache 토큰 수가
  찍힌 실시간 요청 로그를 보여줍니다.
- **깔끔한 종료, 잔여물 제로** — `ocx stop`이 Codex를 원래 설정으로 되돌립니다.
- **한도가 정해진 메모리 소유권** — 오래 사는 cache, ring buffer, 프로토콜 변환 저장소마다 정해진 cap,
  바이트 예산, 또는 활성 reconciliation이 있습니다. config를 다시 로드한 뒤 상한 없는 `Map`이나
  `Set`은 남지 않습니다.

<details>
<summary>메모리 소유권 상세</summary>

OpenCodex는 프로세스가 붙잡고 있는 상태 36종을 추적합니다. 각각에 문서화된 한도가 있습니다:

- **유지 저장소 12개**(요청 로그, debug ring, image cache, model cache, vision 설명, cursor blob,
  responses continuation 등)는 바이트 단위로 집계되며, 앱이 소유한 메모리 예산(기본 256 MiB)이
  eviction합니다.
- **관측 버퍼 4개**(translator accumulator, image/OAuth/Grok tail)는 진행 중 바이트 압력을 감시만
  하고 eviction하지 않습니다.
- **state-store 등록 24개**는 만료 sweep(60초 간격)과 config-generation reconciliation을 돌려,
  낡은 프로바이더/계정 키를 지웁니다.
- **경로·fingerprint 메모**(워크스페이스 메타데이터, hardened identity, 설치 salt, mode-hint
  capability)는 삽입 순서 LRU cap(8–128개)을 씁니다.
- **model-cache generation tombstone**은 reconciliation 뒤에 삭제됩니다. 전역 generation을 올려서,
  진행 중이던 낡은 discovery가 지워진 프로바이더를 다시 채우지 못하게 합니다.
- **Lab event-id 중복 제거**는 디스크 ledger lock 아래에서 돌며, 프로세스 RAM 인덱스는 없습니다.

관리자 토큰으로 `GET /api/system/memory`를 호출하면 현재 유지 바이트, eviction 카운터, watchdog
샘플을 볼 수 있습니다.

</details>

## 모델 라우팅

`provider/model` 구문으로 설정해 둔 프로바이더와 모델을 지정합니다:

```bash
codex -m "anthropic/claude-opus-5" "이 스택 트레이스를 설명해 줘"
codex -m "google/gemini-3-pro" "auth.ts의 유닛 테스트를 작성해 줘"
codex -m "ollama/llama3" "이 함수를 리팩터링해 줘"
```

`provider/` 접두사를 빼면 기본 프로바이더를 쓰거나 모델명 패턴으로 자동 매칭합니다. `/`가 들어 있는
프로바이더 모델 id는 안쪽 슬래시를 `-`로 alias해서 노출하고, 슬래시를 그대로 둔 원본 형태도 계속
동작합니다. 자세한 내용은 [모델 라우팅 문서](https://opencodex.me/ko/guides/model-routing/)를 보세요.

## 프로바이더 및 adapter

<!-- sponsors:main-first-mention -->
OpenAI (ChatGPT 로그인 또는 API 키), Anthropic, Google Gemini, xAI, Kimi, Azure OpenAI, Ollama
(로컬 + Cloud), Cursor (experimental), OpenAI 호환 엔드포인트 전부 — 여기에 DeepSeek,
Groq, OpenRouter, Together, Fireworks, Cerebras, Mistral, Hugging Face, NVIDIA NIM, MiniMax,
Qwen Cloud, Qoder Global과 CN (공식 PAT + CLI), SiliconFlow 등이 더 있습니다. 전체 목록은 `ocx init` 또는
[프로바이더 문서](https://opencodex.me/ko/guides/providers/)에서 확인하세요.

## CLI

```bash
ocx init                       # 대화형 설정 (config 작성, Codex 연결, shim 제안)
ocx start [--port 10100]       # 포그라운드에서 프록시 시작
ocx stop                       # 중지 + 네이티브 Codex 복원
ocx service [install|repair|restart|start|stop|status|uninstall|remove]  # 백그라운드 서비스
ocx codex-shim install         # `codex`가 뜰 때마다 프록시를 필요 시 시작
ocx health [--json]            # 프록시가 지금 살아 있는지 확인
ocx ready [--json] [--wait [--timeout <seconds>]]  # 동기화 후 준비 상태 확인
ocx status                     # 프록시가 실행 중인가?
ocx gui                        # 웹 대시보드 열기
ocx provider <...>             # 프로바이더 관리 (list/add/edit/test/remove)
ocx account <...>              # ChatGPT 계정 및 API-key 풀 관리
ocx combo <...>                # failover / round-robin combo 관리
ocx v2 <...>                   # 멀티에이전트 v1/v2 표면 제어
ocx update [--tag preview]     # opencodex 업데이트
```

포트를 고정하지 않고 시작하면 선호 포트가 사용 중일 때 다른 빈 포트로 옮겨갈 수 있습니다. `--port`를
명시하면 절대 옮기지 않습니다. 전체 레퍼런스: [CLI 문서](https://opencodex.me/ko/reference/cli/).

### 상태 확인과 준비

`GET /healthz`는 프록시가 지금 살아 있는지 바로 알려줍니다. 인증이 필요 없는 `GET /readyz`는 동기화가
끝난 뒤의 준비 상태를 민감 정보를 뺀 JSON identity `{service, version, uptime, pid, port, status}`로
돌려줍니다. `status`가 `ready`이면 `200`, `pending`과 최종 `failed`는 `Retry-After: 1`과 함께 `503`입니다.

`ocx ready [--json] [--wait [--timeout <seconds>]]`는 기본으로 한 번 probe합니다. `--wait`는 기본 최대
45초 동안 폴링하되, 최종 `failed`를 보면 즉시 종료합니다. `--timeout <seconds>`는 1–300초 한도를 정하고
`--wait`가 필요하며 양의 정수만 받습니다. CLI `--json` 출력은 `{ready, status, pid, port}`이고,
`status`는 `ready`, `pending`, `failed`, `unreachable`입니다.

| 종료 코드 | 결과 |
| --- | --- |
| `0` | 준비됨 |
| `1` | 준비되지 않음: pending, failed, timeout, unreachable |
| `64` | 잘못된 인자 |

`/readyz`가 없는 옛 프록시는 `unreachable`로 fail-closed되어 종료 코드 1을 내고, `ocx health`는
그대로 호환됩니다.

### 자동 시작: service vs shim

항상 켜 두고 크래시 때 다시 살릴 프록시면 **service** (`ocx service`)를 쓰세요. 백그라운드 데몬 없이
가볍게 필요할 때만 켜려면 **shim** (`ocx codex-shim install`)을 쓰세요. 제거는
`ocx service uninstall` / `ocx codex-shim uninstall`입니다.

### 삭제

```bash
ocx uninstall                  # 중지, service/shim 제거, 네이티브 Codex 복원, 상태 정리
npm uninstall -g @bitkyc08/opencodex
```

## 원격 접근

기본적으로 opencodex는 `127.0.0.1`에 바인딩되며 추가 인증이 필요 없습니다. 루프백 밖으로 바인딩하면
(`"hostname": "0.0.0.0"`) bearer 토큰이 **필수**입니다. `OPENCODEX_API_AUTH_TOKEN`이 없으면 프록시가
시작을 거부하고, 모든 클라이언트 요청은 `x-opencodex-api-key`로 토큰을 실어야 합니다. 자세한 내용은
[설정 레퍼런스](https://opencodex.me/ko/reference/configuration/)를 보세요.

## 문서

공개 문서(설치, 프로바이더, 라우팅, combo, 서브에이전트, sidecar, 통합, CLI/설정/management-API
레퍼런스)는 [`docs-site/`](../docs-site)에서 빌드되어 **[opencodex.me](https://opencodex.me/ko/)**에
게시됩니다.

유지보수용 source-of-truth 노트는 [`structure/`](../structure)에, 기여자 설정은
[`CONTRIBUTING.md`](../CONTRIBUTING.md)에, 보안 보고는 [`SECURITY.md`](../SECURITY.md)에 있습니다.
아직 공개되지 않은 취약점은 공개 이슈가 아니라
[GitHub 비공개 취약점 보고](https://github.com/lidge-jun/opencodex/security/advisories/new)로
비공개 제보하세요.
기술 창구는 이 양식뿐이고 보안 전용 메일 주소는 없습니다. 이후 논의도 비공개 보고 안에서 이어가세요.
공개 이슈에는 일정 조율 정도만 올릴 수 있고 취약점 내용은 올릴 수 없습니다. 접수 확인은 트리아지가
아니며, 최초 응답 시한도 약속하지 않습니다.

## 개발

소스 개발에는 `PATH`에 `bun` CLI가 있어야 합니다. 배포된 npm 패키지가 번들하는 Bun 런타임과는
별개이며, 그 런타임은 설치된 `ocx` 명령만 씁니다.

```bash
git clone https://github.com/lidge-jun/opencodex.git
cd opencodex
bun install
bun run typecheck
bun run test
```

**[기여하기](../CONTRIBUTING.md)**를 보세요.

메인테이너가 대신 올리거나 다시 구현해서 들어왔는데 커밋에 원저자가 적히지 않은 기여자 작업은
**[CREDITS.md](../CREDITS.md)**에 기록해 둡니다.

## 면책 조항

opencodex는 커뮤니티가 유지하는 독립 프로젝트이며, **OpenAI, Anthropic 등 어떤 프로바이더와도 제휴하거나 보증을 받지 않습니다.**

일부 프로바이더 — 특히 Anthropic (Claude) — 는 서드파티 프록시로 API 트래픽을 라우팅하는 계정을 정지하거나 제한할 수 있습니다. **사용 책임은 본인에게 있습니다 (UAYOR).** 프로바이더를 연결하기 전에 해당 서비스 약관에서 프록시 기반 접근이 허용되는지 확인하세요. opencodex 유지보수자는 업스트림 프로바이더가 취한 계정 조치에 책임을 지지 않습니다.

## 라이선스

MIT
