## Context

Canonical registry entries seed provider configuration, expose API-key setup, and can enrich a
same-named saved provider at route time. The available evidence does not authorize an Apertis
canonical integration, so retaining an adapter, base URL, models endpoint, or pricing category is
unsafe. The repository already has a directory isolation boundary for reference entries.

## Goals / Non-Goals

**Goals:**

- Keep Apertis discoverable only as an explicitly unverified reference row.
- Guarantee that the row cannot create a preset, validate a key, discover models, or select an
  upstream destination.
- Keep a manually configured `apertis` provider fully editable and routed to its own settings.

**Non-Goals:**

- Verify Apertis documentation, prices, entitlement terms, API compatibility, or routing/resale
  authorization.
- Add an Apertis icon, GUI preset, key validator, model list, endpoint, or user setup guide.

## Decisions

- Add a dedicated `reference-only` access group instead of assigning an existing free/credit
  category. This avoids an unsupported claim that the service has a free entitlement.
- Use the free-directory generator's default reference shape: empty base URL, unsupported
  discovery, `liveModels: false`, `verification: "unverified"`, and no verification date. This
  keeps the entry structurally inert without duplicating an integration definition.
- Do not add an Apertis entry to the canonical registry or GUI catalog-name map. Registry absence
  preserves a same-named custom provider's adapter and destination.
- Invoke the ESLint package through `bun --bun` in the GUI scripts. The existing configuration
  imports local `.ts` modules, which direct Node execution rejects before linting; Bun preserves
  ESLint's package resolution while loading those modules.

## Risks / Trade-offs

- [The `free-directory` filename can be read too broadly] → the distinct `reference-only` group
  and no-entitlement test make the classification explicit.
- [A future maintainer may promote the row without new evidence] → promotion requires a separate
  change with routing/resale authorization and a canonical integration test suite.
- [Users cannot one-click configure Apertis] → this is intentional until the required evidence is
  available; manual custom-provider configuration remains unchanged.
- [The lint command could be run by a Node-only launcher] → the documented package scripts now
  force Bun, while direct external Node invocations remain outside this repository contract.
