---
title: Codex Upload Reduction
description: Optional incremental WebSocket uploads and lossy historical context slimming.
---

These default-off top-level options apply to native ChatGPT Codex requests. See [provider configuration](/reference/configuration/providers/) for other settings.

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `codexWsIncrementalUpload?` | `boolean` | `false` | Experimental native ChatGPT Codex upload reduction. Implies cross-turn socket reuse. After an acknowledged completed response, an exact matching input prefix can be replaced by `previous_response_id` and only new input items. Clients may keep using HTTP/SSE; `websockets` controls only client-facing upgrades. History/settings/account/route changes and expired sockets require a full create. If the backend explicitly rejects a proxy-synthesized continuation ID as missing before any response activity, the proxy resends the retained full request once under the same caller and dispatch guards; caller-supplied IDs and unknown delivery are never replayed by this recovery. Explicit HTTP provider proxies are preserved; SOCKS, direct overrides and custom executors keep their existing fallback. Restart after changing this flag. Idle sockets are retained for up to 10 minutes and 50 minutes total age; the 32-socket and 256-exchange bounds remain. |
| `upstreamHistorySlim?` | `"off" \| "codex"` | `"off"` | Optional **lossy** native Codex history policy. Before the latest user message, inline images larger than 1 KiB become text placeholders and tool output text larger than 32 KiB is shortened to its first 2 KiB and last 1 KiB. Current-turn items, local history, remote image URLs and file references remain intact. This does not guarantee that each image is uploaded exactly once, and the model cannot inspect an omitted old image on a full replay. Use `off` when historical image detail must remain available. HTTP/SSE sends apply this setting on its own; ordinary upstream WebSocket creates are slimmed only when `codexWsIncrementalUpload: true` is also set. |
