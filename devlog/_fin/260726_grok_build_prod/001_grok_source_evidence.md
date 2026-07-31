---
created: 2026-07-26
status: research
tags: [grok-build, upstream-source, evidence]
---

# 001 — grok-build 원본 근거 (설계 결정의 기준)

참조 트리: `/Users/jun/Developer/codex/180_grok-build`.
**실측 HEAD `a5727c5960452e7527a154b25cb5bf00cda0545e`** ("Synced from monorepo", 2026-07-22),
`SOURCE_REV` = `30192d2eef5d91a8fff0e53957de5bd05b43398c`.
(이전 devlog가 인용한 `b189869`는 이 클론 히스토리에 없다 — 인용 갱신.)
모든 인용은 Rust 크레이트 원본이며 분석 마크다운이 아니다.

## E1 — 설정 로딩과 중복 테이블 실패 범위

`crates/codegen/xai-grok-config/src/loader.rs:13` → `toml` 0.9 (`Cargo.lock` `toml 0.9.12+spec-1.1.0`).
레이어 병합 순서(낮음→높음): 시스템 managed → 사용자 managed → **`~/.grok/config.toml`** →
사용자 requirements → 시스템 requirements → macOS MDM.

중복 `[model.x]`는 **해당 레이어 전체를 거부**한다(`std::io::Error::other(detail)`).
에러 문자열은 `loader.rs:44-52`의 `toml_error_detail`이 span에서 만들며 실측 재현 결과:

```
TOML parse error at line 4, column 8: duplicate key
```

`Display`를 쓰지 않는 이유가 원본 주석에 있다 — 문제 줄을 그대로 출력하면 그 줄에 담긴 비밀이
로그로 샌다. 우리도 같은 이유로 사용자 설정 원문을 에러에 싣지 않는다.

**결론(B3):** `[model.x]`와 `[model."x"]`는 같은 테이블이다. 하나만 중복돼도 사용자의 다른 모든
설정까지 함께 죽는다. 첫 세그먼트 인용 형태를 반드시 정규화해야 한다. 또 점이 포함된 alias는
반드시 인용해야 한다(`[model.grok-4.5]`는 키 경로이지 id가 아니다 — grok 자체 테스트가 이 함정을 문서화).

## E2 — `[model.<alias>]` 스키마

`crates/codegen/xai-grok-shell/src/agent/config.rs:3915` `ConfigModelOverride`,
`#[derive(Deserialize, Default)] #[serde(default)]`. **필수 필드 없음**, `deny_unknown_fields` 없음.
수용 필드 34개. 우리 블록과 관련된 것:
`model`, `base_url`, `name`, `api_key`, `env_key`, `auth_provider`, `api_backend`,
`extra_headers`, `context_window`(`NonZeroU64` — 0은 무시됨).

`auth_scheme`는 **모델 블록에서 설정 불가**하며 기본값 `Bearer`다.
알 수 없는 필드는 치명적이지 않다 — `serde_ignored`로 경고만 남기고 항목을 살린다
(`config_model_override_parse.rs:266-302`, "관리 설정이 카탈로그 항목을 잃으면 안 된다").

## E3 — 비밀 없이 인증하기 (B1 설계의 핵심 근거)

와이어 포맷: `Authorization: Bearer <key>` (`xai-grok-sampler/src/client.rs:404-433`).

자격 증명 우선순위 (`config.rs:4678-4688`):
`api_key` → `env_key` → auth_provider 캐시 토큰 → 세션 토큰 → `XAI_API_KEY`.
**공백뿐인 `api_key`는 무시되고 `env_key`로 폴백한다** (`first_own_credential`이 `!k.trim().is_empty()` 필터).

| 방식 | 동작 | 해석 실패 시 |
|------|------|-------------|
| `env_key = "VAR"` 또는 `["V1","V2"]` | 요청 시점에 lazy 해석, 처음 채워진 값 사용 | **다음 우선순위로 폴백** (아래 정정 참조) |
| `api_key = "${VAR}"` | 로드 시 `shellexpand` 확장 | 미설정이면 **리터럴 `${VAR}`을 토큰으로 전송** |
| `auth_provider` | 헬퍼 명령 stdout에서 토큰 획득 | 파일/회전 토큰용 |

### 정정 (2026-07-26 A-게이트 감사) — `env_key`는 fail-safe가 아니다

초판은 "`env_key`가 해석되지 않으면 grok이 키 없이 호출한다"고 적었다. **틀렸다.**
`resolve_credentials`(`config.rs:4689-4715`)의 실제 폴백 사슬은:

```rust
let (api_key, base_url, auth_type) = if let Some(key) = model.own_credential() { ... }
else if let Some(provider) = model.auth_provider.as_ref() { ... }
else if let Some(key) = session_key {            // ← 로그인된 grok 세션 JWT
    (Some(key.to_owned()), info.base_url.clone(), AuthType::SessionToken)
} else if let Ok(key) = read_xai_api_key_env() { // ← XAI_API_KEY
```

