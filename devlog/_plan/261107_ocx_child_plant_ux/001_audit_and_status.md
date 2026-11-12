# Audit & Work-Phase Status Ledger (`261107_ocx_child_plant_ux`)

> Reader contract: Durable audit, disclosure, and work-phase status record for `feat/ocx-child-plant-ux` (stacked on PR #8237 `feat/ocx-child-ephemeral-link`).

`wp0` (docs-first roadmap cycle per `LOOP-DOCS-FIRST-01`) audited all five plan documents (`000_roadmap.md` and `010..040`) with zero Critical/High blockers (`VERDICT: PASS`) and folded all four Medium/Low refinements into `010..030` prior to implementation.

## 1. `wp0` Audit Record & Same-Family Disclosure (`REVIEW-DECORRELATE-01`)

- **Model inheritance disclosure**: Per explicit user instruction ("너 상속 으로 해서"), both architect (`01a1b2ed-664f-7180-99b1-fd1091864296`) and independent A-phase reviewer (`01a1b2f8-ffdf-77b0-a854-0141550b121d`) inherited the coordinator's model family (`google-antigravity/gemini-4-argon`); cross-family decorrelation was intentionally not used.
- **Reviewer `01a1b2f8-ffdf-77b0-a854-0141550b121d` verdict**: `VERDICT: PASS` (`blocking_issues: []`).
- **Dispositions of Medium/Low findings**:
  1. `M1` (Accepted & folded into `020`): Update `tests/server/link-enrollment-ephemeral-child.test.ts:192` (and `structure/remote-link.md:191` in `wp4`) from `"child_restart_unsupported"` to `"child_port_busy"` when `before.code === 0` on an ephemeral Child.
  2. `M2` (Accepted & folded into `010`): Prefix all three conflict branches in `native/ocx-child/src/toml_surgeon.rs:399,421,433` (including user-owned `model_catalog_json`) with `ocx-child-conflict:child_external_provider_conflict:`.
  3. `L3` (Accepted & folded into `020`/`030`): Keep `childKind` omitted on `POST /api/link/issue` client-initiated records so existing exact-store assertions stay green, and accept both legacy `{ alias, fingerprint, ocxVersion }` and extended `allowMissing` confirmation responses in `src/cli/link-enrollment.ts`.
  4. `L4` (Accepted & folded into `030`): Leave `src/cli/capabilities-base.ts` untouched so `skills/ocx/references/*` (outside `writeScope`) remains byte-identical and `bun run skill:surface:check` stays green.

## 2. Work-Phase Status Table

| Work Phase | Status | Summary & Verification Receipt |
|---|---|---|
| `wp0` | DONE | Docs-first roadmap (`000_roadmap.md`, `001_audit_and_status.md`, `010..040`) completed, audited (`VERDICT: PASS`), and verified with `privacy:scan` + `structure:check` (`exit 0`); zero production files modified |
| `wp1` | DONE | Rust `native/ocx-child` `--purge` & conflict prefixes + `src/link/` foundations (`9/9` Cargo tests, `51/51` Bun foundation & layout tests) |
| `wp2` | DONE | Home Management API `confirm-host`, `apply` plant/rollback, `status`, and `DELETE --purge` (`90/90` server, projection, and real-binary E2E tests) |
| `wp3` | DONE | CLI (`--plant`, `--purge`) & `#remote` GUI + 11 locales (`82/82` CLI link tests, `3738/3738` GUI tests, `lint:i18n`, `lint`, `build:gui`) |
| `wp4` | IN_PROGRESS | SoT docs (`structure/remote-link.md`, `docs-site/`), `origin/pr-assets` screenshots (`4d57c948b78bc66f2fb06b01cd9eb947766f1a60`), `35729/35729` `test:changed` pass, stacked PR & CI watch |

