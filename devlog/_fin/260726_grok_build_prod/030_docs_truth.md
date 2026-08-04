# 030 — wp3: 문서 진실성 + 게이트 + PR 갱신

대상: `docs-site/src/content/docs/guides/grok-build.md`, `devlog/_plan/260723_grok_build_bridge/020_docs_and_residual_smoke.md`, 리시트, PR #403.

## 문서 수정 1 — 비루프백 안내가 틀렸다

현재 문구는 "비루프백이면 per-model `api_key`를 admission 토큰으로 바꿔라"고 한다. 두 가지가 틀렸다: (a) 다음 `ocx start`/`ensure`가 fence를 재생성하며 되돌린다, (b) `base_url`이 `127.0.0.1`로 남으면 애초에 도달 불가다.

wp1 이후로는 자동 생성 블록이 비루프백에서 `env_key`를 쓰므로, 안내는 "환경변수를 설정하라"로 바뀐다.

```diff
-## Authentication note
-
-Grok Build requires a non-empty API key for custom models even on loopback. The injected
-entries carry a placeholder (`opencodex-loopback`) — opencodex ignores admission keys for
-loopback connections, so no real secret is involved. If you bind the proxy on a
-non-loopback host, replace the per-model `api_key` with your opencodex admission token.
+## Authentication note
+
+Grok Build requires a credential for custom models even on loopback. On a loopback bind the
+injected entries carry a placeholder (`opencodex-loopback`) — opencodex ignores admission
+keys for loopback connections, so no real secret is involved.
+
+When the proxy is bound to a non-loopback host, opencodex requires a real admission token on
+every request. The generated entries then carry
+`env_key = "OPENCODEX_API_AUTH_TOKEN"` instead of a literal key: Grok Build reads the token
+from that environment variable at request time, so no secret is written into your shared
+`~/.grok/config.toml`. Export the same value you gave the proxy:
+
+```bash
+export OPENCODEX_API_AUTH_TOKEN="…"   # same token the proxy was started with
+grok -m ocx-… -p "hello"
+```
+
+If the variable is unset, Grok Build fails closed for those models rather than falling back
+to your xAI session token.
```

예시 TOML 블록에도 비루프백 변형을 덧붙인다.

## 문서 수정 2 — hot-reload를 약속하지 않는다

소스에는 `ConfigFileWatcher` → `ConfigUpdate::ModelsChanged` 경로가 실제로 있지만 (`180_grok-build .../config/reloader.rs:385`), docs.x.ai는 이를 보장하지 않고 `grok inspect` 후 세션 재선택을 안내한다. 버전 보장 없이 "watch하고 hot-reload한다"고 쓰면 안 된다.

```diff
-- **Config read timing:** start opencodex first, then launch `grok` for the most
-  predictable results. Recent Grok Build versions watch `config.toml` and hot-reload
-  `[model.*]` changes into an open session; older builds may need a restart.
+- **Config read timing:** start opencodex first, then launch `grok` for the most
+  predictable results. If you refresh the catalog while `grok` is already open, run
+  `grok inspect` to confirm the config was picked up, then reopen the session or
+  re-select the model with `/model`. Some builds do pick up `[model.*]` edits without a
+  restart, but that is not a documented guarantee — don't rely on it.
```

## 문서 수정 3 — 매뉴얼 레시피의 도달 가능한 호스트

CodeRabbit 지적대로 매뉴얼 예시가 `127.0.0.1` 고정이다. `base_url`은 grok이 실제로 도달할 수 있는 주소여야 한다는 주석을 추가한다(`endpoint()`가 `base_url`에 상대 결합하며 `/v1` 주입은 없음 — `xai-grok-sampler/src/client.rs:703`).

## 데브로그 수정 — 이전 유닛의 backend 권장이 자기모순

`260723_grok_build_bridge/020_docs_and_residual_smoke.md:11`은 `responses`를 권장하지만, 같은 유닛 `011_receipt.md:53-55`는 grok이 `response.heartbeat`에서 이탈함을 기록했고 이후 계획은 그래서 `chat_completions`로 고정했다. 계획 문서를 실제 결정에 맞춘다 (과거 문서를 지우지 않고 정정 사유를 남긴다).

## 최종 게이트

```
bun run typecheck
bun run test
bun run privacy:scan
```

세 개 모두 green이어야 하며, 각 출력의 실제 tail을 `031_receipt.md`에 남긴다.

## PR 갱신

`dev`가 그동안 움직였는지 `git fetch origin dev` 후 확인하고, 필요하면 다시 리베이스한 뒤 게이트를 재실행한다. 그다음 `codex/260726-grok-build-prod`를 push하고 PR #403 본문에 이번 수정 요약(각 블로커 → 해소 방식 → 증거 테스트 이름)을 추가한다. 머지는 하지 않는다.
