# Meaning preservation and request-scoped safety batch

Status: OPEN. Opened against `main` 2.60.0 (`7c625fc9755c9824653ab944190e243091a2c85c`) and the
current `dev` head. This unit covers the first six items of the post-2.60.0 assessment: the two
safety fixes and the four meaning-preservation defects. Scope beyond those six is explicitly out.

## Why these six

The assessment scored meaning preservation lowest of the six axes. The shared failure mode is that
a request arrives carrying an explicit constraint — which tools may be called, how a tool is
declared, an attached document, where an instruction sits in the conversation — and the proxy
returns a normal HTTP success after silently dropping it. A test that only asserts a successful
tool call or a 200 response cannot see any of them.

The governing rule for every item in this unit:

> On a supported path, preserve it. On an unsupported path, refuse it or apply the conversion
> policy the operator chose. Never drop it quietly and return as if the request was honored.

## Delivery topology

Each lane delivers **one branch with ordered commits and one pull request** against `dev`. No
GitHub native stack and no chain of child pull requests. Where an existing contributor pull
request already covers part of a lane's scope, the lane carries that work into its own branch with
a `Co-authored-by` trailer naming the original author, and the superseded pull request is closed by
the coordinator only after the lane lands. Carrying without the trailer is not acceptable:
`missing_coauthor_credit` in `.github/scripts/pr-carry-attribution.cjs` exists because
`CREDITS.md` already lists 27 landings that lost their author.

## Lanes

### Lane A — meaning preservation on the request path

| Item | Contract to restore |
| --- | --- |
| #5211 | Caller-specified `allowed_tools` and `parallel_tool_calls: false` survive the Chat Completions path from inbound parse to the actual outbound request. |
| #5210 | Tool declaration `strict` and `allowed_callers` reach destinations that support them; an unsupported destination refuses rather than silently widening the declaration. |
| #5212 | Inline document bytes survive the inbound parse into the internal representation and outbound, so a title-only forward is never reported as a success. |
| #5213 | A `developer` message keeps its chronological position. Role conversion to `system` is a separate, explicitly recorded decision with its own acceptance, not a side effect of placement. |

#5237 is a correct narrow fix for the #5213 position problem and is not the whole of role
preservation. Lane A carries it with attribution and keeps position and role as two distinct
acceptance conditions.

### Lane B — request-scoped transport and managed-write safety

| Item | Contract to restore |
| --- | --- |
| #5087 | DNS pinning and transport selection are decided by whether a proxy actually applies to *this request*, not by whether one is configured. Scheme mismatch, `NO_PROXY` and DNS failure must not produce an unintended unpinned direct connection. |
| #5241 | A managed configuration write never follows a terminal symlink to another file, including under `apply`, `refresh`, `disable` and `restore` races. |

Both existing pull requests are authored by the same contributor and are carried with attribution.

## Regression discipline

Behaviour changes in `src/` need focused regressions next to the existing tests for that subsystem.
Before any push, check the union-defect classes `AGENTS.md` records, because exact-head CI cannot
see a defect that exists only in the union of two branches:

- the file-size ratchet only moves downward, so a new case goes in a sibling file registered in
  both `scripts/test-layout/layout.json` and `tests/fixtures/test-layout-expected.json`;
- anything exhaustive over a union — locale catalogs, `satisfies Record<Union, ...>`, hand-written
  rosters, counts in generated documentation — must be derived rather than restated.

The 2.60.0 release was blocked by exactly this class: #5239 tightened Fernet validation while an
older case in another domain directory still minted its fixture the loose way.

## Execution constraints

No local suites, individual tests, typecheck, build, install or live `ocx` execution. Verification
is static source review plus exact-head hosted CI. Branch pushes use `--no-verify`. Only the
coordinator merges and closes issues. Public artifacts stay English and name no other repository or
model.
