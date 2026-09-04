# 010 — wp2: deviceauth grant core (stack layer 1)

Branch: `codex/deviceauth-core`, based on `origin/dev` `b5777aa2d642`.
Thesis: implement the OpenAI deviceauth grant as a self-contained module and let
`loginChatGPT` select it. Nothing outside `src/oauth/` changes in this layer.

## Files

- ADD `src/oauth/chatgpt-device.ts` — the grant.
- MODIFY `src/oauth/chatgpt.ts` — export `credsFromToken` for reuse; add the
  `flow` option to `loginChatGPT`.
- MODIFY `src/oauth/index.ts` — thread `flow` through the `chatgpt` registry entry.
- ADD `tests/chatgpt-device-auth.test.ts`.
- MODIFY `tests/oauth-device-code-contract.test.ts` — extend the shared contract to chatgpt.

## Wire protocol (from codex-rs device_code_auth.rs)

1. `POST https://auth.openai.com/api/accounts/deviceauth/usercode`
   JSON `{ client_id }` -> `{ device_auth_id, user_code, interval? }`
2. `POST https://auth.openai.com/api/accounts/deviceauth/token`
   JSON `{ device_auth_id, user_code }`; 403/404 = pending; 200 =
   `{ authorization_code, code_verifier }`
3. `POST https://auth.openai.com/oauth/token` form-encoded
   `grant_type=authorization_code`, `client_id`, `code`, `code_verifier`,
   `redirect_uri=https://auth.openai.com/deviceauth/callback`

Poll window 15 minutes; default interval 5s; the interval field may arrive as a
string, so coerce numerically and floor at 1s.

## Signatures

```ts
export type ChatGPTLoginFlow = "browser" | "device";
export async function loginChatGPTDevice(ctrl: OAuthController): Promise<OAuthCredentials>;
export async function loginChatGPT(
  ctrl: OAuthController,
  opts?: { forceLogin?: boolean; flow?: ChatGPTLoginFlow },
): Promise<OAuthCredentials>;
```

`onAuth` publishes `{ url: "https://auth.openai.com/codex/device", deviceCode: user_code,
instructions }` — matching the kimi/nous/copilot contract where `deviceCode` carries the
HUMAN code, never the opaque polling handle.

## Credential boundary

- Never log `device_auth_id`, `authorization_code`, `code_verifier`, or any token.
- Do NOT reuse `safeErrorDescription` from the callback flow: it reflects upstream
  body text. Device errors carry status only.
- Bound the success payload; reject non-string `authorization_code`/`code_verifier`.

## Tests (red-then-green)

`tests/chatgpt-device-auth.test.ts`, stubbing `globalThis.fetch` by URL in the
established style of `tests/oauth-device-code-contract.test.ts:16-63`:

1. requests a user code and surfaces the fixed verification URL + human code
2. treats only 403/404 as pending and honors the returned interval
3. exchanges the server-issued `authorization_code`/`code_verifier` at the device callback URI
4. rejects a malformed success payload without reflecting the body
5. aborts promptly on signal
6. surfaces `accountId`/`email` from a realistic device-token `id_token`, because Codex
   pool admission rejects a credential with no account id (`src/codex/auth-api.ts:2221`).
   Wire success alone is not proof the credential is usable.

Focused command: `bun test tests/chatgpt-device-auth.test.ts tests/oauth-device-code-contract.test.ts tests/chatgpt-oauth.test.ts`

## Security review gate

`src/oauth/` is a restricted authentication surface
(`.github/scripts/pr-sponsored-surface.cjs:24`); `MAINTAINERS.md:60` requires explicit
security review. The PR description states this; it does not merge as routine work.
