---
title: Account Auto-pause
description: Opt-in automatic pausing of accounts after exact permanent refusals.
---

## Auto-pause permanently refused accounts

`providers.<provider>.accountAutoPause` is opt-in and defaults to off. It applies to that
provider's OAuth accounts, Codex pool accounts (including the main account in pool mode),
and configured API-key pool entries. For example:

```sh
ocx config set providers.anthropic.accountAutoPause.enabled true
ocx config set providers.anthropic.accountAutoPause.consecutiveFailures 2
```

`consecutiveFailures` is an integer from 1 to 100; omitting it uses 2. Only exact,
account-scoped HTTP 401/403 refusals qualify: an organization forbidding OAuth, an inactive
or expired subscription, an account denied API/Claude Code access or disabled by Google for a Terms of Service violation, or a downgrade to a free
plan with no credits. A model permission error, expired access token, quota window, 429,
5xx, malformed response or network failure never pauses an account.

The counter is process-local, serialized per account, and resets on a successful HTTP
response, explicit resume or a new login. Token refresh alone does not reset an OAuth
account's streak. Transient errors leave the counter unchanged. Restarting the proxy clears
counters; completed pauses, their fixed reason codes and timestamps persist. Independent
proxy processes maintain independent counters. Changing, disabling or re-enabling the policy, disabling the provider,
or changing its endpoint discards in-flight refusal observations, so a refusal from a request
sent under the earlier policy can never pause an account afterwards. A refusal counts only for the credential that actually
reached the upstream: when a local plugin rewrites the credential or destination of a send, that
send never counts toward a pause. For Codex pool accounts this includes the workspace
(`chatgpt-account-id`) the request was sent for.

At the threshold, OpenCodex excludes the account using its existing pause mechanism and
attempts an eligible sibling for the current request within the existing retry/send budget.
Fixed Codex account selectors and account-bound uploaded files retain their restrictions.
A pause never cancels already dispatched work or changes credentials. It emits one generic
log line without account identifiers or upstream error text.

`ocx account list <provider>` shows the pause reason. The dashboard's Paused badge exposes
the reason and time. Use `ocx account resume <provider> <account-id-or-alias>` to clear the
reason and allow selection again. On an API-key row, clicking Resume also activates the key.
This policy never resumes an account automatically.
