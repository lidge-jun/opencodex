# 008 — Bucket 1 Draft Replies (NOT posted — awaiting user approval)

These are prepared responses for issues classified "answer + close". Posting
comments and closing issues are external mutations and require explicit user
approval; nothing here has been sent.

## #280 —出现了codex无法通信的问题 → close after reply

Evidence: reporter confirmed 2026-07-22 11:20Z that after
`ocx provider add openai --sync` + restart, new and existing threads work.

Draft (Chinese, matching thread language):

> 是的，这是配置问题，不是 proxy 的 bug：你的 OpenAI(ChatGPT)登录凭据存在，但路由配置里没有启用 `openai` provider，所以 bare 模型（如 `gpt-5.6-sol`）按设计 fail closed。执行 `ocx provider add openai --sync` 后两个 provider 并存，问题即解决。
>
> 一个后续建议：`ocx init` 会生成全新的单 provider 配置，已有自定义 provider 时请改用 `ocx provider add <name> --sync`，避免覆盖现有配置。
>
> 既然已确认恢复，我将关闭此 issue。如果之后在新 thread + native 模型下仍出现 `encrypted content ... could not be decrypted`，请按 #92 的链路灯塔重新打开或留言。

Close reason: resolved (user configuration; not a proxy regression).

## #291 — Providers 페이지 edit 버튼 → close after reply (reporter confirmation)

Evidence (verified against origin/dev):

- Edit form exists: `gui/src/components/provider-workspace/ProviderSettings.tsx:115`
  (`save()` patches adapter/baseUrl/defaultModel/authMode/note/allowPrivateNetwork).
- Rendered from `gui/src/components/provider-workspace/ProviderDetails.tsx:262`.
- Save path: `onUpdateProvider` → `PATCH /api/providers`
  (`gui/src/pages/Providers.tsx:768`), accepted server-side at
  `src/server/management-api.ts:631+`.

Draft (English):

> Good news — this already exists. On the Providers page, open a provider to
> enter its workspace; the **Settings** tab there edits adapter, base URL,
> default model, auth mode, note, and `allowPrivateNetwork` in place (saved via
> `PATCH /api/providers`), so delete + re-add is no longer needed.
>
> If you were looking for an edit affordance directly on the provider list row
> (without entering the workspace), let us know — that would be a small UX
> addition. Otherwise I'll close this as already-shipped.

Close reason: already implemented (pending reporter confirmation); optionally
keep open only if they want the row-level edit button specifically.
