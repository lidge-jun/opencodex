# 260717 Kimi K3 release v2.7.23 — plan MOC

## Objective

Ship the Kimi K3 provider catalog update, including distinct local 256K and 1M
context selectors, then promote the validated history through `dev`, `preview`,
and `main` and publish npm `latest` as `2.7.23`.

## Verified starting state

- Local `dev` is at `187a4ac7` with the initial K3 registry commit and is one
  commit ahead of `origin/dev` (`af180058`).
- The working tree adds the entitlement-aware aliases: `kimi/k3` advertises
  262,144 tokens and `kimi/k3[1m]` advertises 1,048,576 tokens; both send the
  official upstream model id `k3`.
- `origin/main` is `b3731377` (`release: v2.7.22`), while `origin/preview` is
  `88e96e71`; those public branches diverge from the new local K3 work.
- npm `latest` is `2.7.22`; `@bitkyc08/opencodex@2.7.23` and remote tag
  `v2.7.23` are unused. GitHub's release lookup was temporarily unavailable,
  so the release helper must repeat all three freshness checks before mutation.
- A live request reached Kimi's coding endpoint but returned membership
  verification `402`; the user explicitly chose to skip further free-tier login
  probing and proceed with release.

## Work-phase map

| WP | Deliverable |
| --- | --- |
| WP1 | Audit the K3 alias contract and the non-destructive promotion/release path. |
| WP2 | Commit K3 tier aliases, merge the current stable release history into `dev`, and run isolated local gates. |
| WP3 | Push and promote `dev` to `preview` and `main`, preserving all branch histories. |
| WP4 | Publish `2.7.23` from `main`, realign all three branches to the release SHA, and verify public artifacts plus clean install. |

## Constraints

- No force-push, rebasing of published branches, or public tag rewrites.
- Do not retry or alter the user's Kimi authentication state.
- Run tests with isolated `OPENCODEX_HOME` and `CODEX_HOME` so local credentials
  and the running proxy are not mutated.
- The exact release SHA must pass Cross-platform CI before workflow dispatch.
- Completion requires npm registry, npm `latest`, Git tag, GitHub Release,
  branch alignment, and a fresh global-install `ocx help` smoke.

## Scope manifest

### Product changes

- `src/providers/registry.ts`
- `tests/provider-registry-parity.test.ts`
- `tests/reasoning-effort.test.ts`

### Release record

- `devlog/_plan/260717_kimi_k3_release/000_plan.md`
- `devlog/_plan/260717_kimi_k3_release/010_release_evidence.md`
- `package.json` via `scripts/release.ts`

## Terminal outcomes

- `DONE`: v2.7.23 is published and every required proof is green.
- `BLOCKED`: three distinct recovery attempts cannot restore a required external
  service or branch update.
- `UNSAFE`: completing the release would require rewriting published history.
- `NEEDS_HUMAN`: npm, tag, or GitHub metadata is partially consumed in a way
  that cannot be safely bypassed with the next unused version.
