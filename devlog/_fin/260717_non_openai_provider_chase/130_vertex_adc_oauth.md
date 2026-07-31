# WP13 — Vertex ADC/OAuth productization

## Goal and dependency

Make the existing authorized-user/service-account ADC path first-class in CLI and GUI. Do not duplicate token exchange or embed a new Google OAuth client by default.

## Diff map

| Action | Path | Before | After |
|---|---|---|---|
| MODIFY | `src/providers/registry.ts` | `google-vertex` is key-auth in presets although adapter supports key or ADC | expose an explicit credential mode/preset hint for API key vs ADC, while keeping one provider id |
| MODIFY | `src/providers/derive.ts` | preset DTO cannot describe external ADC | propagate credential-mode and required project/location fields |
| MODIFY | `src/cli/provider.ts` | key preset requires an API key | allow `google-vertex --auth-mode adc --project ... --location ...` after read-only ADC diagnostics |
| MODIFY | `src/server/management-api.ts` | provider creation has no ADC status contract | add a redacted readiness endpoint or preset validation result: source type/path-presence only, never credential contents |
| MODIFY | `gui/src/components/AddProviderModal.tsx`, `gui/src/provider-payload.ts`, `gui/src/i18n/en.ts`, `gui/src/i18n/ko.ts`, `gui/src/i18n/zh.ts`, `gui/src/i18n/de.ts` | UI asks for API key | mode switch for API key vs ADC plus project/location and safe setup instructions |
| MODIFY | `src/lib/gcp-adc.ts` | token resolver errors are safe but diagnostics are internal | export a non-secret ADC source/readiness classifier without reading tokens into DTOs |
| MODIFY | `tests/gcp-adc.test.ts`, `tests/server-auth.test.ts`, `tests/cli-provider.test.ts` | token exchange tested, setup UX not | cover authorized-user/service-account/metadata readiness, missing files, source changes, redaction, and provider payloads |

## Security boundary

- Reuse `gcloud auth application-default login` and existing ADC files. Do not copy refresh tokens into `~/.opencodex/config.json`.
- Readiness output may show source kind and a normalized path label, but never client secret, refresh token, service-account email unless explicitly approved, access token, or raw OAuth body.
- Browser-based built-in OAuth is `NOOP` unless P proves ADC cannot meet the user journey and identifies an approved Google OAuth client-registration/redirect ownership model.
- Existing API-key mode remains supported.

## Activation scenarios

- Authorized-user ADC creates a Vertex provider without an API key and refreshes through the existing single-flight cache.
- Service-account ADC and metadata-server credentials still work unchanged.
- Missing/invalid ADC fails before saving a misleading provider, with a setup command and no secret leakage.
- Switching credential source invalidates stale readiness/token cache exactly as current tests require.

## Verification

```bash
bun test tests/gcp-adc.test.ts tests/server-auth.test.ts tests/cli-provider.test.ts tests/google-vertex-http.test.ts tests/google-vertex-stream.test.ts
bun run typecheck
bun run build:gui
```

## Terminal outcomes

- `DONE`: ADC setup is first-class and all token-source/redaction/live Vertex probes pass.
- `NOOP`: CLI/GUI already expose the complete ADC path by the time this phase starts.
- `NEEDS_HUMAN`: project, IAM role, billing, or ADC login is missing.
- `UNSAFE`: implementation would embed unapproved OAuth credentials or duplicate refresh tokens into OCX config.
