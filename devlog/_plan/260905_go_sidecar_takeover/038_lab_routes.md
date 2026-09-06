# 038 — Ticket #33: Lab routes migration + differential

Unit: `260905_go_sidecar_takeover`  
Date: 2026-09-06  
Status: implemented  
Ticket: #33  
Decision: [010 — migrate, do not cut](./010_lab_migrate_vs_cut_decision.md)

## Verdict ledger

The audit replaces the old blanket `local-transport` conclusion for literal reads.
`src/cli/lab.ts` does read the local SQLite projection directly, but the Compatibility
Matrix GUI independently fetches `GET /api/lab/*` through
`gui/src/pages/compatibility-matrix-api.ts`. Thus local CLI transport is not a reason
to leave the public browser transport TypeScript-owned. The pre-flip state oracle
remains TypeScript; Go owns transport through a parent capability bridge and does not
port the SQLite projection.

| Route family | Verdict | Reason |
| --- | --- | --- |
| `GET /api/lab/automation`, `/runs` | Go now, strict | Literal routes. Dashboard-facing management transport; parent owns automation files/process state. |
| `GET /api/lab/artifacts`, `/catalog`, `/events`, `/observations`, `/production-signals`, `/public/community`, `/status`, `/subjects`, `/verdicts` | Go now, strict | Literal public reads used by the Compatibility Matrix. Parent bridge returns oracle bytes; no volatile fields are allowed. |
| `GET /api/lab/subjects/{id}`, `/events/{id}`, `/artifacts/{digest}` | Defer | Regex routes cannot be represented by `findGoOwnedManagementRoute`'s exact literal lookup. Their existing local CLI transport remains true, but is not the reason for the deferral. |
| Seven Lab writes, including automation and public evidence verbs | Defer | No CLI verb exists; the bounded `wp7` ownership record in `060_phase_gui_parity.md` remains authoritative. This ticket does not widen write relay scope. |

## Delivery notes

- Registry flips the eleven literal Lab GET rows to `go: { volatileFields: [] }`;
  the three regex reads remain non-Go-owned. `read-surface-ownership.ts` records
  the corresponding Go-now rows, keeping the all-read matrix exact.
- `go/internal/sidecar` serves only those exact routes after verifying the parent
  request capability. It relays to `/__ocx_go_sidecar/lab-read`; the parent
  verifies the child capability and re-enters `handleManagementAPI` with Go
  forwarding disabled. This preserves the dynamic Lab import and the core/Lab
  import boundary while avoiding a second SQLite implementation.
- `tests/go-lab-routes-parity.test.ts` builds with `CGO_ENABLED=0`, enables the
  real Lab activation gate using a routing profile, starts an in-process oracle
  and a sidecar-attached server, and compares status, content type, and raw
  response bytes for all eleven routes. The unseeded projection deliberately
  includes the `503 lab_projection_unavailable` response family.
- `tests/management-route-registry.test.ts` now pins the literal-vs-regex
  judgement, including the strict empty volatile set.

## Follow-up ownership

The next Lab increment owns native Go projection/state and any expansion of the
exact-match route seam to parameterised routes. The existing `wp7` GUI-parity phase
owns Lab writes and CLI verbs.