`base_url`은 **우리가 쓴 URL** 그대로다. 상위 테스트가 이 동작을 못박는다:
`resolve_credentials_empty_env_key_falls_through_to_session`(`config.rs:6550`)은
`AuthType::SessionToken`과 `api_key == Some("session-jwt")`를 단언한다.

fail-closed 경로는 존재하지만 `model_provider`가 설정된 경우에만 붙는다(`config.rs:3510-3513`).
우리 블록은 `model_provider`를 방출하지 않으므로(모델 공급자 상속이 라우팅되지 않는다는 이유로
의도적으로 제외) 해당 보호가 걸리지 않는다.

**보안 결론:** 비루프백 블록에서 `api_key`를 빼고 `env_key`만 쓰면, 사용자가 변수를 export하지
않았을 때 grok이 **xAI 세션 토큰을 평문 HTTP LAN 주소로 전송**한다. 현재의
`api_key = "opencodex-loopback"`은 비어 있지 않은 own-credential이라 사슬을 즉시 끊고 401로 끝난다.
즉 제안했던 설계는 무해한 401을 자격증명 유출로 바꾸는 **퇴행**이다. 채택하지 않는다.

**결론(B1):** 메인테이너가 요구한 대로 비루프백에서는 **fence 자동 등록을 하지 않는다.**
`env_key`는 문서에 수동 레시피로만 남기고, 반드시 `model_provider` 또는 자리표시자 `api_key`와
짝지어야 세션 토큰 폴백이 막힌다는 경고를 함께 적는다.

## E4 — 핫리로드는 실재한다 (B7 부분 반박)

`xai-grok-shell/src/config/watcher.rs`가 `~/.grok/`의 `config.toml`을 감시한다
(notify + debouncer, **1000 ms 디바운스**). 리로더는 `[model]` 테이블을 `toml::Value`로 비교하고
달라졌을 때만 `ConfigUpdate::ModelsChanged`를 보낸다(`reloader.rs:385-393`):

```rust
if old_model_table != new_model_table || old_models_table != new_models_table {
    info!("model config change detected");
    let _ = self.config_update_tx.send(ConfigUpdate::ModelsChanged);
}
```

자기 쓰기 억제는 **의도적으로 없다** — 외부 프로세스(우리)의 쓰기가 삼켜지지 않도록 콘텐츠 기반
중복 제거를 대신 쓴다(`watcher.rs:106-117`).

**결론(B7):** "핫리로드가 없으니 `grok inspect` 후 세션을 다시 열라"는 지적은 원본과 맞지 않다.
열린 세션에 `[model.*]` 변경이 반영되는 것은 사실이다. 다만 문서에는 버전 보증 대신
"감시 기반 리로드가 있고, 확인은 `grok inspect`"로 쓰고, 원자적 쓰기 필요성을 함께 적는다.
잘못된 config는 레이어 전체를 죽이므로 반쯤 쓰인 파일이 관측되면 안 된다 — 우리는 이미
`atomicWriteFile`을 쓰고 있으며 이 계약을 문서화한다.

## E5 — `api_backend`와 `response.heartbeat` (B8 확증)

`xai-grok-sampling-types/src/types.rs:1010` `ApiBackend`는 정확히 세 값:
`chat_completions`(기본), `responses`, `messages`.
(원본 config 주석은 `messages`를 빠뜨린 stale 주석이다.)

`responses` 백엔드에서 알 수 없는 최상위 `type` 태그는 **치명적**이다:
- 이벤트 열거형(async-openai 포크 `95b52ebd`)에 `#[serde(other)]`도 `Unknown` 변형도 없다.
- `client.rs:99-129`의 재시도는 `/response/tools`만 정리하므로 태그 오류를 못 살린다.
- 삼켜지는 비표준 이벤트는 doom-loop 체크 이벤트 하나뿐(`doom_loop.rs:252-260`).
- `SamplingError::Serialization`은 **재시도 불가**로 분류된다(`error.rs:245`).

**결론(B8):** `011_receipt.md`의 관측(그록이 `response.heartbeat`에서 종료)은 원본 코드로 설명된다.
`chat_completions` 권장은 정당하며 `responses`는 알려진 한계로 기록한다.

## E6 — `grok inspect`가 실제로 보여주는 것

`xai-grok-shell/src/inspect/mod.rs:281`. `Config Sources` 섹션은 각 레이어를
`User: /path (empty|parse error)` 형태로 출력하며, note는 **실제 로더를 돌려서** 계산한다.
모델 카탈로그 섹션은 없다 — 대신 `Config Warnings`가
`[model."<alias>"] <field> — <reason>` 형태로 거부된 필드를 보고한다.

**결론:** 문서에서 `grok inspect`는 "설정이 파싱됐는지와 어떤 필드가 거부됐는지 확인하는 명령"으로
정확히 소개한다. "모델 목록을 보여준다"고 쓰면 틀린다.
