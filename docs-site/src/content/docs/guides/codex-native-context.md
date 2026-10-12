---
title: Native context compatibility
description: Eligibility, authenticated trial configuration, and limits of the Codex history and notes relay.
---

OpenCodex already relays native Codex history and notes. This is not a general memory service
for routed providers, and exposing its HTTP endpoints does not establish that a particular
Codex build, account, or model can use them. See [Codex integration](/guides/codex-integration/)
for the relay's ownership, cancellation, and credential boundaries.

## Two independent requirements

Codex must activate the extension, and OpenCodex must identify the caller. Changing the backend
URL solves neither requirement by itself.

The inspected upstream Codex contract requires a model whose native catalog entry advertises
`supports_experimental_context`, an eligible ChatGPT login, and a provider named exactly
`OpenAI` with a base URL ending in `/backend-api/codex`. Its automatic activation rejects
providers using `env_key`, `experimental_bearer_token`, command-backed `auth`, or AWS auth.
The inspected eligibility predicate accepts ChatGPT Plus, Pro, and ProLite; this is not a claim
that every account on those plans has working backend history endpoints.

OpenCodex additionally requires an active **data-plane API key** on both the successful model
request and the subsequent context requests. Default built-in loopback injection does not send
that key, so it can serve models while context calls fail with `context_principal_required`
(403). The authenticated remote provider-table form alone is not a native-context solution
either: its `env_key` and provider name do not satisfy the Codex activation contract above.
Never remove the principal or account-ownership checks to hide either problem.

## Explicit opt-in syntax

OpenCodex accepts both persisted root feature forms that Codex's `FeatureToml` accepts:

```toml
[features]
context_management = true
```

The equivalent table form also works and is the compatible spelling for older OpenCodex
versions that did not yet recognize the boolean form:

```toml
[features.context_management]
experimental_mode = true
```

Use one form, not both. False, absent, and malformed values remain off. The proxy reads its own
Codex home configuration; a CLI-only override or an opt-in present only inside a Codex profile
does not enable its runtime gate. This change does not infer opt-in from model metadata.

## Authenticated native trial profile

This is a **source-checked trial configuration, not a real-account end-to-end certification**.
Back up the Codex configuration and keep a durable task checkpoint before testing. Use a new,
throwaway thread; do not change the provider identity of an existing working thread.

Supply an existing active OpenCodex data-plane key in `OCX_CONTEXT_API_KEY` in the environment
of the Codex process. Do not use a management/admin token or store the key in TOML. A service's
environment is not automatically inherited by a separately launched desktop application.
Keep the normal native Codex ChatGPT login available; the extra header does not replace OAuth.

With the root feature opt-in above, the canonical ChatGPT forward provider configured in
OpenCodex, and a current native model catalog, merge this **additional** provider and profile
into the same Codex config. Adjust the port to the actual local proxy. Leave the root
`model_provider` and existing provider tables unchanged.

```toml
[model_providers.ocx-native-context]
name = "OpenAI"
base_url = "http://127.0.0.1:10100/backend-api/codex"
wire_api = "responses"
requires_openai_auth = true
supports_websockets = false
env_http_headers = { "x-opencodex-api-key" = "OCX_CONTEXT_API_KEY" }

[profiles.ocx-native-context]
model_provider = "ocx-native-context"
model = "gpt-6-astra"
```

Start a new CLI thread with `codex --profile ocx-native-context`. The example uses HTTP/SSE to
keep the initial trial on the model-to-relay ownership path; it does not change the transport
of other profiles or certify WebSocket/mid-turn-steering parity. Use the model only when the
account's native catalog actually advertises its context capability; never force that flag
onto a Devin, Gemini, or other routed row.

The custom provider ID is intentional. Upstream Codex does not generally override built-in
providers from `model_providers.openai`; adding an extra header there can be silently ineffective.
The custom ID preserves the normal provider, while the exact `OpenAI` name satisfies the native
backend predicate. Do not add `env_key` to this profile: `env_http_headers` carries local admission
separately while `Authorization` continues to carry the native ChatGPT login. OpenCodex consumes
the local key; it does not forward that key to ChatGPT.

The root opt-in also affects other eligible native profiles. **During this trial, do not continue
ordinary built-in loopback threads that lack the extra key.** Turn the root feature off and run
`ocx sync` before returning to those threads. This is not an automatic or default integration
change, and this CLI profile is not a claim about desktop profile-selection support.

## Verify before resetting context

First obtain a successful native model response in the new thread. Then verify a note write,
read the same note back, and query that thread's history. Only after those operations succeed
should a disposable test use `new_context` and check that the saved state can be recovered.
Keep the external checkpoint even when the trial succeeds.

- **403 `context_principal_required`:** no valid local data-plane key reached the proxy.
- **409 `context_account_unavailable`:** ownership is missing or inconsistent; do not substitute
  the current active account or retry a write blindly.
- **404:** distinguish the proxy's disabled/unknown-endpoint response from an upstream 404.
  The latter is not proof of an OpenCodex routing defect or an account-wide outage.

A successful model call or `ocx ready` is not proof that notes, history, or state restoration
works. Model routing, account changes, proxy restarts, and upstream endpoint availability remain
separate concerns. No local flag can grant missing backend eligibility, and a failed context
operation must not be reported as a successful reset. Remove the trial tables and unset the
trial key when finished; leave the feature disabled unless using a verified authenticated path.

## Upstream contracts inspected

These links pin the source contract used for the configuration above, not a deployment promise:

- [FeatureToml boolean/table forms](https://github.com/openai/codex/blob/78245b47af2a7aafcabe025828ceecca69db4df1/codex-rs/features/src/lib.rs)
- [Native context eligibility](https://github.com/openai/codex/blob/78245b47af2a7aafcabe025828ceecca69db4df1/codex-rs/core/src/session/token_budget.rs)
- [Provider identity and built-in merge rules](https://github.com/openai/codex/blob/78245b47af2a7aafcabe025828ceecca69db4df1/codex-rs/model-provider-info/src/lib.rs)
- [History/notes use the provider's request headers and authentication](https://github.com/openai/codex/blob/78245b47af2a7aafcabe025828ceecca69db4df1/codex-rs/ext/history-notes/src/backend.rs)
