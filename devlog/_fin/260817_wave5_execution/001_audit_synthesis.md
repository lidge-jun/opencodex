# A-phase synthesis — round 1 (VERDICT: FAIL, 9 blockers)

An independent reviewer audited `000`-`090` against the tree at `1208bd25c`
and live GitHub state. Verdict FAIL. Every blocker was re-verified by the main
agent before disposition; all nine are accepted.

## Accepted blockers and their amendments

| # | Blocker | Disposition |
|---|---------|-------------|
| 1 | WP1's 404 retry has no host: AI Studio installs no `fetchResponse` (`google.ts:384`), so the adapter never sees a `Response`; the fetch is core-owned (`core.ts:3586`) | **Folded** — retry dropped entirely |
| 2 | The retry is only safe in the pre-stream `recovery:` loop (`core.ts:3696`); the terminal-guard continuation (`core.ts:3960`) refetches mid-stream and would splice two upstream turns into one client stream | **Folded** — dropped; discovery replaces it |
| 3 | Memo key `(provider, model)` is too coarse and could silently override an explicit operator `false` | **Folded** — identity-keyed, and config always wins |
| 4 | #1739 is mis-scoped: real head `e1c7ec85e`, state CHANGES_REQUESTED/BLOCKED, and its diff also changes `messagesToGeminiFormat`'s identity argument — the subject of the open review finding | **Folded** — `010` rewritten with the real head and the identity change in the file map |
| 5 | WP2 is not implementable for 2 of 3 files: no effects recorder in `dsh-writer-lock.test.ts` or `native-main-claim.test.ts`, both already carry #1881's guards, and #1899 is CONFLICTING/DIRTY | **Folded** — WP2 narrowed to one file; #1899 reclassified |
| 6 | WP3's sentinel already exists (`app-server-processes.ts:372/377/392`) and `unknown` already exists (line 574); the plan described shipped work | **Folded** — WP3 narrowed to the one real gap |
| 7 | WP4's durability fix targets `google-antigravity-replay.ts`, which never calls the remember API; the seam is `thought-signature-replay.ts:190` and already returns `durable` | **Folded** — retargeted, with a caller-discovery step |
| 8 | WP4's key change silently invalidates the persisted store (`version: 2` at line 143 is keyed by `keyFor` output) | **Folded** — explicit version bump + migration decision |
| 9 | Wave 5C has no rebase plan for `src/adapters/cursor/live-transport.ts`, which four PRs modify | **Folded** — rebase-and-recheck step added |

## Accepted medium findings

- 5B's ordering rationale was false: #1904 already bundles #1892's characterization
  tests verbatim (identical blob). Order kept, rationale corrected, rebase noted.
- 5D should run `#1891 -> #1897 -> #1889`; the original order put the only
  red-CI PR first and held the train hostage to it.
- `080` had two state facts inverted: **#1836 is already CLOSED** and
  **#1906 is OPEN (reopened)** — both verified via `gh`.
- `git merge-base --is-ancestor` cannot verify merge *order*; once both are on
  `dev` each is an ancestor of the tip. Use `git rev-list --topo-order --first-parent`.
- `bun run test` already runs `bun test --isolate` (`scripts/test.ts:144`), so
  `090` presented one command as two.

## The finding that changes the campaign shape

Blocker 2 is the important one. The proposed 404-triggered retry was the only
*new* production mechanism in Wave 5A, and it cannot be built where the plan put
it without either (a) touching the shared core recovery loop — which `AGENTS.md`
gates behind the full suite — or (b) risking a mid-stream splice.

The alternative is strictly better: the repo **already** lists models per
account (`src/oauth/index.ts:811`, `/v1beta/models?pageSize=1000`). Reading what
the account actually advertises beats inferring from a 404, needs no request
replay, and cannot distort the attempt log. The retry is dropped.

## Verified-correct plan claims (kept unchanged)

- The #1894 separation finding in `000` is confirmed real; the external audit's
  "split the tables" remedy is confirmed a no-op.
- WP4's key-completeness finding is confirmed exactly right: `keyFor` uses 5
  fields where the sibling `reasoning-replay-cache.ts:65` uses 7.
- WP3's two review blockers are confirmed live on #1876's head.
