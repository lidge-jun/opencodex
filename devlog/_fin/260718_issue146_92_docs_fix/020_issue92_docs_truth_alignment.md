# 020 — #92 docs truth alignment + upstream issue draft

Scope: soften the unconditional "cross-model v2 spawn calls actually stick"
claim on six surfaces and produce a ready-to-file upstream issue draft.
No source-code change; the runtime limitation lives client-side.

## Known limitation text (English canonical)

> Known limitation: when a **native** parent (e.g. gpt-5.6-sol on v2) spawns a
> child routed to a **non-native** provider, the Codex client may send the
> `NEW_TASK` payload only as backend-encrypted `encrypted_content`; the routed
> child then receives an empty task body (tracked as opencodex#92). Overrides
> with `fork_turns: "none"` apply the model correctly, but the task text can be
> lost. For heterogeneous-provider delegation, the v1 surface remains the
> reliable choice.

## MODIFY [README.md](../../../README.md) `:222`

- "…the `fork_turns` rules that make cross-model `spawn_agent` calls actually
  stick" → "…the `fork_turns` rules that let cross-model `spawn_agent` calls
  apply their overrides". Append one sentence: "For native→routed children the
  task body can currently arrive encrypted (#92); use v1 for reliable
  cross-provider delegation."

## MODIFY [README.ko.md](../../../README.ko.md) `:207`, [README.zh-CN.md](../../../README.zh-CN.md) `:110`

- ko: "크로스모델 `spawn_agent` 호출이 실제로 먹히게 하는" → "크로스모델
  `spawn_agent` 오버라이드를 적용하는" + 한 문장 제한 고지(#92, v1 권장).
- zh: "让跨模型 `spawn_agent` 调用真正生效的" → "让跨模型 `spawn_agent`
  覆盖得以应用的" + 同样一句限制说明.

## MODIFY docs-site sub-agent-surface.md (en/ko/zh-cn)

- en `:9` `:::note`: after the existing override explanation, append the Known
  limitation sentence (shortened) linking issue #92; mirror in ko `:9` and
  zh-cn `:9` notes.
- en Modes table v2 row (and ko/zh equivalents): append "task body may arrive
  encrypted for native→routed children (#92)".
- Dashboard bullet `:49` in ALL THREE locales (en "makes the selected model
  actually take effect" equivalent, ko, zh-cn "真正生效"): soften the
  unconditional claim the same way — the override applies, but the task body
  can arrive encrypted for native→routed children (#92).

## NEW artifact (in this doc, not filed): upstream issue draft — COMPLETE TEXT

B-phase task: update the placeholders (client version, opencodex version,
subscription plan — the upstream Codex App/CLI issue templates require
subscription in addition to version; pick the CLI template unless the repro
used the App), re-run the reproduction to refresh the probe JSON, then hand
to DC-3 for filing approval. Everything else is final text.

---

**Title:** `spawn_agent (multi_agent_v2): NEW_TASK body is sent only as
encrypted_content when a native parent spawns a model-overridden child — routed
children receive an empty task`

**Body:**

### Summary

On the v2 multi-agent surface, when a parent session running a native model
(e.g. `gpt-5.6-sol`) spawns a child with `fork_turns: "none"` and a `model`
override that resolves to a non-native (proxy-routed) provider, the child's
`NEW_TASK` input item carries an empty plaintext payload plus a Fernet-shaped
`encrypted_content` block. The model override itself applies correctly (the
child `turn_context` confirms it), but the task text is unrecoverable by any
backend other than the encrypting one, so the routed child starts with no
concrete task and either reports that or infers an unrelated task from
surrounding context.

### Environment

- Codex client: <App/CLI version at filing time>
- Subscription: <plan at filing time — required by the upstream template>
- Platform: macOS (issue #92 reporter environment was Windows; both affected)
- Proxy: opencodex <version> (`multiAgentMode: "v2"`), issue
  lidge-jun/opencodex#92
- Parent model: `gpt-5.6-sol` (native, v2 surface)
- Child spawn: `spawn_agent` with `fork_turns: "none"`, `model: "xai/grok-4.5"`

### Reproduction

1. Start a v2 session on a native model behind a Responses-API proxy.
2. Call `spawn_agent` with `fork_turns: "none"` and a model override that the
   proxy routes to a third-party provider.
3. Inspect the child's first request as received by the proxy.

Observed (opencodex dev-HEAD probe, 2026-07-18):

```json
{
  "rewritten": 0,
  "parsedContent": "Message Type: NEW_TASK\nPayload:\n",
  "encryptedStillPresent": true
}
```

### Expected

The child's `NEW_TASK` payload is readable by the child's resolved backend:
either `SpawnAgentArgs.message` is retained as plaintext when the child's
resolved model is not served by the encrypting backend, or the plaintext is
duplicated alongside the ciphertext for that case.

### Actual

Only `encrypted_content` (Fernet) carries the task; plaintext is empty. A
proxy cannot decrypt it, and the routed child receives
`Message Type: NEW_TASK\nPayload:` with no body.

### Notes

- Same-backend children (no override, or overrides within the native family)
  appear unaffected in our testing to date.
- This is distinct from the earlier plaintext-parked-in-encrypted-slot case
  (addressed by the patch associated with closed opencodex PR #94 and
  subsequently landed on dev; regression-pinned in
  tests/multi-agent-compat.test.ts:364/405/418) and from compaction/429
  reports; the payload here is pure ciphertext.

---

## Checks

- Locale parity grep: `rg -n "#92|issue 92" README*.md docs-site | wc -l` ≥ 6.
- Docs gate: docs-site build green (`cd docs-site && npm run build`, the repo's
  actual gate — `bun run docs:check` does not exist); no i18n lint regressions.
- Rollback: single revert commit.
