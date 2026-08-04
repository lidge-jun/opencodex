# 010 — WP1 REPLY-ONLY 실행 계획 (영어 코멘트/클로즈)

원칙: 모든 GitHub 코멘트는 영어. 클로즈는 근거 코멘트 후에만.

**sol A-gate 감사 반영 amendment (2026-07-22):**

| 대상 | 액션 | 코멘트 골자 (영어로 작성) |
|---|---|---|
| 이슈 #252 | 코멘트만 (open 유지, enhancement 재분류) | Haiku-등 저티어 모델을 placeholder로 쓰자는 유효한 UX 제안 — enhancement로 인정, 표시 의미론(실제 라우팅은 정상) 설명 + backlog 등재. 클로즈하지 않음 |
| 이슈 #241 | 코멘트만 (open 유지, upstream-tracking) | Codex Desktop remote allowlist가 원인(proxy 밖). upstream tracking으로 오픈 유지 — 발견성 보존 |
| 이슈 #208 | 코멘트만 (open 유지) | chat/completions 요구 계약(엔드포인트/스트리밍/툴콜 범위) 상세 요청. 무응답 시 후속 클로즈 |
| 이슈 #92 | 코멘트만 (open 유지) | maintainer가 재현 지속 + upstream fix tracking 목적으로 오픈 유지 중 — 클로즈 금지. 상태 요약 코멘트만 |
| PR #260 | 액션 불필요 (stale 분류) | 이미 dev retarget + draft 해제 완료됨 (감사 실측). gui/ 터치이므로 WP4 GUI-blocked 레인으로 이동 |

추가: **PR #262** (신규, src/cli/init.ts + src/router.ts, non-GUI, 이슈 #257 인접 UX) — WP2 SMALL-SAFE 후보로 편입.

## 영어 코멘트 드래프트 (WP1 B-phase에서 발사)

### #252 (comment only, keep open — enhancement) [sol 감사 반영 v2]

> Thanks for the report — the confusion is understandable. When a subagent turn shows "Sonnet", it can be a placeholder label rather than proof of which model actually served the request, which makes placeholder-labeled calls hard to distinguish from genuine Sonnet calls. That ambiguity is exactly the problem you're describing.
>
> Your suggestion — using an explicitly low-tier placeholder such as Haiku so it is less likely to be mistaken for a genuine Sonnet call — is a fair UX enhancement. Keeping this open as an enhancement request for the display/labeling backlog. If you can capture a case where the routed model demonstrably differs from what was executed (not just labeled), please attach it; that would upgrade this from a labeling issue to a routing bug.

### #241 (comment only, keep open — upstream tracking)

> Status update after investigation: the missing entries are caused by Codex Desktop's remote model allowlist, which filters what the picker shows on the client side. OpenCodex correctly advertises the routed models through the app-server (as your logs show — they are loaded), but the Desktop picker only renders models on its own allowlist. This is outside what the proxy can control.
>
> Keeping this open as an upstream-tracking issue so others hitting the same behavior can find it. If Desktop exposes a supported control for this allowlist, we can reassess whether any OpenCodex-side change is needed.

### #208 (comment only, keep open — needs spec)

> Thanks for the request. To scope this properly we need a concrete contract, since "chat/completions compatibility" can mean very different things. Could you specify:
>
> 1. Which endpoint shape you need (`POST /v1/chat/completions` OpenAI-compatible?) and from which client/tool?
> 2. Whether you need streaming (SSE) support, tool/function calling, or both?
> 3. A sample request that currently fails, with the expected response shape?
>
> With a reproducible example we can evaluate this against the existing responses/adapters surface. Without a concrete contract we can't act on it, so this stays open pending details.

### #92 (comment only, keep open — upstream tracking)

> Status summary for anyone landing here: this remains reproducible and open intentionally. Root cause is on the upstream Codex CLI client side — the NEW_TASK body is sent as `encrypted_content` that a cross-provider child cannot decrypt, so no proxy-side transformation can recover it. The documented reliable workaround is to use V1 sub-agent mode for heterogeneous (cross-provider) subagents.
>
> We're keeping this open to track the upstream fix.

증거: 각 gh 명령 출력(코멘트 URL, state) 캡처 → 본 문서 하단 결과 섹션에 추가.


## 결과 (2026-07-22 실행)

| 대상 | 코멘트 URL | 상태 |
|---|---|---|
| #252 | issues/252#issuecomment-5042561116 | OPEN 유지 (enhancement) |
| #241 | issues/241#issuecomment-5042563073 | OPEN 유지 (upstream-tracking) |
| #208 | issues/208#issuecomment-5042563236 | OPEN 유지 (spec 대기) |
| #92 | issues/92#issuecomment-5042563383 | OPEN 유지 (upstream-tracking) |
| PR #260 | 무액션 (이미 dev retarget/draft 해제, WP4 GUI-blocked 레인) | OPEN |

클로즈 0건 — sol 감사 결정에 따라 전건 오픈 유지.
