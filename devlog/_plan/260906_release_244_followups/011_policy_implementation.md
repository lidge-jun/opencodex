# Maintainer integration implementation

The helper retains its strict approval path by default. Explicit
--maintainer-integration parses independently of positional arguments and requires
the authenticated human actor, the trusted dev roster and live maintain/admin
permission. It retains complete review parsing and maintainer objections. Before
emitting a validation snapshot, it reloads the roster and actor authorization,
rejects roster/actor drift, then checks the final PR head, dev base and author.

The existing regression matrix is preserved. Thirty-one additional scenarios
cover authorized integration, refusal cases, argument order and concurrent state
changes. Passing fixtures also verify the dev-bound roster and repeated identity
queries, so an accidental default-branch lookup cannot satisfy the tests.

MAINTAINERS, AGENTS, the contributing guide and architecture notes now distinguish
maintainer integration from approving one's own work. The dev-only GitHub payload
adds Maintain role 2 alongside Admin role 5, both PR-only. The reviewed applicator
checks fresh before/after state and verifies role names without writing main or
preview. Settings application is recorded separately after hosted verification.

No local test suite, typecheck, build or live provider request was run. The shell
syntax and diff were checked locally; behavioral proof is the exact-head hosted
CI recorded on PR #3739 and in the session's source-bound evidence receipt. The
first broad worker was retired without edits; main implemented the helper and a
fresh bounded worker supplied the regression matrix.

Final C review removed the opt-in copy-paste admin merge recipe. Head matching
does not bind a PR's base at execution time, and another read in the same shell
command would only move that race. The helper now states its snapshot boundary;
the separately authorized integration step must revalidate current actor/base.
Passing fixtures require that no privileged merge command is emitted.
