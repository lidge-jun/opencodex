# DeepSeek Harness Account Provider

`dsh-account` reuses the DeepSeek account signed in to DeepSeek Harness (DSH) Desktop. It is an OAuth-kind provider with its own credential domain; it shares no key, route or fallback with the API-key `deepseek` provider.

## Import

`src/oauth/dsh.ts` reads `$DSH_HOME/.credentials.yaml` (default `~/.dsh/.credentials.yaml`) only inside `loginDshAccount`, which runs on `ocx login dsh-account` or the dashboard's **Log in** action for the provider. Nothing else reads the file, and nothing in opencodex writes, deletes or changes the permissions of it. The `deepseek-account-platform/default` grant record is validated against `https://platform.deepseek.com/auth-api/v0/users/current` with manual redirects before anything is stored.

Only a successful business response with a nonempty authoritative account ID imports. A missing ID fails closed; email, phone and display name never supply a slot identity, so two DSH accounts sharing an email land in different slots and reauthentication uses the shared account-ID comparison in `src/oauth/index.ts`. Parser and transport failures surface fixed error codes instead of credential or profile fragments.
The profile body is consumed under a fixed 64 KiB decoded-byte ceiling (`DSH_PROFILE_MAX_BYTES`) with the same bounded-read helper the quota path uses: a Content-Length above the cap is rejected without reading, and cancellation is requested on the streamed body once it exceeds the cap, so a hostile or broken upstream cannot turn an import validation into unbounded memory work. Malformed UTF-8 in the body fails validation instead of letting a replacement character alter the authoritative account ID.

The imported copy lives in the opencodex credential store. Removing the account deletes only that copy and never signs DSH Desktop out.

## Refresh and 401

DSH grants have no rotation endpoint. `defaultRefreshPolicy` is `disabled`, and `refreshDshAccountToken` never re-reads the DSH file: it throws a terminal "revoked" error. An upstream 401 on the replay path therefore marks the account `needsReauth`; the user re-imports explicitly.

## Destinations

`src/adapters/dsh-account.ts` sends inference only to `https://api.deepseek.com/anthropic/v1/messages`, resolved by `src/providers/dsh-account-destination.ts`. A configured `baseUrl` on another scheme, host or path fails the request before any send.

Every helper that resolves the token does so by the provider name `dsh-account`, so the row itself is pinned: `credentialPinnedProviderConfigError` in `src/config/provider-validation.ts` rejects, at config load and on management writes, a `dsh-account` row whose adapter is not `dsh-account` or whose `baseUrl` leaves that endpoint. Anthropic sidecar helper selection in `src/sidecar/auth.ts` skips the row by name as well, and Compatibility Lab probes refuse it before resolving a token, because the generic probe transport would use another endpoint and auth scheme. Configured headers cannot set `x-dsh-auth-token`, `anthropic-version`, `authorization`, `x-api-key` or `host`; the adapter strips API-key and Claude Code headers and sets the account token last. `src/types/wire.ts` pins every `dsh-account` model to this adapter regardless of `baseUrl` or the row's own `adapter`, so config load and management writes reject a `modelAdapters` override and wire resolution cannot hand the token to a generic adapter that would send it as a Bearer key. The shared executor's manual redirect policy keeps the token from following a redirect. The catalog is static (`liveModels: false`), and `src/oauth/model-discovery-auth.ts` refuses to resolve the DSH token for any model-discovery path, so a row edited to a discovery-capable adapter such as `cursor` still sends nothing. Local plugin upstream rewriters see every provider send, credentials included, by design; that trust covers this provider like any other. `x-dsh-auth-token` is in the redaction key and header-label lists in `src/lib/redact.ts`.

## Quota

`src/providers/quota/dsh-account.ts` probes `https://platform.deepseek.com/api/v0/users/get_user_summary` with manual redirects. A 401 is a terminal quota failure that also marks the probed credential generation `needsReauth` (a re-import that landed meanwhile stays usable), and a `needsReauth` DSH row is not probed at all, since its grant cannot refresh. A successful business response with summary data returns authoritative empty quota: the platform reports wallet amounts with no capacity, so no percentage window is derived from them.
