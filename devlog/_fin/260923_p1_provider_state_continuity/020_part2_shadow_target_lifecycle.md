# 020: Part 2, shadow-call target lifecycle

## Diff plan

- `src/server/management/shadow-call-validation.ts`: add
  `shadowInterceptProviderDependency(config, providerName)`, returning
  `{ model, enabled }` when `config.shadowCallIntercept.model` resolves to that provider, else
  `null`. Combo and routing-profile selectors return `null`: their pickers already skip a disabled
  or missing member, and deleting a provider that a combo uses is refused today. A
  `provider/model` or `alias/model` prefix naming the provider counts. Otherwise the target is
  resolved with `routeModel` and the resolved provider name is compared. The dependency is computed
  before the mutation, while the provider still resolves.
- `provider-routes.ts`: PATCH with `disabled: true` and DELETE add
  `dependentShadowIntercept` to their success response when a dependency exists. Neither refuses:
  the operator's choice stands, and the report tells them what it affects.
- New `src/server/responses/shadow-target-availability.ts`:
  `shadowTargetUnavailableReason(config, model, route | error)` classifies a disabled provider,
  an unknown combo, and a slash-qualified target whose route reason is the terminal
  `default-provider` fallback (its prefix names no configured provider or alias). A bare target that
  resolves through the default provider stays valid; one existing test depends on that.
  `interceptTargetUnavailableResponse(model, reason)` returns `409` with
  `{ error: { type: "invalid_request_error", code: "intercept_target_unavailable", message } }`.
  The message names the target and says to pick another target or re-enable the provider. The
  request log records the code. A server-log warning is printed once per target and reason.
- `request-prepare.ts` late intercept site: resolve the target inside its own try. Admission,
  combo-exhaustion and policy errors keep their current handling; any other target failure, and
  the default-fallback case, return the new response before any upstream attempt. The early combo
  site already requires the combo to exist; a deleted canonical `combo/<id>` reaches the late site
  and is classified there.
- `shadowCallTargetError` (PUT `/api/shadow-call-settings`) rejects the same default-fallback case,
  so the dashboard cannot save a dangling target.
- GUI: `gui/src/pages/use-providers-crud.ts` reads `dependentShadowIntercept` from the disable
  and delete responses and shows a warning notice. It adds one `prov.*` key, translated in every
  locale catalog.

## Tests

New `tests/responses/shadow-intercept-target-lifecycle.test.ts`:

- disable: the PATCH response reports the dependency; the next intercepted helper call returns
  409 `intercept_target_unavailable` with no fetch.
- delete: the DELETE response reports the dependency; the next helper call returns the same
  error and is not sent to the default provider.
- re-enable: PATCH `disabled: false` has no report, and the next helper call is intercepted to
  the target again.
- a disabled provider behind a combo target still fails over inside the combo.
- a bare target resolving through the default provider is still intercepted.

## Docs

`docs-site/src/content/docs/reference/configuration/server.md` (shadow-call section) and its
seven translations describe the report and the error. `structure/gui-and-management-api.md`
records the response field.
