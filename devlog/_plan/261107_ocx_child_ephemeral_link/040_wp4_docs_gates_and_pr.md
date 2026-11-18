# `wp4` — Source-of-Truth Documentation, Full Verification Matrix, & PR Publication

> Continuity handoff (`LOOP-CONTINUITY-01` from `wp3` D at `a49f471b98`): `wp3` completed Home discovery, detached `ocx-child` enrollment preflight, `package.json` scripts, and the compiled-binary E2E suite (`104 pass, 0 fail`). Revalidated `040_wp4_docs_gates_and_pr.md` against `a49f471b98`: all referenced repository paths are tracked in git and `INV-LINK-CHILD-01` is present in `tests/clients/link-ocx-child-conformance.test.ts:1`. Architect consultation: covered by `ARCH-07` (`ALIGNED` on `01a1b18b-a2f3-7b53-971a-9b2c9cccecf7`, `000_roadmap.md` §3.1).

- **Phase ID**: `wp4` (depends on `wp3`; satisfies `c-5`)
- **Header dependencies**:
  - References implemented paths `native/ocx-child/Cargo.toml`, `native/ocx-child/src/lib.rs`, `src/link/ephemeral-child.ts`, `src/link/ssh-argv.ts`, `src/link/remote-windows.ts`, `src/server/management/link-enrollment.ts`, `tests/fixtures/link/ocx-child-conformance.json`, `tests/clients/link-ocx-child-conformance.test.ts`, and `tests/clients/link-ocx-child-e2e.test.ts`.
- **Scope**:
  - **IN**: `structure/manifest.json` (MODIFY), `structure/remote-link.md` (MODIFY), `structure/overview.md` (MODIFY), `structure/INDEX.md` (REGENERATE via `bun run structure:index`), `docs-site/src/content/docs/guides/remote-link.md` (MODIFY), `docs-site/src/content/docs/reference/cli/lifecycle.md` (MODIFY), `devlog/_plan/261107_ocx_child_ephemeral_link/STATUS.md` (NEW/UPDATE), git push + GitHub PR targeting `dev` (unmerged).
  - **OUT**: Merging the PR (`authority.merge = false`), force-pushing, manual `lane=all` CI dispatch.

## 1. Exact File Changes

### 1.1 MODIFY `structure/manifest.json`, `structure/remote-link.md`, `structure/overview.md`, & Regenerate `structure/INDEX.md`

- In `structure/manifest.json` (`remote-link.md` entry): add `"native/ocx-child/"` and `"src/server/management/link-enrollment.ts"` to `documents`.
- In `structure/remote-link.md` (185/600 lines): add present-tense contract section `## Ephemeral Rust Child (ocx-child)` naming `native/ocx-child/Cargo.toml`, `native/ocx-child/src/lib.rs`, `src/link/ephemeral-child.ts`, `src/server/management/link-enrollment.ts`, `tests/fixtures/link/ocx-child-conformance.json`, `tests/clients/link-ocx-child-conformance.test.ts`, and `tests/clients/link-ocx-child-e2e.test.ts` (all staged in git before running `bun run structure:check`).
- In `structure/overview.md` (319/600 lines): register bound invariant `INV-LINK-CHILD-01` with `Enforced by \`tests/clients/link-ocx-child-conformance.test.ts\`` and include `// INV-LINK-CHILD-01` in `tests/clients/link-ocx-child-conformance.test.ts`.
- Run `bun run structure:index` and verify `bun run structure:check` exits `0`.

### 1.2 MODIFY `docs-site/src/content/docs/guides/remote-link.md` & `reference/cli/lifecycle.md`

- Document lightweight ephemeral Child hosts (`ocx-child`), candidate discovery fallback order, clean detached enrollment, `ocx sync` fan-out parity, and 100% offline `ocx-child detach` / `disconnect` with zero background daemon.
- Validate `cd docs-site && bun install --frozen-lockfile && bun run build` exits `0`.

### 1.3 Full Verification Matrix, Push, & PR Publication

1. Run fresh verification suite (serializing heavy Bun runs with `/usr/bin/lockf -k /tmp/ocx-heavy-test.lock`):
   - `cargo fmt --manifest-path native/ocx-child/Cargo.toml --check`
   - `cargo clippy --locked --manifest-path native/ocx-child/Cargo.toml --all-targets -- -D warnings`
   - `cargo test --locked --manifest-path native/ocx-child/Cargo.toml`
   - `cargo build --release --locked --manifest-path native/ocx-child/Cargo.toml` (record exact byte size)
   - `bun run typecheck`
   - `bun run structure:check`
   - `bun run skill:surface:check`
   - `bun run privacy:scan`
   - Focused Bun suites + `bun run test:changed`
   - `cd docs-site && bun install --frozen-lockfile && bun run build`
2. Push `feat/ocx-child-ephemeral-link` to `origin`.
3. Write PR body to a `mktemp` file filling every section of `.github/PULL_REQUEST_TEMPLATE.md` (`## Summary`, `## Security Review Summary`, `## Verification`, `## Checklist`) and open PR targeting `dev` via `gh pr create --base dev --head feat/ocx-child-ephemeral-link --title ... --body-file ...`.
4. Link PR immediately via `goat_call { path: "pull_request.link", args: { url } }`.
5. Inspect exact-head checks; if pending/running, arm `goat_call { path: "pull_request.watch", args: { url } }` and yield cleanly without sleep-polling; once green, run `cxc loop pr-record --session 01a1b16f-bd9a-7a92-b78e-0ed532a2a346 --pr <url>`, call `goat_call { path: "pull_request.unwatch", args: { url } }`, and leave PR unmerged.

## 2. Conditional-Path Activation Scenarios (`C-ACTIVATION-GROUNDING-01`)

1. **`structure:check` git-index verification**: Stage all new files before `bun run structure:check` and verify `INV-LINK-CHILD-01` binding passes.
2. **Privacy scan on push range**: Run `bun run privacy:scan` across all committed files and verify zero findings.

## 3. Phase Verifiers

- All 10 commands in Section 1.3 exit `0`.
- Exact-head GitHub PR checks succeed and `cxc loop pr-record` succeeds.
