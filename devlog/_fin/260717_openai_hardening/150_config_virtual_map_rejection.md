# Cycle 150 — Config Disk and Management Virtual Map Rejection

## Objective

Persisted config and management API must reject `virtualModels` on provider objects.
Virtual model maps are registry-only and must never be user-injectable.

## Scope

- `src/config.ts` configSchema `superRefine`: reject `virtualModels` as own property
- `src/server/auth-cors.ts` `FORBIDDEN_PROVIDER_RUNTIME_FIELDS` includes `virtualModels`
- Management POST `/api/providers` rejects body with `virtualModels`
- Disk load falls back to defaults on forged virtual maps

## Activation tests

- `tests/config.test.ts` "disk config rejects forged registry-only virtual model maps"
- `tests/server-auth.test.ts` management rejects runtime metadata (existing test covers `virtualModels`)

## Evidence

- Consolidated implementation and activation evidence is indexed in
  [`190_consolidated_finish_plan.md`](./190_consolidated_finish_plan.md), with the final
  Cycle-B integration and gate receipts in [`050_integration_verification.md`](./050_integration_verification.md).

## Status

`done — verified by consolidated Cycle A/B sweep, see 190 + 050 evidence`
