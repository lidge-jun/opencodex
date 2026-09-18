# Measured: the Muse Code device grant, and what our tree lacks

Research document. No diffs here; `010`-`040` own those.

Two sources are used and they are kept apart on purpose. **Source R** is a working
second-party implementation (`oh-my-pi`), read at
`/Users/jun/.codex/worktrees/acb9/opencodex/.tmp/ref/oh-my-pi`. **Source M** is this
repository's own 2026-09-03 measurement,
`devlog/_fin/260903_muse_spark_plan_oauth/003_credential_and_quota_measurements.md`,
taken against a real account on this machine. Neither is Meta documentation, and nothing
below was re-verified with a live call during this unit.

## A. The grant, from Source R

`packages/catalog/src/compat/rules/auth/muse-code.kdl`:

```kdl
auth "muse-code" {
	name "Muse Code (Subscription)"
	expiry "jwt-or-never"
	login "device-code" {
		client-id "1031625952748946"
		device url="https://auth.meta.com/oidc/device/authorization/" {
			headers { Accept "application/json"; "x-api-version" "1.0.0" }
		}
		token url="https://auth.meta.com/oidc/device/token/" {
			headers { Accept "application/json"; "x-api-version" "1.0.0" }
		}
		response user-code="user_code" device-code="device_code" verification-uri="verification_uri" verification-uri-complete="verification_uri_complete" interval="interval" expires-in="expires_in"
		instructions "Enter code: {user_code}"
		credential {
			// Model requests use the minted API key, not the account token. Meta's
			// device response omits expiry and rejects refresh_token grants.
			expires "never"
		}
		after-exchange hook="muse-code-key"
	}
	refresh "none"
}
```

So: standard RFC 8628 field names, both endpoints carry `x-api-version: 1.0.0`, the device
response omits expiry, and **refresh is not available** — the reference states Meta rejects
`refresh_token` grants. That matches Source M, which found the account token useless
against the Model API anyway, so there is nothing worth refreshing.

Source M corroborates the mechanism independently: the CLI's own pointer file records
`"obtained_via": "device_code"` (`003` §A), and an observed `muse login` printed
`https://auth.meta.com/oauth/device/?code=<code>` (`002` §1 of that unit). The verification
host is the same; the `oidc` paths above are the machine endpoints behind it.

## B. The key mint, from Source R

`packages/ai/src/registry/oauth/muse-code.ts` — `POST https://api.meta.ai/muse-code/key`,
headers `Accept`, `Authorization: Bearer <account token>`, `Content-Type`,
`x-api-version: 1.0.0`, body `{"onboard":true}` during an interactive login and `{}`
otherwise, `redirect: "error"`, 20s timeout.

Response fields it parses, all optional:

```
api_key, require_payment, require_payment_action_url, action_url,
user_email, user_id, is_subs_active, subs_tier_id, subs_tier_name,
subs_usage: { window?: W, weekly?: W }   where W = { used_percent?, resets_at?, window_duration_mins? }
```

Its error branches, in order: `is_subs_active === false` -> 403 "subscription is inactive";
no `api_key` plus `require_payment` or an action URL -> an entitlement error carrying the
URL; no `api_key` otherwise -> "missing api_key"; no `user_id` and no `user_email` ->
"missing a stable account identity". Identity is `user_id ?? lowercased user_email`.

Its remint suppression is a comment worth quoting, because it is the one place the
reference is ahead of a naive implementation:

> Reuse an already-minted subscription key instead of re-minting on every token refresh.
> The key endpoint is aggressively rate-limited (429s), and Meta returns the same api_key
> for the account, so a refresh that already carries one must not burn another key call.

## C. The quota side-channel, from Source R

`packages/ai/src/usage/muse-code.ts` re-calls the same mint endpoint purely to read
`subs_usage`, with `failureBackoffMs = 5 * 60_000`, rethrowing only 401/403 and swallowing
everything else as `null`. It deletes `api_key` from the payload before retaining it as
`raw`. `window.window_duration_mins` becomes a rolling window id like `300m`; `weekly`
becomes `1w`.

The field names are identical to the ones our SSE parser already handles
(`src/providers/muse-subscription-usage.ts:57-59`), which is the useful finding: the mint
response and the in-stream frame carry the same measurement, so one parser shape serves
both.

## D. What our tree lacks, with line evidence

| Gap | Evidence | Consequence |
|---|---|---|
| No device grant at all | `src/oauth/meta-muse.ts:1-30` documents the module as a credential *import*; `src/oauth/index.ts:269-274` registers only `loginMetaMuse` | A host without the Muse CLI must paste a key by hand |
| darwin-only import | `src/oauth/meta-muse.ts` refuses non-darwin before any read and routes to paste | Windows and Linux users have no login, only a paste field |
| `x-api-version` is never sent | `rg "x-api-version" src tests` returns nothing; the closest analogues are `src/adapters/anthropic.ts:1031` and `src/oauth/github-copilot.ts:324` | If Meta starts requiring the header, every Muse request breaks with no local signal |
| No `staticHeaders` on the row | `src/providers/registry.ts:1746-1764` has no such field; the only user is `opencode-free` at `registry.ts:3198-3210` | The seam exists and is unused for this provider |
| Quota is observation-only | `src/providers/quota.ts:1871` `return provider === "meta-muse";` marks it passive; the dispatcher takes the passive branch at `quota.ts:3037` | A dashboard load cannot refresh the bars; only a streaming turn can (`quota.ts:1610-1611`) |
| No probe backoff anywhere | `quota.ts:2171-2172` negative-caches by TTL; `cursor-pool.ts:32` cooldown is routing, not quota | A new mint-based probe would need the first real backoff in this file |
| Device polls burn real time in tests | `tests/oauth/chatgpt-device-auth.test.ts:102-113` asserts `>= 1_900` ms because `sleep` is private in each flow | A new flow copying that shape would slow the suite for every poll branch |

## E. What is still unverified

- No request in this unit was sent to `auth.meta.com` or `api.meta.ai`. Every contract
  above is second-party.
- Whether Meta's device authorization endpoint accepts a PKCE `code_challenge` is unknown.
  RFC 8628 does not use one — there is no redirect to protect — and Source R sends none.
  `002` §D records why this unit does not add one speculatively.
- Whether the account token expires at all. Source R declares `expires "never"` and
  `refresh "none"`; Source M measured a 282-character opaque token and did not test decay.
  `010` therefore treats a mint failure on a stored token as re-login required, not as a
  refreshable condition.
- Whether `subs_usage` is present on every mint response or only on onboarding ones. `030`
  treats absence as "no measurement", never as zero usage.
