# 010 — Normalize openai-chat Chat Completions URL

Consumes 000_plan.md. Isolated worktree only.

## Isolated checkout

Do not touch the dirty /Users/jun/Developer/opencodex worktree beyond this unit and the goalplan.
Use an isolated remote-tip worktree, preferred path:

/Users/jun/Developer/opencodex-chat-baseurl

Branch: codex/openai-chat-baseurl-normalize from origin/dev.

## File map

### NEW src/adapters/openai-chat-url.ts

Keep the helper tiny and regex-compatible so it matches tests/url-normalization.test.ts style.

```ts
const TRAILING_SLASHES = /\\/+$/;
const TRAILING_CHAT_COMPLETIONS = /\\/chat\\/completions\\/?$/;

export function openaiChatCompletionsUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(TRAILING_SLASHES, "");
  const withoutEndpoint = trimmed.replace(TRAILING_CHAT_COMPLETIONS, "");
  return `${withoutEndpoint}/chat/completions`;
}
```

Regex contract:

- /+$/ only for trailing slashes
- /\\/chat\\/completions\\/?$/ only at end; does not match mid-path
- does not match chat/completions-extra
- after strip, always append exactly /chat/completions

Before/after examples:

| input | output |
| --- | --- |
| https://api.teamwicked.me/v1 | https://api.teamwicked.me/v1/chat/completions |
| https://api.teamwicked.me/v1/ | https://api.teamwicked.me/v1/chat/completions |
| https://api.teamwicked.me/v1/chat/completions | https://api.teamwicked.me/v1/chat/completions |
| https://api.teamwicked.me/v1/chat/completions/ | https://api.teamwicked.me/v1/chat/completions |
| https://proxy.example.com/v1/relay | https://proxy.example.com/v1/relay/chat/completions |
| https://api.example.com/somechat/completions | https://api.example.com/somechat/completions/chat/completions |

### MODIFY src/adapters/openai-chat.ts

Before (src/adapters/openai-chat.ts:978):

```ts
const url = `${provider.baseUrl}/chat/completions`;
```

After:

```ts
import { openaiChatCompletionsUrl } from "./openai-chat-url";
// inside buildRequest:
const url = openaiChatCompletionsUrl(provider.baseUrl);
```

Do not persist-normalize config.providers.*.baseUrl in this unit. Send-path normalization is enough and avoids rewriting user config / discovery unexpectedly.

### NEW tests/openai-chat-url.test.ts

Mirror tests/url-normalization.test.ts:

- import openaiChatCompletionsUrl
- table of the four Teamwicked-shaped bases
- mid-path /v1/relay keeps the relay segment
- somechat/completions is not stripped
- whitespace-only trim on the input

Also add one adapter-level assertion in the same file: createOpenAIChatAdapter with baseUrl https://api.example.test/v1/chat/completions/ yields url === https://api.example.test/v1/chat/completions.

Reuse the existing parsed-request fixture from tests/openai-chat-hardening.test.ts / tests/cl01-openai-chat-review-regressions.test.ts. Do not stand up a server.

### OPTIONAL docs

Only if an existing English sentence in docs-site adapters.md or guides/providers.md claims the adapter concatenates baseUrl + /chat/completions with no exception. Then add one sentence: a trailing /chat/completions or / is stripped first. No locale sweep in this unit unless the English sentence already has a 1:1 translated twin that would become false.

### GitHub issue #1582

Comment (no secrets) with:

- trailing-slash live matrix above
- constructed URL after /v1/ vs /v1
- proof that /v1 works (OK on chat + responses)
- pointer to this unit and the upcoming branch

### Git

In the isolated worktree:

bun test tests/openai-chat-url.test.ts tests/url-normalization.test.ts
git add src/adapters/openai-chat-url.ts src/adapters/openai-chat.ts tests/openai-chat-url.test.ts
git commit -m "fix(adapters): accept pasted /chat/completions openai-chat baseUrl"
git push --no-verify -u origin HEAD

Do not --force. Do not run from the dirty main checkout.

## Verifier / activation

- Trigger doubled path via unit test, not live Teamwicked (key stays out of tests).
- Trigger trailing slash via unit test matching the live 404 shape.
- C command: bun test tests/openai-chat-url.test.ts
- Extra: bun test tests/url-normalization.test.ts to prove the regex family still matches the anthropic sibling.
